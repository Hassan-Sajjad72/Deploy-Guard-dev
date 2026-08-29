import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { AuthService, SESSION_COOKIE_NAME } from "../src/auth/auth.service";
import { GithubActionsDeploymentService } from "../src/projects/github-actions-deployment.service";
import { PipelineRunStatus, ProjectPipelineRun } from "../src/projects/project-pipeline-run.entity";

async function run() {
  const projectId = process.env.SAFE_RETRY_PROJECT_ID || "";
  const sourceOperationId = process.env.SAFE_RETRY_SOURCE_OPERATION_ID || "";
  const port = Number(process.env.SAFE_RETRY_HTTP_PORT || "5011");
  if (!projectId || !sourceOperationId) throw new Error("Safe retry verification requires explicit project and source-operation IDs.");

  const app = await NestFactory.create(AppModule, { logger: false });
  const deployment = app.get(GithubActionsDeploymentService) as any;
  const runs = deployment.runs;
  const projects = deployment.projects;
  const source = await runs.findOne({ where: { id: sourceOperationId, projectId } }) as ProjectPipelineRun | null;
  const project = await projects.findOne({ where: { id: projectId } });
  if (!source || !project || source.status !== PipelineRunStatus.FAILED) throw new Error("The explicit source operation is not the current failed retry source.");
  const latest = await deployment.latestRun(projectId, runs);
  if (latest?.id !== source.id) throw new Error("A newer operation already exists; safe retry verification stopped.");

  const previousInputs = source.metadata?.immutableDispatchInputs as Record<string, string> | undefined;
  const previousConfiguration = previousInputs?.environment_references_base64
    ? JSON.parse(Buffer.from(previousInputs.environment_references_base64, "base64").toString("utf8")) as { secretReferences?: Record<string, string> }
    : null;

  // Preserve the real controller, admission, database transaction, snapshot,
  // and response path. Replace only mutation boundaries after admission.
  deployment.oidcTrust.ensureRepositoryAuthorized = async () => undefined;
  deployment.runtimeSecrets.materialize = async (input: { secretValues: Record<string, string> }) => {
    const names = Object.keys(input.secretValues).sort();
    if (!names.length) return null;
    const references = previousConfiguration?.secretReferences || {};
    const valueFromByName = Object.fromEntries(names.map((name) => [name, references[name]]));
    if (Object.values(valueFromByName).some((value) => typeof value !== "string" || !value)) {
      throw new Error("Safe retry verification could not reuse the existing secret references.");
    }
    return { secretArn: "safe-local-verification", secretNames: names, valueFromByName, versionToken: "safe-local-verification" };
  };
  deployment.scheduleOperation = async (repository: typeof runs, operation: ProjectPipelineRun) => {
    operation.status = PipelineRunStatus.FAILED;
    operation.currentStage = "workflow_dispatch";
    operation.githubWorkflowStatus = "verification_suppressed";
    operation.failedAt = new Date();
    operation.errorMessage = "Local retry verification stopped before GitHub Actions dispatch.";
    operation.metadata = {
      ...(operation.metadata || {}),
      conclusion: "failure",
      failedStage: "workflow_dispatch",
      dispatchState: "local_verification_suppressed",
      safeLog: "The retry was persisted and returned through HTTP; GitHub Actions dispatch was intentionally suppressed.",
    };
    await repository.save(operation);
  };

  await app.listen(port, "127.0.0.1");
  const auth = app.get(AuthService);
  const token = auth.createSessionToken({ id: project.ownerUserId } as never);
  const headers = { Cookie: `${SESSION_COOKIE_NAME}=${token}`, "X-DeployGuard-Route": `/projects/${projectId}/pipeline` };
  const response = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/deploy/retry`, { method: "POST", headers });
  const body = await response.json() as any;
  const historyResponse = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/deploy/history`, { headers, cache: "no-store" });
  const history = await historyResponse.json() as any;
  const persisted = await runs.findOne({ where: { id: body?.deployment?.operation?.id, projectId } });
  const sourceAfter = await runs.findOne({ where: { id: sourceOperationId, projectId } });
  console.log(JSON.stringify({
    httpStatus: response.status,
    response: body,
    historyStatus: historyResponse.status,
    historyLatest: history?.operations?.[0] || null,
    persisted: persisted ? { id: persisted.id, attempt: persisted.metadata?.attempt, status: persisted.status, retryOfOperationId: persisted.metadata?.retryOfOperationId } : null,
    source: sourceAfter ? { id: sourceAfter.id, attempt: sourceAfter.metadata?.attempt, status: sourceAfter.status } : null,
  }, null, 2));
  await app.close();
  if (!response.ok || !persisted || persisted.metadata?.retryOfOperationId !== sourceOperationId || sourceAfter?.status !== PipelineRunStatus.FAILED) process.exitCode = 1;
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
