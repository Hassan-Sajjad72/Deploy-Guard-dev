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
import { GithubActionsService } from "./pipeline/github-actions.service";
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
  async retry(user: User, projectId: string) { return this.dispatch(user, projectId, "deploy"); }
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
    return this.dispatch(user, projectId, "rollback", digest);
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
    return { deployments };
  }

  private async dispatch(user: User, projectId: string, action: "deploy" | "rollback" | "destroy", rollbackImageDigest = "") {
    const project = await this.project(user, projectId);
    const active = await this.runs.findOne({ where: { projectId, status: In(ACTIVE) }, order: { createdAt: "DESC" } });
    if (active) return { deployment: { state: "no_op", message: "A deployment is already progressing.", operation: active } };
    const environmentName = canonicalEnvironmentName(project);
    const credential = await this.githubApp.tokenForRepository(user.id, project.repositoryFullName, project.githubInstallationId);
    await this.githubApp.ensureWorkflow(user.id, project.repositoryFullName, project.targetBranch, project.githubInstallationId);
    await this.oidcTrust.ensureRepositoryAuthorized(project.repositoryFullName, await this.githubApp.oidcTrustSubject(user.id, project.repositoryFullName, project.githubInstallationId));
    const sourceSha = action === "rollback" ? String((await this.runs.findOne({ where: { projectId }, order: { createdAt: "DESC" } }))?.commitSha || "") : await this.source.resolveSourceSha({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch, accessToken: credential.token });
    if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new ServiceUnavailableException("An exact source SHA is required for the release.");
    const operationId = randomUUID();
    const runtime = await this.runtimeConfiguration(project, environmentName, operationId, sourceSha);
    const inputs: RailpackWorkflowInputs = {
      deployment_action: action, deployment_operation_id: operationId, project_id: project.id, environment_name: environmentName,
      repository_full_name: project.repositoryFullName, repository_branch: project.targetBranch, commit_sha: sourceSha,
      image_tag: immutableRailpackImageTag(sourceSha, operationId), environment_references_base64: runtimeReferencesBase64(runtime),
      managed_postgres_enabled: String(runtime.managedPostgres.enabled), infrastructure_namespace: `/deployguard/${project.id}/${environmentName}/${operationId}`,
      aws_region: this.config.get<string>("AWS_REGION", "us-east-1"), aws_role_arn: this.required("DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN"),
      vpc_id: this.required("DEPLOYGUARD_VPC_ID"), public_subnet_ids: this.required("DEPLOYGUARD_PUBLIC_SUBNET_IDS"),
      terraform_state_bucket: this.required("DEPLOYGUARD_TERRAFORM_STATE_BUCKET"), platform_port: String(DEPLOYGUARD_PLATFORM_PORT), rollback_image_digest: rollbackImageDigest,
      control_plane_sha: this.controlPlaneSha(),
    };
    const operation = await this.runs.save(this.runs.create({
      id: operationId, projectId, triggeredByUserId: user.id, repositoryUrl: project.repositoryUrl, repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch, commitSha: sourceSha, imageTag: inputs.image_tag, status: PipelineRunStatus.QUEUED,
      currentStage: "workflow_dispatch", startedAt: new Date(), githubWorkflowStatus: "dispatching",
      metadata: { executionEngine: "railpack", deploymentAction: action, immutableDispatchInputs: inputs, immutableDispatchFingerprint: immutableRailpackDispatchFingerprint(inputs) },
    }));
    try {
      const dispatched = await this.actions.triggerWorkflow({ repositoryFullName: project.repositoryFullName, targetBranch: project.targetBranch, token: credential.token, inputs });
      operation.githubWorkflowRunId = dispatched.receipt.workflowRunId;
      operation.githubWorkflowStatus = "queued";
      operation.status = PipelineRunStatus.RUNNING;
      operation.metadata = { ...(operation.metadata || {}), workflowRunUrl: dispatched.receipt.workflowRunUrl };
      await this.runs.save(operation);
    } catch (error) {
      operation.status = PipelineRunStatus.FAILED; operation.githubWorkflowStatus = "not_dispatched"; operation.failedAt = new Date(); operation.errorMessage = "GitHub Actions dispatch failed.";
      await this.runs.save(operation); throw error;
    }
    return { deployment: { state: "accepted", message: "Railpack deployment dispatched to GitHub Actions.", operation } };
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
    return { schemaVersion: 1, projectId: project.id, environmentName, operationId, sourceSha, environment, secretReferences: materialized?.valueFromByName || {}, managedPostgres: { enabled: Boolean(tier), engine: tier?.engine || null, aliases: [...new Set(managedAliases)].sort() } };
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
        operation.status = conclusion === "success" ? PipelineRunStatus.COMPLETED : PipelineRunStatus.FAILED;
        operation.currentStage = conclusion === "success" ? "release_complete" : "release_failed";
        operation.errorMessage = conclusion === "success" ? null : `GitHub Actions concluded: ${conclusion || "failure"}.`;
        operation.metadata = { ...(operation.metadata || {}), workflowConclusion: conclusion, workflowUpdatedAt: new Date().toISOString() };
      }
      await this.runs.save(operation);
    } catch {
      // Polling is best-effort; do not convert a running release into failure
      // solely because GitHub status was temporarily unavailable.
    }
    return operation;
  }

  private required(key: string) { const value = this.config.get<string>(key, "").trim(); if (!value) throw new ServiceUnavailableException(`Platform configuration is missing: ${key}.`); return value; }
  private controlPlaneSha() { const match = this.required("DEPLOYGUARD_REUSABLE_WORKFLOW").match(/@([0-9a-f]{40})$/); if (!match) throw new ServiceUnavailableException("DeployGuard reusable workflow must be pinned to an exact control-plane SHA."); return match[1]; }
  private async project(user: User, projectId: string) { const project = await this.projects.findOne({ where: { id: projectId } }); if (!project) throw new NotFoundException("Project not found."); if (project.ownerUserId !== user.id) throw new ForbiddenException("Project operations are restricted to the project owner."); if (!project.repositoryFullName) throw new ServiceUnavailableException("Project repository identity is unavailable."); return project; }
}
