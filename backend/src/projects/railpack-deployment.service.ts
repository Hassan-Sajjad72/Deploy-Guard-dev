import { ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash, randomUUID } from "crypto";
import { In, Repository } from "typeorm";
import { User } from "../users/user.entity";
import { canonicalEnvironmentName } from "./canonical-environment";
import { ProjectDatabaseTier, DatabaseTierProvider } from "./project-database-tier.entity";
import { ProjectEnvironmentCryptoService } from "./project-environment-crypto.service";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { GithubAppService } from "./github-app.service";
import { GithubActionsOidcTrustService } from "./github-actions-oidc-trust.service";
import { GithubActionsDispatchError, GithubActionsService } from "./pipeline/github-actions.service";
import { ProjectPipelineRun, PipelineRunStatus } from "./project-pipeline-run.entity";
import { Project } from "./project.entity";
import { RepositorySourceService } from "./repository-source.service";
import { DEPLOYGUARD_PLATFORM_PORT } from "./railpack-release";
import { GithubActionsRuntimeSecretService } from "./github-actions-runtime-secret.service";
import { aliasesFor } from "./configuration-ownership";
import { immutableRailpackDispatchFingerprint, immutableRailpackImageTag, RailpackRuntimeConfiguration, RailpackWorkflowInputs, runtimeReferencesBase64 } from "./railpack-workflow-contract";

const ACTIVE = [PipelineRunStatus.QUEUED, PipelineRunStatus.RUNNING];

/** Single-service Railpack deployment admission; it does not inspect source. */
@Injectable()
export class RailpackDeploymentService {
  constructor(
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectEnvironmentVariable) private readonly variables: Repository<ProjectEnvironmentVariable>,
    @InjectRepository(ProjectDatabaseTier) private readonly databaseTiers: Repository<ProjectDatabaseTier>,
    private readonly githubApp: GithubAppService,
    private readonly actions: GithubActionsService,
    private readonly oidcTrust: GithubActionsOidcTrustService,
    private readonly source: RepositorySourceService,
    private readonly crypto: ProjectEnvironmentCryptoService,
    private readonly runtimeSecrets: GithubActionsRuntimeSecretService,
    private readonly config: ConfigService,
  ) {}

  async deploy(user: User, projectId: string) { return this.dispatch(user, projectId, "deploy"); }
  async retry(user: User, projectId: string) {
    await this.project(user, projectId);
    const previous = await this.runs.findOne({ where: { projectId, status: PipelineRunStatus.FAILED }, order: { createdAt: "DESC" } });
    const action = previous?.metadata?.deploymentAction === "destroy" ? "destroy"
      : previous?.metadata?.deploymentAction === "rollback" ? "rollback" : "deploy";
    const rollbackDigest = action === "rollback" && typeof previous?.metadata?.rollbackImageDigest === "string" ? previous.metadata.rollbackImageDigest : "";
    return this.dispatch(user, projectId, action, rollbackDigest, "", previous?.id || null);
  }
  async resetAndDeployFresh(user: User, projectId: string, confirmationPhrase: string, _request?: unknown) {
    const project = await this.project(user, projectId);
    if (confirmationPhrase !== project.name) throw new ForbiddenException("Type the project name to confirm a fresh deployment.");
    return this.dispatch(user, projectId, "deploy");
  }
  async destroy(user: User, projectId: string, confirmationPhrase: string) {
    const project = await this.project(user, projectId);
    if (confirmationPhrase !== project.name) throw new ForbiddenException("Type the project name to confirm destroy.");
    return this.dispatch(user, projectId, "destroy");
  }
  async rollbackCandidates(user: User, projectId: string) {
    await this.project(user, projectId);
    const operations = await this.runs.find({ where: { projectId, status: PipelineRunStatus.COMPLETED }, order: { createdAt: "DESC" }, take: 20 });
    return { candidates: operations.filter((run) => typeof run.metadata?.imageDigest === "string").map((run) => ({ operationId: run.id, sourceSha: run.commitSha, imageDigest: run.metadata!.imageDigest })) };
  }
  async rollback(user: User, projectId: string, targetOperationId: string) {
    const target = await this.runs.findOne({ where: { id: targetOperationId, projectId } });
    const digest = typeof target?.metadata?.imageDigest === "string" ? target.metadata.imageDigest : "";
    if (!digest) throw new NotFoundException("The selected release does not have an immutable image digest.");
    return this.dispatch(user, projectId, "rollback", digest, target.commitSha);
  }
  async latest(user: User, projectId: string) {
    await this.project(user, projectId);
    const operation = await this.runs.findOne({ where: { projectId }, order: { createdAt: "DESC" } });
    if (operation) await this.reconcile(operation);
    return { deployment: operation };
  }
  async history(user: User, projectId: string) {
    await this.project(user, projectId);
    const deployments = await this.runs.find({ where: { projectId }, order: { createdAt: "DESC" }, take: 50 });
    await Promise.all(deployments.filter((run) => ACTIVE.includes(run.status)).map((run) => this.reconcile(run)));
    return { operations: deployments.map((operation) => this.presentOperation(operation)) };
  }

  private async dispatch(user: User, projectId: string, action: "deploy" | "rollback" | "destroy", rollbackImageDigest = "", rollbackSourceSha = "", retryOfOperationId: string | null = null) {
    const project = await this.project(user, projectId);
    const active = await this.runs.findOne({ where: { projectId, status: In(ACTIVE) }, order: { createdAt: "DESC" } });
    if (active) return { deployment: { state: "no_op", message: "A deployment is already progressing.", operation: active } };
    const environmentName = canonicalEnvironmentName(project);
    const operationId = randomUUID();
    const attempt = await this.runs.count({ where: { projectId } }) + 1;
    // Persist before every external boundary. A rejected caller reconciliation
    // or GitHub API request is a real DeployGuard operation, even though it
    // never acquired a GitHub run id.
    const operation = await this.runs.save(this.runs.create({
      id: operationId, projectId, triggeredByUserId: user.id, repositoryUrl: project.repositoryUrl, repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch, status: PipelineRunStatus.QUEUED,
      currentStage: "dispatching", startedAt: new Date(), githubWorkflowStatus: "dispatching",
      metadata: { executionEngine: "railpack", deploymentAction: action, dispatchState: "dispatching", requestedAt: new Date().toISOString(), attempt, ...(retryOfOperationId ? { retryOfOperationId } : {}) },
    }));
    try {
      operation.currentStage = "control_plane_release";
      await this.runs.save(operation);
      const controlPlaneSha = this.controlPlaneSha();
      operation.metadata = { ...(operation.metadata || {}), configuredControlPlaneSha: controlPlaneSha };
      await this.runs.save(operation);
      operation.currentStage = "github_authentication";
      await this.runs.save(operation);
      const credential = await this.githubApp.tokenForRepository(user.id, project.repositoryFullName, project.githubInstallationId);
      operation.currentStage = "caller_reconciliation";
      await this.runs.save(operation);
      await this.githubApp.ensureWorkflow(user.id, project.repositoryFullName, project.targetBranch, project.githubInstallationId);
      operation.currentStage = "oidc_authorization";
      await this.runs.save(operation);
      await this.oidcTrust.ensureRepositoryAuthorized(project.repositoryFullName, await this.githubApp.oidcTrustSubject(user.id, project.repositoryFullName, project.githubInstallationId));
      operation.currentStage = "source_resolution";
      await this.runs.save(operation);
      const sourceSha = action === "rollback" ? rollbackSourceSha : await this.source.resolveSourceSha({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch, accessToken: credential.token });
      if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new ServiceUnavailableException("An exact source SHA is required for the release.");
      const runtime = await this.runtimeConfiguration(project, environmentName, operationId, sourceSha);
      const inputs: RailpackWorkflowInputs = {
        deployment_action: action, deployment_operation_id: operationId, project_id: project.id, environment_name: environmentName,
        repository_full_name: project.repositoryFullName, repository_branch: project.targetBranch, commit_sha: sourceSha,
        image_tag: immutableRailpackImageTag(sourceSha, operationId), environment_references_base64: runtimeReferencesBase64(runtime),
        managed_database_enabled: String(runtime.managedDatabase.enabled), infrastructure_namespace: `/deployguard/${project.id}/${environmentName}`,
        aws_region: this.config.get<string>("AWS_REGION", "us-east-1"), aws_role_arn: this.required("DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN"),
        vpc_id: this.required("DEPLOYGUARD_VPC_ID"), public_subnet_ids: this.required("DEPLOYGUARD_PUBLIC_SUBNET_IDS"),
        terraform_state_bucket: this.required("DEPLOYGUARD_TERRAFORM_STATE_BUCKET"), platform_port: String(DEPLOYGUARD_PLATFORM_PORT), rollback_image_digest: rollbackImageDigest,
        control_plane_sha: controlPlaneSha,
      };
      operation.commitSha = sourceSha;
      operation.imageTag = inputs.image_tag;
      operation.currentStage = "workflow_dispatch";
      operation.metadata = { ...(operation.metadata || {}), dispatchState: "dispatching", configuredControlPlaneSha: inputs.control_plane_sha, immutableDispatchInputs: inputs, immutableDispatchFingerprint: immutableRailpackDispatchFingerprint(inputs) };
      await this.runs.save(operation);
      const dispatched = await this.actions.triggerWorkflow({ repositoryFullName: project.repositoryFullName, targetBranch: project.targetBranch, token: credential.token, inputs });
      operation.githubWorkflowRunId = dispatched.receipt.workflowRunId;
      operation.githubWorkflowStatus = "queued";
      operation.status = PipelineRunStatus.RUNNING;
      operation.currentStage = "github_actions";
      operation.metadata = { ...(operation.metadata || {}), dispatchState: "dispatched", workflowRunUrl: dispatched.receipt.workflowRunUrl };
      await this.runs.save(operation);
    } catch (error) {
      const failure = this.dispatchFailure(error, operation.currentStage);
      operation.status = PipelineRunStatus.FAILED; operation.currentStage = "dispatch_failed"; operation.githubWorkflowStatus = "not_dispatched"; operation.failedAt = new Date(); operation.errorMessage = failure.message;
      operation.metadata = { ...(operation.metadata || {}), dispatchState: "failed", failureSource: "deployguard_dispatch", failedStage: failure.stage, safeLog: failure.message, dispatchFailure: failure.evidence };
      await this.runs.save(operation);
      return { deployment: { state: "dispatch_failed", message: "Deployment could not start. DeployGuard failed while starting the GitHub Actions deployment.", operation } };
    }
    return { deployment: { state: "accepted", message: "Railpack deployment dispatched to GitHub Actions.", operation } };
  }

  private dispatchFailure(error: unknown, stage: string | null) {
    if (error instanceof GithubActionsDispatchError) {
      return { stage: stage || "workflow_dispatch", message: error.safeDetail || "DeployGuard could not dispatch the GitHub Actions workflow.", evidence: error.evidence || { classification: error.diagnosticCode } };
    }
    const message = error instanceof Error ? error.message : "DeployGuard could not start the deployment.";
    return { stage: stage || "dispatching", message: message.slice(0, 500), evidence: { classification: "deployguard_dispatch_failure" } };
  }

  private presentOperation(operation: ProjectPipelineRun) {
    const metadata = operation.metadata || {};
    const dispatchFailed = metadata.dispatchState === "failed" && !operation.githubWorkflowRunId;
    return {
      id: operation.id, attempt: String(metadata.attempt || 1), retryOfOperationId: typeof metadata.retryOfOperationId === "string" ? metadata.retryOfOperationId : null,
      deploymentAction: metadata.deploymentAction || "deploy", status: dispatchFailed ? "dispatch_failed" : operation.status,
      commitSha: operation.commitSha || null, generationId: operation.generationId || null, createdAt: operation.createdAt, startedAt: operation.startedAt,
      completedAt: operation.completedAt, failedAt: operation.failedAt, workflowRunId: operation.githubWorkflowRunId || null,
      workflowUrl: typeof metadata.workflowRunUrl === "string" ? metadata.workflowRunUrl : null, workflowStatus: operation.githubWorkflowStatus || null,
      stageLabel: dispatchFailed ? "Deployment could not start" : operation.currentStage || null,
      failedStageLabel: dispatchFailed ? String(metadata.failedStage || "dispatch") : null,
      errorMessage: operation.errorMessage || null, githubRunCreated: Boolean(operation.githubWorkflowRunId),
      dispatchFailure: dispatchFailed, aiAnalysisEligible: dispatchFailed || (operation.status === PipelineRunStatus.FAILED && Boolean(operation.githubWorkflowRunId) && typeof metadata.safeLog === "string" && metadata.safeLog.trim().length > 0),
      safeLog: typeof metadata.safeLog === "string" ? metadata.safeLog : null,
      workflowStages: Array.isArray(metadata.workflowStages) ? metadata.workflowStages : [],
    };
  }

  private async runtimeConfiguration(project: Project, environmentName: string, operationId: string, sourceSha: string): Promise<RailpackRuntimeConfiguration> {
    const rows = await this.variables.createQueryBuilder("variable").addSelect("variable.value").where({ projectId: project.id, environment: environmentName, isActive: true }).getMany();
    const environment: Record<string, string> = { PORT: String(DEPLOYGUARD_PLATFORM_PORT), HOST: "0.0.0.0" };
    const secretValues: Record<string, string> = {};
    for (const row of rows) {
      if (["PORT", "HOST"].includes(row.key)) continue;
      const value = this.crypto.decrypt(row.value);
      if (row.isSecret) secretValues[row.key] = value; else environment[row.key] = value;
    }
    const configurationFingerprint = createHash("sha256").update(JSON.stringify({ projectId: project.id, environmentName, operationId, environment, secretNames: Object.keys(secretValues).sort() })).digest("hex");
    const materialized = await this.runtimeSecrets.materialize({ projectId: project.id, generationId: operationId, environment: environmentName, configurationFingerprint, secretValues });
    const tier = await this.databaseTiers.findOne({ where: { projectId: project.id, provider: DatabaseTierProvider.MANAGED } });
    const engine = tier?.engine || "postgres";
    const managedAliases = tier ? [
      ...aliasesFor(engine, "host"), ...aliasesFor(engine, "port"),
      ...aliasesFor(engine, "username"), ...aliasesFor(engine, "password"),
      ...aliasesFor(engine, "database"), ...aliasesFor(engine, "url"),
    ] : [];
    return { schemaVersion: 1, projectId: project.id, environmentName, operationId, sourceSha, environment, secretReferences: materialized?.valueFromByName || {}, managedDatabase: { enabled: Boolean(tier), engine: tier?.engine || null, aliases: [...new Set(managedAliases)].sort() } };
  }

  private async reconcile(operation: ProjectPipelineRun) {
    if (!ACTIVE.includes(operation.status) || !operation.githubWorkflowRunId) return operation;
    const [project, user] = await Promise.all([
      this.projects.findOne({ where: { id: operation.projectId } }),
      this.users.findOne({ where: { id: operation.triggeredByUserId } }),
    ]);
    if (!project || !user || !project.repositoryFullName) return operation;
    try {
      const credential = await this.githubApp.tokenForRepository(user.id, project.repositoryFullName, project.githubInstallationId);
      const workflow = await this.actions.getWorkflowRun(project.repositoryFullName, operation.githubWorkflowRunId, credential.token);
      const status = String(workflow.status || "");
      const conclusion = String(workflow.conclusion || "");
      operation.githubWorkflowStatus = status || operation.githubWorkflowStatus;
      if (status === "completed") {
        operation.completedAt = new Date();
        if (conclusion === "success") {
          const evidence = await this.releaseEvidence(project.repositoryFullName, operation, credential.token);
          if (!evidence) {
            operation.currentStage = "release_evidence_pending";
            operation.metadata = { ...(operation.metadata || {}), workflowConclusion: conclusion, workflowUpdatedAt: new Date().toISOString() };
            await this.runs.save(operation);
            return operation;
          }
          operation.status = PipelineRunStatus.COMPLETED;
          operation.currentStage = "release_complete";
          operation.errorMessage = null;
          operation.metadata = { ...(operation.metadata || {}), workflowConclusion: conclusion, workflowUpdatedAt: new Date().toISOString(), ...evidence };
        } else {
          operation.status = PipelineRunStatus.FAILED;
          operation.currentStage = "release_failed";
          operation.errorMessage = `GitHub Actions concluded: ${conclusion || "failure"}.`;
          operation.metadata = { ...(operation.metadata || {}), workflowConclusion: conclusion, workflowUpdatedAt: new Date().toISOString() };
        }
      }
      await this.runs.save(operation);
    } catch {
      // Polling is best-effort; do not convert a running release into failure
      // solely because GitHub status was temporarily unavailable.
    }
    return operation;
  }

  private async releaseEvidence(repositoryFullName: string, operation: ProjectPipelineRun, token: string): Promise<Record<string, unknown> | null> {
    const raw = await this.actions.getResultArtifact(repositoryFullName, operation.githubWorkflowRunId, operation.id, token);
    if (!raw) return null;
    let artifact: Record<string, unknown>;
    try { artifact = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error("The release result artifact is not valid JSON."); }
    const action = String(artifact.action || "");
    const sourceSha = String(artifact.sourceSha || "");
    const operationId = String(artifact.operationId || "");
    const expectedAction = String(operation.metadata?.deploymentAction || "");
    if (action !== expectedAction || sourceSha !== operation.commitSha || operationId !== operation.id) throw new Error("The release result artifact does not match its immutable operation identity.");
    if (action === "destroy") {
      if (artifact.destroyed !== true) throw new Error("The destroy result artifact does not prove deletion.");
      return { releaseArtifact: artifact, destroyed: true };
    }
    const image = String(artifact.image || "");
    const match = image.match(/^(.*)@(sha256:[0-9a-f]{64})$/);
    if (!match || !artifact.terraform || typeof artifact.terraform !== "object") throw new Error("The release result artifact does not prove an immutable runtime image.");
    const terraform = artifact.terraform as Record<string, unknown>;
    if (terraform.image !== image || typeof terraform.alb_url !== "string" || typeof terraform.task_definition_arn !== "string" || typeof terraform.ecs_service_arn !== "string") {
      throw new Error("The release result artifact does not prove ECS and ALB materialization.");
    }
    return { releaseArtifact: artifact, imageUri: match[1], imageDigest: match[2], albUrl: terraform.alb_url, taskDefinitionArn: terraform.task_definition_arn, ecsServiceArn: terraform.ecs_service_arn };
  }

  private required(key: string) { const value = this.config.get<string>(key, "").trim(); if (!value) throw new ServiceUnavailableException(`Platform configuration is missing: ${key}.`); return value; }
  private controlPlaneSha() { const match = this.required("DEPLOYGUARD_REUSABLE_WORKFLOW").match(/@([0-9a-f]{40})$/); if (!match) throw new ServiceUnavailableException("DeployGuard reusable workflow must be pinned to an exact control-plane SHA."); return match[1]; }
  private async project(user: User, projectId: string) { const project = await this.projects.findOne({ where: { id: projectId } }); if (!project) throw new NotFoundException("Project not found."); if (project.ownerUserId !== user.id) throw new ForbiddenException("Project operations are restricted to the project owner."); if (!project.repositoryFullName) throw new ServiceUnavailableException("Project repository identity is unavailable."); return project; }
}
