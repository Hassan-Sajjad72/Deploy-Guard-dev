import { ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash, randomUUID } from "crypto";
import { DataSource, In, Repository } from "typeorm";
import { ProjectStableRelease, StableReleaseStatus } from "../orchestration/project-stable-release.entity";
import { User } from "../users/user.entity";
import { canonicalEnvironmentName } from "./canonical-environment";
import { ProjectDatabaseTier, DatabaseTierProvider, DatabaseTierStatus } from "./project-database-tier.entity";
import { ProjectEnvironmentCryptoService } from "./project-environment-crypto.service";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { CONTROL_PLANE_VERSION_MISMATCH, ControlPlaneCompatibilityError, GithubAppService } from "./github-app.service";
import { GithubActionsOidcTrustService } from "./github-actions-oidc-trust.service";
import { GithubActionsAwsCapabilityService, WorkflowAwsCapabilityError } from "./github-actions-aws-capability.service";
import { GithubActionsDispatchError, GithubActionsService } from "./pipeline/github-actions.service";
import { ProjectPipelineRun, PipelineRunStatus } from "./project-pipeline-run.entity";
import { Project } from "./project.entity";
import { RepositorySourceError, RepositorySourceService } from "./repository-source.service";
import { DEPLOYGUARD_DEFAULT_SERVICE_PORT, effectiveServicePort } from "./railpack-release";
import { GithubActionsRuntimeSecretService } from "./github-actions-runtime-secret.service";
import { isSupportedManagedDatabaseEngine } from "./managed-database-engine";
import { aliasesFor } from "./configuration-ownership";
import { assertRailpackRuntimeConfiguration, DEPLOYGUARD_PLATFORM_HEALTH_CHECK_PATH, immutableRailpackDispatchFingerprint, RAILPACK_RESULT_CONTRACT_VERSION, RailpackRuntimeConfiguration, RailpackWorkflowInputs, servicesBase64 } from "./railpack-workflow-contract";
import { LogSanitizerService } from "../observability/log-sanitizer.service";
import { DeploymentGenerationStatus, ProjectDeploymentGeneration } from "./project-deployment-generation.entity";
import { ProjectEnvironmentRoute } from "./project-environment-route.entity";
import { materializeStableRelease } from "./stable-release-projection";
import { GithubActionsCostEvidenceService } from "./github-actions-cost-evidence.service";
import { DESTROY_CONFIRMATION_PHRASE } from "./destroy-confirmation";
import { githubActionsDestroyEvidenceFromValue } from "./github-actions-destroy-evidence";
import { ProjectDeletionService } from "./project-deletion.service";
import { deployguardOperationStagePresentation, githubActionsWorkflowStageRelevant, githubActionsWorkflowStepPresentation } from "./pipeline/github-actions-stage-presentation";
import { ProjectDeployableService } from "./project-deployable-service.entity";
import { classifyStructuredFailure, terminalStructuredFailureMarker } from "./failure-ownership";
import { ProjectServiceRuntimeConfigRevision } from "./project-service-runtime-config-revision.entity";
import { ProjectGenerationServiceRevision } from "./project-generation-service-revision.entity";
import { requireApplicationEntrypointServiceId } from "./application-entrypoint";

const ACTIVE = [PipelineRunStatus.QUEUED, PipelineRunStatus.RUNNING];
class TerminalReleaseEvidenceError extends Error {}

type RollbackTargetIdentity = {
  releaseId: string;
  targetOperationId: string;
  generationId: string | null;
  sourceSha: string;
  services: Array<{ serviceId: string; serviceName: string; serviceDirectory: string; imageUri: string; imageDigest: string; immutableImage: string; runtimeConfigRevisionId: string; runtimeConfiguration: { servicePort: number; environment: Record<string, string>; secretReferences: Record<string, string>; databaseAttached: boolean; managedDatabase: { engine: "postgres" | "mysql" | "mongodb" | null; aliases: string[]; secretVersionId?: string | null } } }>;
};

export function promotedServiceRevisions<T extends { serviceId: string }>(
  verifiedCandidates: readonly T[],
  expectedServiceIds: readonly string[],
) {
  const candidates = new Map(verifiedCandidates.map((service) => [service.serviceId, service]));
  return [...new Set(expectedServiceIds)].sort().flatMap((serviceId) => {
    const revision = candidates.get(serviceId);
    return revision ? [revision] : [];
  });
}

/** Explicit-service Railpack deployment admission; it does not inspect application source. */
@Injectable()
export class RailpackDeploymentService {
  private readonly reconciliationInFlight = new Map<string, Promise<void>>();
  private completedReconciliationAfter = new Map<string, number>();

  constructor(
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectStableRelease) private readonly releases: Repository<ProjectStableRelease>,
    @InjectRepository(ProjectEnvironmentVariable) private readonly variables: Repository<ProjectEnvironmentVariable>,
    @InjectRepository(ProjectDatabaseTier) private readonly databaseTiers: Repository<ProjectDatabaseTier>,
    @InjectRepository(ProjectDeployableService) private readonly deployableServices: Repository<ProjectDeployableService>,
    @InjectRepository(ProjectServiceRuntimeConfigRevision) private readonly runtimeConfigRevisions: Repository<ProjectServiceRuntimeConfigRevision>,
    @InjectRepository(ProjectGenerationServiceRevision) private readonly serviceRevisions: Repository<ProjectGenerationServiceRevision>,
    private readonly githubApp: GithubAppService,
    private readonly actions: GithubActionsService,
    private readonly oidcTrust: GithubActionsOidcTrustService,
    private readonly awsCapabilities: GithubActionsAwsCapabilityService,
    private readonly source: RepositorySourceService,
    private readonly crypto: ProjectEnvironmentCryptoService,
    private readonly runtimeSecrets: GithubActionsRuntimeSecretService,
    private readonly config: ConfigService,
    private readonly sanitizer: LogSanitizerService,
    private readonly dataSource: DataSource,
    private readonly costEvidence: GithubActionsCostEvidenceService,
    private readonly projectDeletion: ProjectDeletionService,
  ) {}

  async deploy(user: User, projectId: string) { return this.dispatch(user, projectId, "deploy"); }
  async retry(user: User, projectId: string) {
    const project = await this.project(user, projectId);
    const previous = await this.runs.findOne({ where: { projectId, status: PipelineRunStatus.FAILED }, order: { createdAt: "DESC" } });
    const action = previous?.metadata?.deploymentAction === "destroy" ? "destroy"
      : previous?.metadata?.deploymentAction === "rollback" ? "rollback" : "deploy";
    const destroyVerification = action === "destroy" && previous ? this.verifiedDestroyEvidence(previous, project) : null;
    if (previous && destroyVerification) {
      try {
        await this.projectDeletion.finalize(project, previous);
        return { deployment: { state: "no_op", message: "Verified AWS deletion was already complete; DeployGuard control-plane cleanup completed without redispatching Terraform.", operation: previous } };
      } catch (error) {
        await this.persistDestroyCleanupFailure(previous, destroyVerification, error);
        return { deployment: { state: "no_op", message: "Verified AWS deletion remains complete; DeployGuard control-plane cleanup still needs attention and can be retried.", operation: previous } };
      }
    }
    if (previous?.failureCode === "DG_RELEASE_FINALIZATION_FAILED"
      && previous.metadata?.releaseEvidenceValidated === true
      && previous.metadata?.workflowConclusion === "success") {
      const artifact = previous.metadata.releaseArtifact;
      if (!artifact || typeof artifact !== "object") {
        await this.persistTerminalEvidenceFailure(previous, new TerminalReleaseEvidenceError("Persisted release-finalization recovery evidence is missing its immutable artifact."));
        return { deployment: { state: "no_op", message: "DeployGuard rejected the persisted finalization evidence; no GitHub or AWS deployment was started.", operation: previous } };
      }
      let evidence: Record<string, unknown>;
      try {
        evidence = this.validatedReleaseEvidence(previous, artifact as Record<string, unknown>);
      } catch (error) {
        await this.persistTerminalEvidenceFailure(previous, error);
        return { deployment: { state: "no_op", message: "DeployGuard rejected the persisted finalization evidence; no GitHub or AWS deployment was started.", operation: previous } };
      }
      try {
        await this.finalizeVerifiedRelease(project, previous, evidence, "success");
        return { deployment: { state: "no_op", message: "Verified AWS release evidence was revalidated and DeployGuard finalization completed without rebuilding or changing AWS.", operation: previous } };
      } catch (error) {
        await this.persistFinalizationFailure(previous, evidence, error);
        return { deployment: { state: "no_op", message: "Verified AWS release evidence remains valid; DeployGuard finalization still needs attention and can be retried without changing AWS.", operation: previous } };
      }
    }
    const rollbackTarget = action === "rollback" ? this.persistedRollbackTarget(previous) : null;
    return this.dispatch(user, projectId, action, rollbackTarget, previous?.id || null);
  }
  async resetAndDeployFresh(user: User, projectId: string, confirmationPhrase: string, _request?: unknown) {
    const project = await this.project(user, projectId);
    if (confirmationPhrase !== project.name) throw new ForbiddenException("Type the project name to confirm a fresh deployment.");
    return this.dispatch(user, projectId, "deploy");
  }
  async destroy(user: User, projectId: string, confirmationPhrase: string) {
    await this.project(user, projectId);
    if (confirmationPhrase !== DESTROY_CONFIRMATION_PHRASE) throw new ForbiddenException(`Type ${DESTROY_CONFIRMATION_PHRASE} to confirm destroy.`);
    return this.dispatch(user, projectId, "destroy");
  }
  async rollbackCandidates(user: User, projectId: string) {
    const project = await this.project(user, projectId);
    const environmentName = canonicalEnvironmentName(project);
    const target = await this.releases.findOne({
      where: { projectId, environmentName, status: StableReleaseStatus.ROLLBACK_TARGET },
      order: { deployedAt: "DESC" },
    });
    if (!target) return { candidates: [] };
    let immutable: RollbackTargetIdentity;
    try { immutable = await this.rollbackTarget(target); }
    catch { return { candidates: [], unavailableReason: "The historical release predates immutable runtime-configuration revisions and cannot be rolled back safely." }; }
    return { candidates: [{
      releaseId: target.id,
      targetOperationId: target.deployedByPipelineRunId,
      generationId: target.generationId,
      releaseRevision: target.shortCommitSha,
      commitSha: target.commitSha,
      services: immutable.services,
      appPort: target.appPort,
      healthCheckPath: target.healthCheckPath,
      deployedAt: target.deployedAt,
    }] };
  }
  async rollback(user: User, projectId: string, targetOperationId: string) {
    const project = await this.project(user, projectId);
    const target = await this.releases.findOne({ where: {
      projectId,
      environmentName: canonicalEnvironmentName(project),
      deployedByPipelineRunId: targetOperationId,
      status: StableReleaseStatus.ROLLBACK_TARGET,
    } });
    if (!target) throw new NotFoundException("The selected rollback release is no longer the immediate rollback target.");
    return this.dispatch(user, projectId, "rollback", await this.rollbackTarget(target));
  }
  async latest(user: User, projectId: string) {
    await this.reconcileActive(user, projectId);
    const operation = await this.runs.findOne({ where: { projectId }, order: { createdAt: "DESC" } });
    return { deployment: operation };
  }
  async history(user: User, projectId: string) {
    await this.reconcileActive(user, projectId);
    const deployments = await this.runs.find({ where: { projectId }, order: { createdAt: "DESC" }, take: 50 });
    return { operations: deployments.map((operation) => this.presentOperation(operation)) };
  }

  /** Reconcile terminal GitHub state before any authoritative project read. */
  async reconcileActive(user: User, projectId: string) {
    await this.project(user, projectId);
    const existing = this.reconciliationInFlight.get(projectId);
    if (existing) return existing;
    const task = (async () => {
      const active = await this.runs.find({ where: { projectId, status: In(ACTIVE) }, order: { createdAt: "DESC" }, take: 50 });
      await Promise.all(active.map((operation) => this.reconcile(operation)));
      // Earlier Railpack releases can have valid, persisted evidence but no
      // control-plane release projection. Reconcile that local state without
      // contacting GitHub or changing AWS.
      this.completedReconciliationAfter ||= new Map<string, number>();
      if ((this.completedReconciliationAfter.get(projectId) || 0) <= Date.now()) {
        const completed = await this.runs.find({ where: { projectId, status: PipelineRunStatus.COMPLETED }, order: { createdAt: "DESC" }, take: 50 });
        const failed = await this.runs.find({ where: { projectId, status: In([PipelineRunStatus.FAILED, PipelineRunStatus.CANCELLED]) }, order: { createdAt: "DESC" }, take: 50 });
        await Promise.all(completed.map(async (operation) => {
          await this.reconcileCompletedRelease(operation);
          await this.reconcileCostEvidence(operation);
        }));
        await Promise.all([...completed, ...failed].map((operation) => this.reconcileTerminalWorkflowStages(operation)));
        this.completedReconciliationAfter.set(projectId, Date.now() + 60_000);
      }
    })();
    this.reconciliationInFlight.set(projectId, task);
    try { await task; }
    finally { if (this.reconciliationInFlight.get(projectId) === task) this.reconciliationInFlight.delete(projectId); }
  }

  /** Reconcile active operations for projects already filtered by the
   * workspace authorization boundary, using one bounded database query. */
  async reconcileVisibleProjects(user: User, projectIds: string[]) {
    void user;
    const ids = [...new Set(projectIds)].filter(Boolean);
    if (!ids.length) return;
    const active = await this.runs.find({
      where: { projectId: In(ids), status: In(ACTIVE) },
      order: { createdAt: "DESC" },
      take: Math.max(50, ids.length * 5),
    });
    await Promise.all(active.map((operation) => this.reconcile(operation)));
  }

  private async dispatch(user: User, projectId: string, action: "deploy" | "rollback" | "destroy", rollbackTarget: RollbackTargetIdentity | null = null, retryOfOperationId: string | null = null) {
    const project = await this.project(user, projectId);
    const active = await this.runs.findOne({ where: { projectId, status: In(ACTIVE) }, order: { createdAt: "DESC" } });
    if (active) return { deployment: { state: "no_op", message: "A deployment is already progressing.", operation: active } };
    const environmentName = canonicalEnvironmentName(project);
    const admittedServiceRows = action === "destroy" ? [] : await this.deployableServices.find({ where: { projectId: project.id }, order: { position: "ASC" } });
    if (action !== "destroy") {
      if (!admittedServiceRows.length) throw new ServiceUnavailableException("The project has no configured deployable service.");
      try {
        requireApplicationEntrypointServiceId(project.applicationEntryPointServiceId, action === "rollback" ? rollbackTarget?.services || [] : admittedServiceRows);
      } catch (error) {
        throw new ServiceUnavailableException(error instanceof Error ? error.message : "Select an application service before deploying this project.");
      }
    }
    const operationId = randomUUID();
    const attempt = await this.runs.count({ where: { projectId } }) + 1;
    const destroyRoute = action === "destroy"
      ? await this.dataSource.getRepository(ProjectEnvironmentRoute).findOne({ where: { projectId, environmentName } })
      : null;
    // Persist before every external boundary. A rejected caller reconciliation
    // or GitHub API request is a real DeployGuard operation, even though it
    // never acquired a GitHub run id.
    const operation = await this.runs.save(this.runs.create({
      id: operationId, projectId, triggeredByUserId: user.id, repositoryUrl: project.repositoryUrl, repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch, generationId: destroyRoute?.liveGenerationId || null, status: PipelineRunStatus.QUEUED,
      currentStage: "dispatching", startedAt: new Date(), githubWorkflowStatus: "dispatching",
      metadata: { executionEngine: "railpack", deploymentAction: action, dispatchState: "dispatching", requestedAt: new Date().toISOString(), attempt, ...(rollbackTarget ? { rollbackTarget } : {}), ...(retryOfOperationId ? { retryOfOperationId } : {}) },
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
      operation.currentStage = "source_resolution";
      await this.runs.save(operation);
      const destroyRelease = action === "destroy" ? await this.authoritativeDestroyRelease(project, environmentName, destroyRoute?.liveGenerationId || null) : null;
      const sourceSha = action === "rollback" ? rollbackTarget?.sourceSha || ""
        : action === "destroy" ? destroyRelease?.commitSha || ""
          : await this.source.resolveSourceSha({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch, accessToken: credential.token });
      if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new ServiceUnavailableException("An exact source SHA is required for the release.");
      const serviceRows = action === "destroy" ? await this.deployableServices.find({ where: { projectId: project.id }, order: { position: "ASC" } }) : admittedServiceRows;
      if (!serviceRows.length) throw new ServiceUnavailableException("The project has no configured deployable service.");
      if (action === "deploy") {
        operation.currentStage = "service_directory_validation";
        await this.runs.save(operation);
        await this.source.assertDirectoriesAtExactSha({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch, sourceSha, services: serviceRows.map((service) => ({ serviceId: service.id, serviceDirectory: service.serviceDirectory })), accessToken: credential.token });
      }
      operation.currentStage = "caller_reconciliation";
      await this.runs.save(operation);
      const caller = await this.githubApp.ensureWorkflow(user.id, project.repositoryFullName, project.githubInstallationId);
      operation.currentStage = "oidc_authorization";
      await this.runs.save(operation);
      await this.oidcTrust.ensureRepositoryAuthorized(project.repositoryFullName, await this.githubApp.oidcTrustSubject(user.id, project.repositoryFullName, project.githubInstallationId));
      const immutableTarget = action === "destroy" && destroyRelease ? await this.destroyTarget(destroyRelease) : rollbackTarget;
      const runtime = await this.runtimeConfiguration(project, environmentName, operationId, sourceSha, action, immutableTarget);
      const inputs: RailpackWorkflowInputs = {
        deployment_action: action, deployment_operation_id: operationId, project_id: project.id, environment_name: environmentName,
        repository_full_name: project.repositoryFullName, repository_branch: project.targetBranch, commit_sha: sourceSha,
        services_base64: servicesBase64(runtime), infrastructure_namespace: `/deployguard/${project.id}/${environmentName}`,
        aws_region: this.config.get<string>("AWS_REGION", "us-east-1"), aws_role_arn: this.required("DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN"),
        vpc_id: this.required("DEPLOYGUARD_VPC_ID"), public_subnet_ids: this.required("DEPLOYGUARD_PUBLIC_SUBNET_IDS"),
        terraform_state_bucket: this.required("DEPLOYGUARD_TERRAFORM_STATE_BUCKET"),
        control_plane_sha: controlPlaneSha, result_contract_version: RAILPACK_RESULT_CONTRACT_VERSION,
      };
      operation.commitSha = sourceSha;
      operation.imageTag = null;
      operation.currentStage = "aws_capability_verification";
      await this.runs.save(operation);
      await this.awsCapabilities.ensure({ action, projectId: project.id, environmentName, generationId: operationId, managedDatabaseEnabled: runtime.services.some((service) => service.databaseAttached) });
      operation.currentStage = "workflow_dispatch";
      operation.metadata = { ...(operation.metadata || {}), dispatchState: "dispatching", configuredControlPlaneSha: inputs.control_plane_sha, workflowRegistrationBranch: caller.registrationBranch, immutableDispatchInputs: inputs, immutableDispatchFingerprint: immutableRailpackDispatchFingerprint(inputs) };
      await this.runs.save(operation);
      const dispatched = await this.actions.triggerWorkflow({ repositoryFullName: project.repositoryFullName, targetBranch: project.targetBranch, workflowRegistrationBranch: caller.registrationBranch, token: credential.token, inputs });
      operation.githubWorkflowRunId = dispatched.receipt.workflowRunId;
      operation.githubWorkflowStatus = "queued";
      operation.status = PipelineRunStatus.RUNNING;
      operation.currentStage = "github_actions";
      operation.metadata = { ...(operation.metadata || {}), dispatchState: "dispatched", workflowRunUrl: dispatched.receipt.workflowRunUrl };
      await this.runs.save(operation);
    } catch (error) {
      const failure = this.dispatchFailure(error, operation.currentStage);
      operation.status = PipelineRunStatus.FAILED; operation.currentStage = "dispatch_failed"; operation.githubWorkflowStatus = "not_dispatched"; operation.failedAt = new Date(); operation.errorMessage = failure.message;
      const ownership = classifyStructuredFailure(failure.stage, `${failure.message} ${JSON.stringify(failure.evidence)}`);
      operation.failureOwner = ownership.failureOwner; operation.externalProvider = ownership.externalProvider; operation.failureCode = ownership.failureCode; operation.failureServiceId = ownership.failureServiceId;
      operation.metadata = { ...(operation.metadata || {}), dispatchState: "failed", failureSource: "deployguard_dispatch", failedStage: failure.stage, safeLog: failure.message, dispatchFailure: failure.evidence };
      await this.runs.save(operation);
      return { deployment: { state: "dispatch_failed", message: "Deployment could not start. DeployGuard failed while starting the GitHub Actions deployment.", operation } };
    }
    return { deployment: { state: "accepted", message: "Railpack deployment dispatched to GitHub Actions.", operation } };
  }

  private async rollbackTarget(release: ProjectStableRelease): Promise<RollbackTargetIdentity> {
    if (!release.generationId) throw new ServiceUnavailableException("The rollback target has no canonical generation identity.");
    const revisions = await this.serviceRevisions.find({ where: { generationId: release.generationId }, relations: { runtimeConfigRevision: true } });
    const services = revisions.sort((a, b) => a.serviceId.localeCompare(b.serviceId)).map((revision) => ({
      serviceId: revision.serviceId, serviceName: revision.serviceName, serviceDirectory: revision.serviceDirectory,
      imageUri: revision.imageUri, imageDigest: revision.imageDigest, immutableImage: `${revision.imageUri}@${revision.imageDigest}`,
      runtimeConfigRevisionId: revision.runtimeConfigRevisionId,
      runtimeConfiguration: {
        servicePort: effectiveServicePort(revision.runtimeConfigRevision.platformValues?.PORT ?? revision.runtimeConfigRevision.nonSecretEnvironment?.PORT),
        environment: { ...revision.runtimeConfigRevision.nonSecretEnvironment, PORT: String(effectiveServicePort(revision.runtimeConfigRevision.platformValues?.PORT ?? revision.runtimeConfigRevision.nonSecretEnvironment?.PORT)), HOST: "0.0.0.0" },
        secretReferences: revision.runtimeConfigRevision.secretReferences,
        databaseAttached: revision.runtimeConfigRevision.databaseConfiguration.attached === true,
        managedDatabase: {
          engine: (revision.runtimeConfigRevision.databaseConfiguration.engine || null) as "postgres" | "mysql" | "mongodb" | null,
          aliases: Array.isArray(revision.runtimeConfigRevision.databaseConfiguration.aliases) ? revision.runtimeConfigRevision.databaseConfiguration.aliases as string[] : [],
          secretVersionId: typeof revision.runtimeConfigRevision.databaseConfiguration.secretVersionId === "string" ? revision.runtimeConfigRevision.databaseConfiguration.secretVersionId : null,
        },
      },
      rollbackSafe: revision.runtimeConfigRevision.isRollbackSafe && Boolean(revision.runtimeConfigRevision.sealedAt),
    }));
    if (release.metadata?.releaseEvidenceVerified !== true
      || !release.deployedByPipelineRunId
      || !/^[0-9a-f]{40}$/i.test(release.commitSha)
      || !services.length
      || services.some((service) => !service.rollbackSafe || !/^[0-9a-f-]{36}$/i.test(service.runtimeConfigRevisionId) || !/^[0-9a-f-]{36}$/i.test(service.serviceId) || !service.serviceName || !service.serviceDirectory || !/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._\/-]*@sha256:[0-9a-f]{64}$/i.test(service.immutableImage))) {
      throw new ServiceUnavailableException("The rollback target does not contain a complete immutable image and runtime-configuration revision set.");
    }
    return { releaseId: release.id, targetOperationId: release.deployedByPipelineRunId, generationId: release.generationId, sourceSha: release.commitSha, services: services.map(({ rollbackSafe: _rollbackSafe, ...service }) => service) };
  }

  /**
   * Destroy consumes the exact deployed service/revision set, but never needs
   * to claim it is safe to roll back. Older verified releases may therefore
   * be destroyable while correctly remaining unavailable as rollback targets.
   */
  private async destroyTarget(release: ProjectStableRelease): Promise<RollbackTargetIdentity> {
    if (!release.generationId) throw new ServiceUnavailableException("Destroy requires a canonical deployed generation identity.");
    const revisions = await this.serviceRevisions.find({ where: { generationId: release.generationId }, relations: { runtimeConfigRevision: true } });
    const services = revisions.sort((a, b) => a.serviceId.localeCompare(b.serviceId)).map((revision) => ({
      serviceId: revision.serviceId,
      serviceName: revision.serviceName,
      serviceDirectory: revision.serviceDirectory,
      imageUri: revision.imageUri,
      imageDigest: revision.imageDigest,
      immutableImage: `${revision.imageUri}@${revision.imageDigest}`,
      runtimeConfigRevisionId: revision.runtimeConfigRevisionId,
      runtimeConfiguration: {
        // Platform-owned PORT/HOST are immutable deployment contract values,
        // persisted separately from user environment data. Retain them for a
        // legacy destroy without inventing any historical user configuration.
        servicePort: effectiveServicePort(revision.runtimeConfigRevision?.platformValues?.PORT ?? revision.runtimeConfigRevision?.nonSecretEnvironment?.PORT),
        environment: { ...(revision.runtimeConfigRevision?.nonSecretEnvironment || {}), ...(revision.runtimeConfigRevision?.platformValues || {}), PORT: String(effectiveServicePort(revision.runtimeConfigRevision?.platformValues?.PORT ?? revision.runtimeConfigRevision?.nonSecretEnvironment?.PORT)), HOST: "0.0.0.0" },
        secretReferences: revision.runtimeConfigRevision?.secretReferences,
        databaseAttached: revision.runtimeConfigRevision?.databaseConfiguration?.attached === true,
        managedDatabase: {
          engine: (revision.runtimeConfigRevision?.databaseConfiguration?.engine || null) as "postgres" | "mysql" | "mongodb" | null,
          aliases: Array.isArray(revision.runtimeConfigRevision?.databaseConfiguration?.aliases) ? revision.runtimeConfigRevision.databaseConfiguration.aliases as string[] : [],
          secretVersionId: typeof revision.runtimeConfigRevision?.databaseConfiguration?.secretVersionId === "string" ? revision.runtimeConfigRevision.databaseConfiguration.secretVersionId : null,
        },
      },
    }));
    if (release.metadata?.releaseEvidenceVerified !== true || !release.deployedByPipelineRunId || !/^[0-9a-f]{40}$/i.test(release.commitSha) || !services.length || services.some((service) => service.runtimeConfiguration.environment.PORT !== String(service.runtimeConfiguration.servicePort) || service.runtimeConfiguration.environment.HOST !== "0.0.0.0" || !service.runtimeConfiguration.secretReferences || !/^[0-9a-f-]{36}$/i.test(service.runtimeConfigRevisionId) || !/^[0-9a-f-]{36}$/i.test(service.serviceId) || !service.serviceName || !service.serviceDirectory || !/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._\/-]*@sha256:[0-9a-f]{64}$/i.test(service.immutableImage))) {
      throw new ServiceUnavailableException("Destroy requires the complete immutable deployed service revision set.");
    }
    return { releaseId: release.id, targetOperationId: release.deployedByPipelineRunId, generationId: release.generationId, sourceSha: release.commitSha, services };
  }

  private async authoritativeDestroyRelease(project: Project, environmentName: string, generationId: string | null) {
    if (!generationId) throw new ServiceUnavailableException("Destroy requires the authoritative verified deployed release identity.");
    const release = await this.releases.findOne({ where: { projectId: project.id, environmentName, generationId, status: StableReleaseStatus.STABLE } });
    if (!release || release.metadata?.releaseEvidenceVerified !== true || !/^[0-9a-f]{40}$/i.test(release.commitSha)) {
      throw new ServiceUnavailableException("Destroy requires the authoritative verified deployed release identity.");
    }
    return release;
  }

  private persistedRollbackTarget(operation: ProjectPipelineRun | null): RollbackTargetIdentity {
    const value = operation?.metadata?.rollbackTarget;
    if (!value || typeof value !== "object") throw new ServiceUnavailableException("The failed rollback does not retain a canonical immutable target.");
    const target = value as Record<string, unknown>;
    const services = Array.isArray(target.services) ? target.services as Array<Record<string, unknown>> : [];
    if (!/^[0-9a-f]{40}$/i.test(String(target.sourceSha || ""))
      || !services.length
      || services.some((service) => !/^[0-9a-f-]{36}$/i.test(String(service.runtimeConfigRevisionId || "")) || !service.runtimeConfiguration || String(service.immutableImage || "") !== `${String(service.imageUri || "")}@${String(service.imageDigest || "")}` || !/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._\/-]*@sha256:[0-9a-f]{64}$/i.test(String(service.immutableImage || "")))) {
      throw new ServiceUnavailableException("The failed rollback target identity is invalid.");
    }
    return {
      ...(target as unknown as RollbackTargetIdentity),
      services: services.map((service) => {
        const runtimeConfiguration = service.runtimeConfiguration as Record<string, unknown>;
        const environment = runtimeConfiguration.environment && typeof runtimeConfiguration.environment === "object"
          ? runtimeConfiguration.environment as Record<string, string>
          : {};
        const servicePort = effectiveServicePort(runtimeConfiguration.servicePort ?? environment.PORT);
        return {
          ...(service as unknown as RollbackTargetIdentity["services"][number]),
          runtimeConfiguration: {
            ...(runtimeConfiguration as unknown as RollbackTargetIdentity["services"][number]["runtimeConfiguration"]),
            servicePort,
            environment: { ...environment, PORT: String(servicePort), HOST: "0.0.0.0" },
          },
        };
      }),
    };
  }

  private dispatchFailure(error: unknown, stage: string | null) {
    if (error instanceof ControlPlaneCompatibilityError) {
      return { stage: "control_plane_compatibility", message: `${error.message} DG_FAILURE code=${CONTROL_PLANE_VERSION_MISMATCH} stage=control_plane_compatibility`, evidence: { classification: "platform_configuration", code: CONTROL_PLANE_VERSION_MISMATCH } };
    }
    if (error instanceof WorkflowAwsCapabilityError) {
      return { stage: stage || "aws_capability_verification", message: `AWS platform capability verification failed: ${error.missingCapabilities.join(", ") || "required capability unavailable"}.`, evidence: { classification: "platform_configuration", missingCapabilities: error.missingCapabilities } };
    }
    if (error instanceof GithubActionsDispatchError) {
      return { stage: stage || "workflow_dispatch", message: error.safeDetail || "DeployGuard could not dispatch the GitHub Actions workflow.", evidence: error.evidence || { classification: error.diagnosticCode } };
    }
    if (error instanceof RepositorySourceError) {
      return { stage: stage || "source_resolution", message: error.message.slice(0, 500), evidence: { classification: "repository_configuration", safeDetail: error.safeDetail } };
    }
    const message = error instanceof Error ? error.message : "DeployGuard could not start the deployment.";
    return { stage: stage || "dispatching", message: message.slice(0, 500), evidence: { classification: "deployguard_dispatch_failure" } };
  }

  private presentOperation(operation: ProjectPipelineRun) {
    const metadata = operation.metadata || {};
    const action = (metadata.deploymentAction || "deploy") as "deploy" | "rollback" | "destroy";
    const dispatchFailed = metadata.dispatchState === "failed" && !operation.githubWorkflowRunId;
    let failureServiceName: string | null = null;
    try {
      const encoded = (metadata.immutableDispatchInputs as Record<string, unknown> | undefined)?.services_base64;
      const contract = typeof encoded === "string" ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as RailpackRuntimeConfiguration : null;
      failureServiceName = contract?.services.find((service) => service.serviceId === operation.failureServiceId)?.serviceName || null;
    } catch { failureServiceName = null; }
    return {
      id: operation.id, attempt: String(metadata.attempt || 1), retryOfOperationId: typeof metadata.retryOfOperationId === "string" ? metadata.retryOfOperationId : null,
      deploymentAction: action, status: dispatchFailed ? "dispatch_failed" : operation.status,
      commitSha: operation.commitSha || null, generationId: operation.generationId || null, createdAt: operation.createdAt, startedAt: operation.startedAt,
      completedAt: operation.completedAt, failedAt: operation.failedAt, workflowRunId: operation.githubWorkflowRunId || null,
      workflowUrl: typeof metadata.workflowRunUrl === "string" ? metadata.workflowRunUrl : null, workflowStatus: operation.githubWorkflowStatus || null,
      stageLabel: dispatchFailed ? "Deployment could not start" : deployguardOperationStagePresentation(operation.currentStage, action).label,
      failedStageLabel: dispatchFailed ? deployguardOperationStagePresentation(metadata.failedStage || "dispatch", action).label : operation.status === PipelineRunStatus.FAILED ? deployguardOperationStagePresentation(metadata.failedStage || operation.currentStage, action).label : null,
      errorMessage: operation.errorMessage || null, githubRunCreated: Boolean(operation.githubWorkflowRunId),
      workflowStagesUnavailable: metadata.terminalWorkflowStagesUnavailable === true,
      failureOwner: operation.failureOwner || null, externalProvider: operation.externalProvider || null, failureCode: operation.failureCode || null, failureServiceId: operation.failureServiceId || null, failureServiceName,
      dispatchFailure: dispatchFailed, aiAnalysisEligible: dispatchFailed || (operation.status === PipelineRunStatus.FAILED && Boolean(operation.githubWorkflowRunId) && typeof metadata.safeLog === "string" && metadata.safeLog.trim().length > 0),
      safeLog: typeof metadata.safeLog === "string" ? metadata.safeLog : null,
      workflowStages: Array.isArray(metadata.workflowStages) ? metadata.workflowStages
        .filter((stage) => stage && typeof stage === "object" && githubActionsWorkflowStageRelevant((stage as Record<string, unknown>).key, action))
        .map((stage) => {
          const value = stage as Record<string, unknown>;
          const presentation = githubActionsWorkflowStepPresentation(value.key, action);
          return { ...value, label: presentation?.label || deployguardOperationStagePresentation(value.key, action).label };
        }) : [],
    };
  }

  private async runtimeConfiguration(project: Project, environmentName: string, operationId: string, sourceSha: string, action: "deploy" | "rollback" | "destroy", target: RollbackTargetIdentity | null): Promise<RailpackRuntimeConfiguration> {
    if (action !== "deploy") {
      if (!target?.services.length) throw new ServiceUnavailableException("The lifecycle target does not contain canonical service revisions.");
      const services = target.services.map((service) => ({
        serviceId: service.serviceId,
        serviceName: service.serviceName,
        serviceDirectory: service.serviceDirectory,
        servicePort: service.runtimeConfiguration.servicePort,
        runtimeConfigRevisionId: service.runtimeConfigRevisionId,
        buildEnvironment: {},
        buildSecretReferences: {},
        environment: { ...service.runtimeConfiguration.environment },
        secretReferences: { ...service.runtimeConfiguration.secretReferences },
        databaseAttached: service.runtimeConfiguration.databaseAttached,
        managedDatabase: { ...service.runtimeConfiguration.managedDatabase, aliases: [...service.runtimeConfiguration.managedDatabase.aliases] },
        rollbackImage: service.immutableImage,
      })).sort((a, b) => a.serviceId.localeCompare(b.serviceId));
      const projectDeletion = action === "destroy"
        ? { generationIds: (await this.dataSource.getRepository(ProjectDeploymentGeneration).find({ where: { projectId: project.id, environmentName } })).map((generation) => generation.id).sort() }
        : undefined;
      if (action === "destroy" && !projectDeletion?.generationIds.length) throw new ServiceUnavailableException("Destroy requires an exact persisted runtime generation.");
      return { schemaVersion: 3, projectId: project.id, environmentName, operationId, sourceSha, services, ...(projectDeletion ? { projectDeletion } : {}) };
    }
    const serviceRows = await this.deployableServices.find({ where: { projectId: project.id }, order: { position: "ASC" } });
    if (!serviceRows.length) throw new ServiceUnavailableException("The project has no configured deployable service.");
    const rows = await this.variables.createQueryBuilder("variable").addSelect("variable.value").where({ projectId: project.id, environment: environmentName, isActive: true }).getMany();
    const tier = await this.databaseTiers.findOne({ where: { projectId: project.id, provider: DatabaseTierProvider.MANAGED } });
    if (tier && (!tier.attachedServiceId || !serviceRows.some((service) => service.id === tier.attachedServiceId))) throw new ServiceUnavailableException("Managed database attachment does not reference a configured service.");
    if (tier && !isSupportedManagedDatabaseEngine(tier.engine)) throw new ServiceUnavailableException("The configured managed database engine is unsupported. Select PostgreSQL, MySQL, or MongoDB before deploying.");
    const engine = tier?.engine || null;
    const managedAliases = tier ? [
      ...aliasesFor(engine!, "host"), ...aliasesFor(engine!, "port"),
      ...aliasesFor(engine!, "username"), ...aliasesFor(engine!, "password"),
      ...aliasesFor(engine!, "database"), ...aliasesFor(engine!, "url"),
    ] : [];
    const services = [] as RailpackRuntimeConfiguration["services"];
    for (const service of serviceRows) {
      const servicePort = effectiveServicePort(service.servicePort);
      const databaseAttached = Boolean(tier && tier.attachedServiceId === service.id);
      const buildEnvironment: Record<string, string> = {};
      const environment: Record<string, string> = { PORT: String(servicePort), HOST: "0.0.0.0" };
      const allSecretValues: Record<string, string> = {};
      const buildSecretNames = new Set<string>();
      const runtimeSecretNames = new Set<string>();
      for (const row of rows.filter((variable) => variable.serviceId === service.id)) {
        if (["PORT", "HOST"].includes(row.key)) continue;
        if (databaseAttached && managedAliases.includes(row.key)) throw new ServiceUnavailableException(`${row.key} conflicts with the DeployGuard-managed database attached to ${service.name}. Remove the variable or disable the managed database before deployment.`);
        const value = this.crypto.decrypt(row.value);
        const scope = row.scope || "runtime";
        const build = scope === "build" || scope === "both";
        const runtime = scope === "runtime" || scope === "both";
        if (row.isSecret) {
          allSecretValues[row.key] = value;
          if (build) buildSecretNames.add(row.key);
          if (runtime) runtimeSecretNames.add(row.key);
        } else {
          if (build) buildEnvironment[row.key] = value;
          if (runtime) environment[row.key] = value;
        }
      }
      const secretValueDigests = Object.fromEntries(Object.keys(allSecretValues).sort().map((key) => [key, createHash("sha256").update(allSecretValues[key]).digest("hex")]));
      const databaseConfiguration = { attached: databaseAttached, engine: databaseAttached ? tier?.engine || null : null, aliases: databaseAttached ? [...new Set(managedAliases)].sort() : [] };
      const configurationFingerprint = createHash("sha256").update(JSON.stringify({ projectId: project.id, serviceId: service.id, environmentName, servicePort, buildEnvironment, environment, secretValueDigests, databaseConfiguration, platform: { PORT: String(servicePort), HOST: "0.0.0.0" } })).digest("hex");
      const materialized = await this.runtimeSecrets.materialize({ projectId: project.id, serviceId: service.id, generationId: operationId, environment: environmentName, configurationFingerprint, secretValues: allSecretValues });
      const materializedReferences = materialized?.valueFromByName || {};
      const buildSecretReferences = Object.fromEntries([...buildSecretNames].sort().map((name) => [name, materializedReferences[name]]));
      const secretReferences = Object.fromEntries([...runtimeSecretNames].sort().map((name) => [name, materializedReferences[name]]));
      const revision = await this.runtimeConfigRevisions.save(this.runtimeConfigRevisions.create({
        projectId: project.id,
        serviceId: service.id,
        createdByOperationId: operationId,
        environmentName,
        configurationFingerprint,
        nonSecretEnvironment: environment,
        secretReferences,
        secretVersionIds: materialized ? Object.fromEntries(materialized.secretNames.map((name) => [name, materialized.versionToken])) : {},
        databaseConfiguration,
        platformValues: { PORT: String(servicePort), HOST: "0.0.0.0" },
        isRollbackSafe: true,
        legacyBackfill: false,
        sealedAt: null,
      }));
      services.push({ serviceId: service.id, serviceName: service.name, serviceDirectory: service.serviceDirectory, servicePort, runtimeConfigRevisionId: revision.id, buildEnvironment, buildSecretReferences, environment, secretReferences, databaseAttached, managedDatabase: { engine: databaseAttached ? engine : null, aliases: databaseAttached ? [...new Set(managedAliases)].sort() : [] } });
    }
    return { schemaVersion: 3, projectId: project.id, environmentName, operationId, sourceSha, services: services.sort((a, b) => a.serviceId.localeCompare(b.serviceId)) };
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
        const workflowCompletedAt = typeof workflow.updated_at === "string" && Number.isFinite(Date.parse(workflow.updated_at)) ? new Date(workflow.updated_at) : new Date();
        operation.completedAt = workflowCompletedAt;
        const action = operation.metadata?.deploymentAction as "deploy" | "rollback" | "destroy" || "deploy";
        const terminalMetadata = await this.terminalWorkflowStages(project.repositoryFullName, operation.githubWorkflowRunId, credential.token, action, operation.metadata?.workflowStages);
        const terminalStages = terminalMetadata.stages;
        operation.metadata = {
          ...(operation.metadata || {}),
          ...(terminalStages.length ? { workflowStages: terminalStages } : {}),
          terminalWorkflowStagesUnavailable: terminalMetadata.unavailable,
          workflowUpdatedAt: new Date().toISOString(),
        };
        if (conclusion === "success") {
          let evidence: Record<string, unknown> | null;
          try {
            evidence = await this.releaseEvidence(project.repositoryFullName, operation, credential.token);
          } catch (error) {
            if (error instanceof TerminalReleaseEvidenceError) {
              await this.persistTerminalEvidenceFailure(operation, error);
              return operation;
            }
            throw error;
          }
          if (!evidence) {
            const pendingAttempts = Number(operation.metadata?.releaseEvidencePendingAttempts || 0) + 1;
            const persistedPendingSince = typeof operation.metadata?.releaseEvidencePendingSince === "string" ? operation.metadata.releaseEvidencePendingSince : new Date().toISOString();
            const pendingSinceMs = Date.parse(persistedPendingSince);
            if (pendingAttempts >= 3 && Number.isFinite(pendingSinceMs) && Date.now() - pendingSinceMs >= 2 * 60_000) {
              await this.persistTerminalEvidenceFailure(operation, new TerminalReleaseEvidenceError("The successful terminal workflow did not publish the required release result artifact after bounded reconciliation."));
              return operation;
            }
            operation.currentStage = "release_evidence_pending";
            operation.metadata = { ...(operation.metadata || {}), workflowConclusion: conclusion, workflowUpdatedAt: new Date().toISOString(), releaseEvidencePendingAttempts: pendingAttempts, releaseEvidencePendingSince: persistedPendingSince };
            await this.runs.save(operation);
            return operation;
          }
          try {
            await this.finalizeVerifiedRelease(project, operation, evidence, conclusion);
          } catch (error) {
            // GitHub has already completed and the operation-specific evidence
            // passed immutable validation. This is not a polling failure: keep
            // the release non-LIVE and persist a bounded control-plane failure
            // so the normal retry flow can recover it.
            await this.persistFinalizationFailure(operation, evidence, error);
            return operation;
          }
          // Successful exact-scope project deletion removes the project and
          // its operation records transactionally. Do not re-save a deleted
          // historical operation after that terminal lifecycle result.
          if (operation.metadata?.deploymentAction === "destroy" && operation.status === PipelineRunStatus.COMPLETED) return operation;
          if (operation.metadata?.deploymentAction !== "destroy") {
            await this.costEvidence.capture(operation, project.repositoryFullName, credential.token, canonicalEnvironmentName(project)).catch(() => null);
          }
        } else {
          const failureEvidence = await this.terminalFailureEvidence(project.repositoryFullName, operation.githubWorkflowRunId, operation.id, credential.token, action);
          const marker = terminalStructuredFailureMarker(failureEvidence?.safeLog || "");
          const failedStage = marker.stage || failureEvidence?.failedStage || "release_failed";
          operation.status = PipelineRunStatus.FAILED;
          operation.currentStage = failedStage;
          operation.errorMessage = failureEvidence?.safeLog || `GitHub Actions concluded: ${conclusion || "failure"}.`;
          const ownership = classifyStructuredFailure(failedStage, failureEvidence?.safeLog || "");
          operation.failureOwner = ownership.failureOwner; operation.externalProvider = ownership.externalProvider; operation.failureCode = ownership.failureCode; operation.failureServiceId = ownership.failureServiceId;
          operation.metadata = {
            ...(operation.metadata || {}), workflowConclusion: conclusion, workflowUpdatedAt: new Date().toISOString(),
            ...(failureEvidence ? { failedStage, safeLog: failureEvidence.safeLog, workflowStages: terminalStages.length ? terminalStages : failureEvidence.workflowStages, failureSource: "github_actions" } : terminalStages.length ? { failedStage, workflowStages: terminalStages, failureSource: "github_actions" } : {}),
          };
        }
      } else {
        // Job metadata is available while the workflow runs; logs remain
        // terminal-only. Do not erase persisted stages on an empty response.
        const stages = await this.actions.getWorkflowStages(project.repositoryFullName, operation.githubWorkflowRunId, credential.token, operation.metadata?.deploymentAction as "deploy" | "rollback" | "destroy" || "deploy");
        if (stages.length) {
          const activeStage = stages.find((item) => item.status === "running") || stages.find((item) => item.status === "failed");
          operation.currentStage = activeStage?.key || operation.currentStage;
          operation.metadata = { ...(operation.metadata || {}), workflowStages: stages, workflowUpdatedAt: new Date().toISOString() };
        }
      }
      await this.runs.save(operation);
    } catch {
      // Polling is best-effort; do not convert a running release into failure
      // solely because GitHub status was temporarily unavailable.
    }
    return operation;
  }

  private async persistFinalizationFailure(operation: ProjectPipelineRun, evidence: Record<string, unknown>, error: unknown) {
    const detail = this.sanitizer.sanitize(error instanceof Error ? error.message : "Unknown release finalization error")
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .trim()
      .slice(0, 2_000);
    operation.status = PipelineRunStatus.FAILED;
    operation.currentStage = "release_finalization";
    operation.failedAt = new Date();
    operation.errorMessage = "DeployGuard could not finalize the verified release.";
    operation.failureOwner = "DEPLOYGUARD_PLATFORM"; operation.externalProvider = null; operation.failureCode = "DG_RELEASE_FINALIZATION_FAILED"; operation.failureServiceId = null;
    operation.metadata = {
      ...(operation.metadata || {}),
      ...evidence,
      workflowConclusion: "success",
      workflowUpdatedAt: new Date().toISOString(),
      releaseEvidenceValidated: true,
      failedStage: "release_finalization",
      failureSource: "deployguard_reconciliation",
      failureCategory: "release_finalization",
      safeLog: detail || "DeployGuard could not finalize the verified release.",
    };
    await this.runs.save(operation);
  }

  private async persistTerminalEvidenceFailure(operation: ProjectPipelineRun, error: unknown) {
    const detail = this.sanitizer.sanitize(error instanceof Error ? error.message : "Incompatible terminal release evidence.")
      .replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 2_000);
    operation.status = PipelineRunStatus.FAILED;
    operation.currentStage = "release_evidence_validation";
    operation.failedAt = new Date();
    operation.completedAt = operation.completedAt || operation.failedAt;
    operation.errorMessage = "DeployGuard rejected incompatible terminal release evidence.";
    operation.failureOwner = "DEPLOYGUARD_PLATFORM"; operation.externalProvider = null; operation.failureCode = "DG_WORKFLOW_CONTRACT_INVALID"; operation.failureServiceId = null;
    operation.metadata = {
      ...(operation.metadata || {}), workflowConclusion: "success", workflowUpdatedAt: new Date().toISOString(),
      failedStage: "release_evidence_validation", failureSource: "deployguard_reconciliation",
      failureCategory: "release_contract_incompatible", safeLog: detail || "The terminal result did not match the expected immutable release contract.",
    };
    await this.runs.save(operation);
  }

  private async terminalFailureEvidence(repositoryFullName: string, workflowRunId: string, operationId: string, token: string, action: "deploy" | "rollback" | "destroy") {
    try {
      const evidence = await this.actions.getTerminalFailureEvidence(repositoryFullName, workflowRunId, operationId, token, action);
      if (!evidence) return null;
      const safeLog = this.sanitizer.sanitize(evidence.rawEvidence).replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 12_000);
      if (!safeLog) return null;
      return { ...evidence, safeLog };
    } catch {
      // A terminal GitHub conclusion remains persisted, but troubleshooting is
      // intentionally unavailable unless bounded job/log evidence was read.
      return null;
    }
  }

  private async terminalWorkflowStages(repositoryFullName: string, workflowRunId: string, token: string, action: "deploy" | "rollback" | "destroy", existing: unknown) {
    let observed: Awaited<ReturnType<GithubActionsService["getWorkflowStages"]>> = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const stages = await this.actions.getWorkflowStages(repositoryFullName, workflowRunId, token, action);
        if (stages.length) observed = stages;
        if (observed.length && !observed.some((stage) => stage.status === "running" || stage.status === "pending")) {
          return { stages: observed, unavailable: false };
        }
      } catch {
        // GitHub may report the run terminal before the final jobs snapshot is
        // indexed. The bounded retries below never affect release evidence.
      }
      if (attempt < 2) {
        const configured = Number(this.config?.get?.("DEPLOYGUARD_TERMINAL_STAGE_RETRY_DELAY_MS", 250) ?? 250);
        const delay = Number.isFinite(configured) ? Math.max(0, Math.min(configured, 2_000)) : 250;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    const fallback = observed.length ? observed : Array.isArray(existing) ? existing : [];
    return {
      stages: fallback.map((stage) => {
        if (!stage || typeof stage !== "object") return stage;
        const value = stage as Record<string, unknown>;
        return value.status === "running" || value.status === "pending"
          ? { ...value, status: "unavailable", failureReason: value.failureReason || "Final GitHub Actions step status is temporarily unavailable." }
          : value;
      }) as Awaited<ReturnType<GithubActionsService["getWorkflowStages"]>>,
      unavailable: true,
    };
  }

  private async reconcileTerminalWorkflowStages(operation: ProjectPipelineRun) {
    if (!operation.githubWorkflowRunId || ACTIVE.includes(operation.status)) return;
    const existing = Array.isArray(operation.metadata?.workflowStages) ? operation.metadata.workflowStages as Array<Record<string, unknown>> : [];
    if (operation.metadata?.terminalWorkflowStagesUnavailable !== true && existing.length && !existing.some((stage) => stage.status === "running" || stage.status === "pending" || stage.status === "unavailable")) return;
    const [project, user] = await Promise.all([
      this.projects.findOne({ where: { id: operation.projectId } }),
      this.users.findOne({ where: { id: operation.triggeredByUserId } }),
    ]);
    if (!project?.repositoryFullName || !user) return;
    try {
      const credential = await this.githubApp.tokenForRepository(user.id, project.repositoryFullName, project.githubInstallationId);
      const action = operation.metadata?.deploymentAction as "deploy" | "rollback" | "destroy" || "deploy";
      const result = await this.terminalWorkflowStages(project.repositoryFullName, operation.githubWorkflowRunId, credential.token, action, existing);
      operation.metadata = { ...(operation.metadata || {}), ...(result.stages.length ? { workflowStages: result.stages } : {}), terminalWorkflowStagesUnavailable: result.unavailable, workflowUpdatedAt: new Date().toISOString() };
      await this.runs.save(operation);
    } catch {
      // This is a read-only presentation backfill. Terminal operation state and
      // immutable release evidence remain authoritative when GitHub is absent.
    }
  }

  private async releaseEvidence(repositoryFullName: string, operation: ProjectPipelineRun, token: string): Promise<Record<string, unknown> | null> {
    const raw = await this.actions.getResultArtifact(repositoryFullName, operation.githubWorkflowRunId, operation.id, token);
    if (!raw) return null;
    let artifact: Record<string, unknown>;
    try {
      artifact = JSON.parse(raw) as Record<string, unknown>;
      return this.validatedReleaseEvidence(operation, artifact);
    } catch (error) {
      throw new TerminalReleaseEvidenceError(error instanceof Error ? error.message : "The release result artifact is invalid.");
    }
  }

  private validatedReleaseEvidence(operation: ProjectPipelineRun, artifact: Record<string, unknown>): Record<string, unknown> {
    const action = String(artifact.action || "");
    const sourceSha = String(artifact.sourceSha || "");
    const operationId = String(artifact.operationId || "");
    const expectedAction = String(operation.metadata?.deploymentAction || "");
    if (artifact.contractVersion !== RAILPACK_RESULT_CONTRACT_VERSION) throw new Error(`The release result artifact does not implement ${RAILPACK_RESULT_CONTRACT_VERSION}.`);
    if (action !== expectedAction || sourceSha !== operation.commitSha || operationId !== operation.id) throw new Error("The release result artifact does not match its immutable operation identity.");
    if (action === "destroy") {
      if (artifact.destroyed !== true) throw new Error("The destroy result artifact does not prove deletion.");
      const destroyVerification = githubActionsDestroyEvidenceFromValue(artifact.destroyVerification);
      if (!destroyVerification) throw new Error("The destroy result artifact does not contain exact-scope deletion evidence.");
      return { releaseArtifact: artifact, destroyed: true, destroyVerification };
    }
    if (!artifact.terraform || typeof artifact.terraform !== "object" || !Array.isArray(artifact.services) || !artifact.services.length) throw new Error("The release result artifact does not prove the complete service runtime.");
    const awsRuntimeVerification = artifact.awsRuntimeVerification as Record<string, unknown> | null;
    if (!awsRuntimeVerification || awsRuntimeVerification.contractVersion !== "deployguard.aws-runtime-verification/v1" || awsRuntimeVerification.verified !== true || !Array.isArray(awsRuntimeVerification.services)) {
      throw new Error("The release result artifact does not contain verified AWS runtime evidence.");
    }
    const terraform = artifact.terraform as Record<string, unknown>;
    const terraformServices = terraform.services && typeof terraform.services === "object" ? terraform.services as Record<string, Record<string, unknown>> : {};
    const encoded = (operation.metadata?.immutableDispatchInputs as Record<string, unknown> | undefined)?.services_base64;
    if (typeof encoded !== "string") throw new Error("The operation does not retain its immutable service contract.");
    const expected = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as RailpackRuntimeConfiguration;
    assertRailpackRuntimeConfiguration(expected);
    const expectedById = new Map(expected.services.map((service) => [service.serviceId, service]));
    const intendedServices = artifact.services.map((value) => {
      if (!value || typeof value !== "object") throw new Error("Release service evidence is malformed.");
      const item = value as Record<string, unknown>; const expectedService = expectedById.get(String(item.serviceId || ""));
      const imageUri = String(item.imageUri || ""); const imageDigest = String(item.imageDigest || ""); const image = String(item.image || "");
      const runtime = terraformServices[String(item.serviceId || "")];
      if (!expectedService || String(item.runtimeConfigRevisionId || "") !== expectedService.runtimeConfigRevisionId || String(item.serviceName || "") !== expectedService.serviceName || String(item.serviceDirectory || "") !== expectedService.serviceDirectory || Number(item.servicePort) !== expectedService.servicePort || image !== `${imageUri}@${imageDigest}` || !/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._\/-]*$/i.test(imageUri) || !/^sha256:[0-9a-f]{64}$/.test(imageDigest) || !runtime || runtime.image !== image || runtime.runtime_config_revision_id !== expectedService.runtimeConfigRevisionId || Number(runtime.service_port) !== expectedService.servicePort || typeof runtime.public_url !== "string" || typeof runtime.task_definition_arn !== "string" || typeof runtime.ecs_service_arn !== "string" || runtime.transport_probe_container_name !== "deployguard-transport-probe" || !Number.isInteger(Number(runtime.transport_probe_port)) || runtime.platform_health_check_path !== DEPLOYGUARD_PLATFORM_HEALTH_CHECK_PATH) throw new Error("Release service evidence does not match its immutable service contract and Terraform runtime.");
      return { serviceId: expectedService.serviceId, serviceName: expectedService.serviceName, serviceDirectory: expectedService.serviceDirectory, servicePort: expectedService.servicePort, sourceSha, runtimeConfigRevisionId: expectedService.runtimeConfigRevisionId, imageUri, imageDigest, image, publicUrl: runtime.public_url, taskDefinitionArn: runtime.task_definition_arn, ecsServiceArn: runtime.ecs_service_arn, ecsServiceName: runtime.ecs_service_name, albArn: runtime.alb_arn, albName: runtime.alb_name, targetGroupArn: runtime.alb_target_group_arn, targetGroupName: runtime.alb_target_group_name, cloudWatchLogGroupName: runtime.cloudwatch_log_group_name, applicationContainerName: runtime.application_container_name, transportProbeContainerName: runtime.transport_probe_container_name, transportProbePort: Number(runtime.transport_probe_port), platformHealthCheckPath: runtime.platform_health_check_path };
    });
    if (intendedServices.length !== expected.services.length || new Set(intendedServices.map((service) => service.serviceId)).size !== expected.services.length) {
      throw new Error("Release result does not contain the complete immutable service set.");
    }
    const runtimeOutcomes = awsRuntimeVerification.services as Array<Record<string, unknown>>;
    const outcomeServiceIds = runtimeOutcomes.map((service) => String(service?.serviceId || ""));
    if (outcomeServiceIds.length !== intendedServices.length || new Set(outcomeServiceIds).size !== intendedServices.length || intendedServices.some((service) => !outcomeServiceIds.includes(service.serviceId))) {
      throw new Error("AWS runtime verification does not cover the complete immutable service set.");
    }
    const database = terraform.database && typeof terraform.database === "object" ? terraform.database as Record<string, unknown> : null;
    const attached = expected.services.find((service) => service.databaseAttached);
    if (awsRuntimeVerification.databaseVerified !== Boolean(attached)) throw new Error("AWS runtime verification does not match the immutable managed database contract.");
    const equalObject = (left: unknown, right: unknown) => JSON.stringify(Object.entries(left && typeof left === "object" && !Array.isArray(left) ? left as Record<string, unknown> : {}).sort()) === JSON.stringify(Object.entries(right && typeof right === "object" && !Array.isArray(right) ? right as Record<string, unknown> : {}).sort());
    for (const outcome of runtimeOutcomes) {
      const intended = intendedServices.find((service) => service.serviceId === String(outcome.serviceId || ""));
      const expectedService = expectedById.get(String(outcome.serviceId || ""));
      const runtime = terraformServices[String(outcome.serviceId || "")];
      if (outcome.verified !== true || !intended || !expectedService || !runtime) throw new Error("AWS runtime verification contains a failed or unknown service outcome.");
      const observedEnvironment = outcome.environment && typeof outcome.environment === "object" ? outcome.environment as Record<string, unknown> : null;
      const expectedEnvironment: Record<string, unknown> = { ...expectedService.environment };
      const expectedSecrets: Record<string, unknown> = { ...expectedService.secretReferences };
      const aliases = expectedService.databaseAttached ? expectedService.managedDatabase.aliases : [];
      for (const key of aliases) {
        if (/(PASSWORD|URL|URI)$/.test(key)) {
          const field = /^(DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL|MYSQL_URL|MONGO_URI|MONGO_URL|MONGODB_URI)$/.test(key) ? "url" : "password";
          expectedSecrets[key] = `${String(database?.credentials_secret_arn || "")}:${field}::${String(database?.secret_version_id || "")}`;
        } else if (/^(DB_HOST|DATABASE_HOST|POSTGRES_HOST|PGHOST|MYSQL_HOST|MONGO_HOST|MONGODB_HOST)$/.test(key)) expectedEnvironment[key] = database?.host;
        else if (/^(DB_PORT|DATABASE_PORT|POSTGRES_PORT|PGPORT|MYSQL_PORT|MONGO_PORT|MONGODB_PORT)$/.test(key)) expectedEnvironment[key] = String(database?.port || "");
        else if (/^(DB_USER|DATABASE_USER|POSTGRES_USER|PGUSER|MYSQL_USER|MONGO_USER|MONGODB_USER)$/.test(key)) expectedEnvironment[key] = "deployguard";
        else expectedEnvironment[key] = "application";
      }
      const expectedManagedDatabase = expectedService.databaseAttached ? { attached: true, attachedServiceId: expectedService.serviceId, engine: expectedService.managedDatabase.engine, aliases, credentialsSecretArn: database?.credentials_secret_arn, secretVersionId: database?.secret_version_id } : { attached: false, attachedServiceId: null, engine: null, aliases: [], credentialsSecretArn: null, secretVersionId: null };
      const runningTaskArns = Array.isArray(outcome.runningTaskArns) ? outcome.runningTaskArns : [];
      const targetHealth = Array.isArray(outcome.targetHealth) ? outcome.targetHealth : [];
      if (outcome.image !== intended.image || outcome.ecsServiceArn !== intended.ecsServiceArn || outcome.taskDefinitionArn !== intended.taskDefinitionArn || !runningTaskArns.length || Number(outcome.ecsTasksRunning) !== runningTaskArns.length || Number(outcome.runtimePort) !== intended.servicePort || outcome.readinessMode !== "platform_transport" || Number(outcome.transportProbePort) !== intended.transportProbePort || outcome.platformHealthCheckPath !== intended.platformHealthCheckPath || outcome.targetGroupArn !== intended.targetGroupArn || !targetHealth.length || targetHealth.some((state) => state !== "healthy") || !equalObject(observedEnvironment, expectedEnvironment) || !equalObject(outcome.secretValueFrom, expectedSecrets) || !equalObject(outcome.managedDatabase, expectedManagedDatabase) || outcome.publicUrl !== intended.publicUrl || outcome.publicEndpointVerified !== true || outcome.taskDefinition !== true || outcome.secretsInjection !== true || outcome.vpcConnectivity !== true || outcome.publicReachability !== true || typeof outcome.checkedAt !== "string") throw new Error("AWS runtime verification does not match the complete immutable per-service runtime contract.");
    }
    const services = intendedServices;
    if ((attached && (!database || database.attached_service_id !== attached.serviceId || database.engine !== attached.managedDatabase.engine || typeof database.secret_version_id !== "string" || !database.secret_version_id)) || (!attached && database !== null)) {
      throw new Error("Release result does not match the independent managed database runtime contract.");
    }
    return { releaseArtifact: artifact, services, intendedServices, serviceOutcomes: runtimeOutcomes, terraform, awsRuntimeVerification };
  }

  private async reconcileCompletedRelease(operation: ProjectPipelineRun) {
    const action = String(operation.metadata?.deploymentAction || "");
    if (!["deploy", "rollback"].includes(action) || (operation.generationId && operation.metadata?.releaseEvidenceVerified === true)) return;
    const artifact = operation.metadata?.releaseArtifact;
    if (!artifact || typeof artifact !== "object") return;
    const project = await this.projects.findOne({ where: { id: operation.projectId } });
    if (!project) return;
    try {
      await this.finalizeVerifiedRelease(project, operation, this.validatedReleaseEvidence(operation, artifact as Record<string, unknown>), String(operation.metadata?.workflowConclusion || "success"));
    } catch {
      // A historical row cannot become LIVE unless its persisted immutable
      // evidence still validates. Leave it non-authoritative for inspection.
    }
  }

  /**
   * Cost evidence is a read-only, retryable projection of an already verified
   * release. It can backfill a LIVE release after a control-plane upgrade and
   * can never promote or fail the deployment itself.
   */
  private async reconcileCostEvidence(operation: ProjectPipelineRun) {
    const action = String(operation.metadata?.deploymentAction || "");
    if (!operation.generationId
      || operation.metadata?.releaseEvidenceVerified !== true
      || !["deploy", "rollback"].includes(action)) return;
    const [project, user] = await Promise.all([
      this.projects.findOne({ where: { id: operation.projectId } }),
      this.users.findOne({ where: { id: operation.triggeredByUserId } }),
    ]);
    if (!project?.repositoryFullName || !user) return;
    try {
      const credential = await this.githubApp.tokenForRepository(user.id, project.repositoryFullName, project.githubInstallationId);
      await this.costEvidence.capture(operation, project.repositoryFullName, credential.token, canonicalEnvironmentName(project));
    } catch {
      // Pricing failure is persisted by the cost evidence service when it can
      // be classified. It must never invalidate the authoritative LIVE release.
    }
  }

  /**
   * A release is LIVE only after one validated immutable artifact atomically
   * establishes the operation, runtime generation, route, and stable-release
   * projection. The workflow's curl verification is represented by the
   * validated artifact, never inferred from its GitHub conclusion alone.
   */
  private async finalizeVerifiedRelease(project: Project, operation: ProjectPipelineRun, evidence: Record<string, unknown>, workflowConclusion: string) {
    const action = String(operation.metadata?.deploymentAction || "");
    if (action === "destroy") return this.finalizeVerifiedDestroy(project, operation, evidence, workflowConclusion);
    if (!["deploy", "rollback"].includes(action)) return operation;
    const artifact = evidence.releaseArtifact;
    if (!artifact || typeof artifact !== "object") throw new Error("Validated release evidence is missing its immutable artifact.");
    await this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`railpack-release-finalization:${project.id}:${canonicalEnvironmentName(project)}`]);
      const operations = manager.getRepository(ProjectPipelineRun);
      const current = await operations.findOne({ where: { id: operation.id, projectId: project.id } });
      if (!current) throw new Error("Release operation disappeared before finalization.");
      const immutable = this.validatedReleaseEvidence(current, artifact as Record<string, unknown>);
      const environmentName = canonicalEnvironmentName(project);
      const verifiedCandidateServices = (immutable.services as Array<Record<string, unknown>>)
        .slice().sort((a, b) => String(a.serviceId).localeCompare(String(b.serviceId)));
      const serviceOutcomes = immutable.serviceOutcomes as Array<Record<string, unknown>>;
      const expectedServiceIds = (immutable.intendedServices as Array<Record<string, unknown>>).map((service) => String(service.serviceId));
      const generationId = current.generationId || current.id;
      const generations = manager.getRepository(ProjectDeploymentGeneration);
      const promotedServiceIds = new Set(verifiedCandidateServices.map((service) => String(service.serviceId)));
      if (!verifiedCandidateServices.length) throw new Error("No service passed terminal AWS reconciliation; no release can be promoted.");
      const runtimeIdentity = this.runtimeIdentity(project, environmentName, { ...immutable, services: verifiedCandidateServices });
      let generation = await generations.findOne({ where: { id: generationId } });
      if (generation && (generation.projectId !== project.id || generation.environmentName !== environmentName)) {
        throw new Error("Release generation identity conflicts with another project environment.");
      }
      if (!generation) {
        const maximum = await generations.createQueryBuilder("generation")
          .select("COALESCE(MAX(generation.ordinal), 0)", "maximum")
          .where("generation.projectId = :projectId", { projectId: project.id })
          .andWhere("generation.environmentName = :environmentName", { environmentName })
          .getRawOne<{ maximum: string | number }>();
        generation = generations.create({
          id: generationId,
          projectId: project.id,
          environmentName,
          ordinal: Number(maximum?.maximum || 0) + 1,
          candidateListenerPriority: null,
          status: DeploymentGenerationStatus.LIVE,
          terraformStateKey: `projects/${project.id}/${environmentName}/runtime/terraform.tfstate`,
          resourceManifest: {
            ...runtimeIdentity,
          },
          cleanupMetadata: {},
          createdByOperationId: current.id,
          retiredByOperationId: null,
          activatedAt: new Date(),
          retiredAt: null,
          failedAt: null,
          cleanedAt: null,
          metadata: { executionEngine: "railpack", serviceOutcomes, releaseOperationId: current.id },
        });
      } else {
        generation.status = DeploymentGenerationStatus.LIVE;
        generation.activatedAt = generation.activatedAt || new Date();
        generation.resourceManifest = { ...generation.resourceManifest, ...runtimeIdentity };
        generation.metadata = { ...generation.metadata, executionEngine: "railpack", serviceOutcomes, releaseOperationId: current.id };
      }
      const previous = await generations.find({ where: { projectId: project.id, environmentName, status: DeploymentGenerationStatus.LIVE } });
      for (const existing of previous) {
        if (existing.id === generation.id) continue;
        existing.status = DeploymentGenerationStatus.RETIRED;
        existing.retiredByOperationId = current.id;
        existing.retiredAt = new Date();
        await generations.save(existing);
      }
      await generations.save(generation);

      const immutableServices = verifiedCandidateServices;
      const endpointProject = await manager.getRepository(Project).findOne({ where: { id: project.id } });
      if (!endpointProject) throw new Error("Project application-entrypoint authority disappeared before release finalization.");
      const applicationEntryPointServiceId = endpointProject.applicationEntryPointServiceId;
      const runtimeConfigIds = immutableServices.map((service) => String(service.runtimeConfigRevisionId));
      const runtimeConfigs = await manager.getRepository(ProjectServiceRuntimeConfigRevision).find({ where: { id: In(runtimeConfigIds) } });
      const runtimeConfigById = new Map(runtimeConfigs.map((revision) => [revision.id, revision]));
      const databaseRuntime = (immutable.terraform as Record<string, unknown>)?.database as Record<string, unknown> | null;
      if (runtimeConfigs.length !== immutableServices.length) throw new Error("Release runtime-configuration revision set is incomplete.");
      for (const service of immutableServices) {
        const revision = runtimeConfigById.get(String(service.runtimeConfigRevisionId));
        if (!revision || revision.projectId !== project.id || revision.serviceId !== service.serviceId || !revision.isRollbackSafe || (action === "deploy" && revision.createdByOperationId !== current.id) || (action === "rollback" && !revision.sealedAt)) throw new Error("Release runtime-configuration ownership is invalid.");
        if (revision.databaseConfiguration.attached === true) {
          if (!databaseRuntime || databaseRuntime.attached_service_id !== revision.serviceId || typeof databaseRuntime.secret_version_id !== "string") throw new Error("Independent database runtime identity is incomplete.");
          revision.databaseConfiguration = { ...revision.databaseConfiguration, secretArn: databaseRuntime.credentials_secret_arn, secretVersionId: databaseRuntime.secret_version_id, runtimeIdentity: databaseRuntime };
        }
        revision.sealedAt = revision.sealedAt || new Date();
        await manager.getRepository(ProjectServiceRuntimeConfigRevision).save(revision);
      }
      if (databaseRuntime && promotedServiceIds.has(String(databaseRuntime.attached_service_id))) {
        const tier = await manager.getRepository(ProjectDatabaseTier).findOne({ where: { projectId: project.id, provider: DatabaseTierProvider.MANAGED } });
        if (!tier || tier.engine !== databaseRuntime.engine) throw new Error("Persisted managed database ownership does not match the verified independent runtime.");
        tier.attachedServiceId = String(databaseRuntime.attached_service_id);
        tier.activeGenerationId = generation.id;
        tier.status = DatabaseTierStatus.READY;
        tier.internalHost = String(databaseRuntime.host || "");
        tier.efsFileSystemId = String(databaseRuntime.efs_file_system_id || "");
        tier.efsAccessPointId = String(databaseRuntime.efs_access_point_id || "");
        tier.credentialsSecretArn = String(databaseRuntime.credentials_secret_arn || "");
        tier.databaseUrlSecretArn = String(databaseRuntime.credentials_secret_arn || "");
        tier.lastError = null;
        await manager.getRepository(ProjectDatabaseTier).save(tier);
      }
      const generationRevisions = manager.getRepository(ProjectGenerationServiceRevision);
      const existingGenerationRevisions = await generationRevisions.find({ where: { generationId: generation.id } });
      if (existingGenerationRevisions.length) {
        const expectedByService = new Map(immutableServices.map((service) => [String(service.serviceId), service]));
        if (existingGenerationRevisions.length !== immutableServices.length || existingGenerationRevisions.some((revision) => {
          const expected = expectedByService.get(revision.serviceId);
          return !expected || revision.projectId !== project.id || revision.sourceSha !== current.commitSha || revision.imageUri !== expected.imageUri || revision.imageDigest !== expected.imageDigest || revision.runtimeConfigRevisionId !== expected.runtimeConfigRevisionId;
        })) throw new Error("Generation service revision set conflicts with immutable release evidence.");
      }
      if (!existingGenerationRevisions.length) {
        const candidateRevisions = immutableServices.map((service) => generationRevisions.create({
          projectId: project.id,
          generationId: generation.id,
          serviceId: String(service.serviceId),
          serviceName: String(service.serviceName),
          serviceDirectory: String(service.serviceDirectory),
          sourceSha: current.commitSha || "",
          imageUri: String(service.imageUri),
          imageDigest: String(service.imageDigest),
          runtimeConfigRevisionId: String(service.runtimeConfigRevisionId),
          runtimeIdentity: service,
        }));
        await generationRevisions.save(promotedServiceRevisions(candidateRevisions, expectedServiceIds));
      }
      const reconciledRevisions = await generationRevisions.find({ where: { generationId: generation.id } });
      const reconciledServices = reconciledRevisions.map((revision) => revision.runtimeIdentity);
      const applicationEndpoint = reconciledServices.find((service) => String(service.serviceId) === applicationEntryPointServiceId);
      const deployedUrl = applicationEndpoint && typeof applicationEndpoint.publicUrl === "string" && /^https?:\/\//i.test(applicationEndpoint.publicUrl) ? applicationEndpoint.publicUrl : null;
      generation.metadata = {
        ...generation.metadata,
        serviceRevisionIds: reconciledRevisions.map((revision) => revision.id).sort(),
        runtimeConfigRevisionIds: reconciledRevisions.map((revision) => revision.runtimeConfigRevisionId).sort(),
        serviceImageDigests: reconciledRevisions.map((revision) => ({ serviceId: revision.serviceId, imageDigest: revision.imageDigest })),
      };
      await generations.save(generation);

      const routes = manager.getRepository(ProjectEnvironmentRoute);
      let route = await routes.findOne({ where: { projectId: project.id, environmentName } });
      if (!route) {
        await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["deployguard-listener-priority-allocation"]);
        const used = new Set((await routes.find({ select: { listenerPriority: true } })).map((item) => item.listenerPriority));
        let listenerPriority = 1000;
        while (used.has(listenerPriority)) listenerPriority += 1;
        route = routes.create({ projectId: project.id, environmentName, listenerPriority, listenerRuleArn: null, liveGenerationId: null, candidateGenerationId: null, metadata: { allocation: "railpack-release-finalization" } });
      }
      route.liveGenerationId = generation.id;
      route.candidateGenerationId = null;
      route.metadata = { ...route.metadata, lastPromotionOperationId: current.id, runtimeIdentity };
      await routes.save(route);

      await materializeStableRelease(manager, {
        projectId: project.id,
        generationId: generation.id,
        environmentName,
        operationId: current.id,
        commitSha: current.commitSha || "",
        healthCheckPath: DEPLOYGUARD_PLATFORM_HEALTH_CHECK_PATH,
        appPort: effectiveServicePort(applicationEndpoint?.servicePort ?? DEPLOYGUARD_DEFAULT_SERVICE_PORT),
        metadata: { deployedUrl, publicUrls: Object.fromEntries(reconciledServices.map((service) => [String(service.serviceId), service.publicUrl])), services: reconciledServices, serviceOutcomes, releaseEvidenceVerified: true, deploymentAction: action, runtimeIdentity },
      });
      current.generationId = generation.id;
      current.status = PipelineRunStatus.COMPLETED;
      current.currentStage = verifiedCandidateServices.length === expectedServiceIds.length ? "release_complete" : "release_partial";
      current.errorMessage = null;
      current.failureOwner = null; current.externalProvider = null; current.failureCode = null; current.failureServiceId = null;
      current.completedAt = current.completedAt || new Date();
      current.metadata = { ...(current.metadata || {}), workflowConclusion, workflowUpdatedAt: new Date().toISOString(), ...immutable, deployedUrl, publicUrls: Object.fromEntries(reconciledServices.map((service) => [String(service.serviceId), service.publicUrl])), releaseEvidenceVerified: true, runtimeIdentity };
      await operations.save(current);
      Object.assign(operation, current);
    });
    return operation;
  }

  /** Destroy has its own exact-scope finalizer; it never promotes a release. */
  private async finalizeVerifiedDestroy(project: Project, operation: ProjectPipelineRun, evidence: Record<string, unknown>, workflowConclusion: string) {
    const verification = githubActionsDestroyEvidenceFromValue(evidence.destroyVerification);
    if (!verification
      || verification.deploymentOperationId !== operation.id
      || verification.projectId !== project.id
      || verification.environmentName !== canonicalEnvironmentName(project)
      || !operation.generationId
      || !verification.generationIds.includes(operation.generationId)) {
      throw new Error("Validated destroy evidence does not match the exact project, environment, and generation scope.");
    }
    operation.status = PipelineRunStatus.COMPLETED;
    operation.currentStage = "project_delete_cleanup";
    operation.completedAt = operation.completedAt || new Date();
    operation.errorMessage = null;
    operation.metadata = {
      ...(operation.metadata || {}),
      ...evidence,
      destroyVerification: verification,
      workflowConclusion,
      workflowUpdatedAt: new Date().toISOString(),
      destroyEvidenceValidated: true,
    };
    await this.runs.save(operation);
    try {
      await this.projectDeletion.finalize(project, operation);
    } catch (error) {
      await this.persistDestroyCleanupFailure(operation, verification, error);
    }
    return operation;
  }

  private verifiedDestroyEvidence(operation: ProjectPipelineRun, project: Project) {
    const verification = githubActionsDestroyEvidenceFromValue(operation.metadata?.destroyVerification);
    return verification
      && verification.deploymentOperationId === operation.id
      && verification.projectId === project.id
      && verification.environmentName === canonicalEnvironmentName(project)
      && Boolean(operation.generationId)
      && verification.generationIds.includes(operation.generationId!)
      ? verification
      : null;
  }

  private async persistDestroyCleanupFailure(operation: ProjectPipelineRun, verification: Record<string, unknown>, error: unknown) {
    const detail = this.sanitizer.sanitize(error instanceof Error ? error.message : "Unknown project deletion cleanup error")
      .replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 2_000);
    operation.status = PipelineRunStatus.FAILED;
    operation.currentStage = "project_delete_cleanup";
    operation.failedAt = new Date();
    operation.errorMessage = "DeployGuard could not complete verified project deletion cleanup.";
    operation.metadata = {
      ...(operation.metadata || {}),
      destroyVerification: verification,
      destroyEvidenceValidated: true,
      workflowConclusion: "success",
      failedStage: "project_delete_cleanup",
      failureSource: "deployguard_reconciliation",
      failureCategory: "project_delete_incomplete",
      safeLog: detail || "DeployGuard could not complete verified project deletion cleanup.",
    };
    await this.runs.save(operation);
  }

  private runtimeIdentity(project: Project, environmentName: string, evidence: Record<string, unknown>) {
    const artifact = evidence.releaseArtifact as Record<string, unknown>;
    const terraform = artifact.terraform as Record<string, unknown>;
    const optional = (key: string) => typeof terraform?.[key] === "string" && terraform[key] ? terraform[key] : null;
    const region = optional("aws_region");
    const ecsClusterArn = optional("ecs_cluster_arn");
    const ecsClusterName = optional("ecs_cluster_name");
    const rawServices = evidence.services as Array<Record<string, unknown>>;
    const services: Array<Record<string, unknown>> = rawServices.slice().sort((a, b) => String(a.serviceId).localeCompare(String(b.serviceId))).map((service) => ({
      ...service,
      region,
      ecsClusterArn,
      ecsClusterName,
    }));
    return {
      region,
      ecsClusterArn,
      ecsClusterName,
      services,
      serviceIds: services.map((service) => service.serviceId),
      publicUrls: Object.fromEntries(services.map((service) => [String(service.serviceId), service.publicUrl])),
      terraformStateKey: `projects/${project.id}/${environmentName}/runtime/terraform.tfstate`,
      databaseEfsFileSystemId: optional("database_efs_file_system_id"),
      databaseEfsAccessPointId: optional("database_efs_access_point_id"),
      database: terraform?.database && typeof terraform.database === "object" ? terraform.database : null,
    };
  }

  private required(key: string) { const value = this.config.get<string>(key, "").trim(); if (!value) throw new ServiceUnavailableException(`Platform configuration is missing: ${key}.`); return value; }
  private controlPlaneSha() { const match = this.required("DEPLOYGUARD_REUSABLE_WORKFLOW").match(/@([0-9a-f]{40})$/); if (!match) throw new ServiceUnavailableException("DeployGuard reusable workflow must be pinned to an exact control-plane SHA."); return match[1]; }
  private async project(user: User, projectId: string) { const project = await this.projects.findOne({ where: { id: projectId } }); if (!project) throw new NotFoundException("Project not found."); if (project.ownerUserId !== user.id) throw new ForbiddenException("Project operations are restricted to the project owner."); if (!project.repositoryFullName) throw new ServiceUnavailableException("Project repository identity is unavailable."); return project; }
}
