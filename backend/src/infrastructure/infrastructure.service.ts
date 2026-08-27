import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { Request } from "express";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
import { In, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { envBoolean } from "../config/env-parsing";
import { analysisFingerprint } from "../projects/analysis-fingerprint";
import { serviceAlias } from "../projects/configuration-ownership";
import { CostEstimateStatus, ProjectCostEstimate } from "../finops/project-cost-estimate.entity";
import { getFinopsConfig } from "../finops/finops.config";
import { ProjectDeploymentContract } from "../projects/project-deployment-contract.entity";
import { DatabaseTierStatus, ProjectDatabaseTier } from "../projects/project-database-tier.entity";
import { managedDatabaseProfile } from "../projects/managed-database-engine";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { ProjectEnvironmentCryptoService } from "../projects/project-environment-crypto.service";
import { ProjectResourceRegistryService } from "../resource-registry/project-resource-registry.service";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import {
  PipelineRunStatus,
  ProjectPipelineRun,
} from "../projects/project-pipeline-run.entity";
import { isPipelineTerminal } from "../projects/pipeline/pipeline-status";
import { Project, ProjectStatus, ProjectVisibility } from "../projects/project.entity";
import { PIPELINE_QUEUE, PipelineJobData } from "../projects/pipeline/pipeline.types";
import { User, UserRole } from "../users/user.entity";
import { StateCorruptionService } from "../state-management/state-corruption.service";
import { StateValidationStatus } from "../state-management/project-state-validation-result.entity";
import { StateHeartbeatService } from "../state-management/state-heartbeat.service";
import { StateLockService } from "../state-management/state-lock.service";
import { TerraformStateService } from "../state-management/terraform-state.service";
import { AwsCliService } from "../state-management/aws-cli.service";
import { getStateManagementConfig } from "../state-management/state-management.config";
import { getOrchestrationConfig } from "../orchestration/orchestration.config";
import { EfsService } from "../storage/efs.service";
import { StoragePolicyService } from "../storage/storage-policy.service";
import { getInfrastructureConfig } from "./infrastructure.config";
import { InfrastructureReadinessService } from "./infrastructure-readiness.service";
import {
  InfrastructureEnvironmentStatus,
  InfrastructureEnvironmentType,
  ProjectInfrastructureEnvironment,
} from "./project-infrastructure-environment.entity";
import { ProjectInfrastructureEvent } from "./project-infrastructure-event.entity";
import { ProjectServiceDiscoveryRecord } from "./project-service-discovery-record.entity";
import { ProjectDeploymentReadinessSnapshot } from "./project-deployment-readiness-snapshot.entity";
import { ServiceDiscoveryService } from "./service-discovery.service";
import { TerraformRunnerService } from "./terraform-runner.service";
import { ManagedSecretLifecycleService } from "./managed-secret-lifecycle.service";
import { CloudWatchLogLifecycleService } from "./cloudwatch-log-lifecycle.service";
import { PersistentResourceLifecycleService } from "./persistent-resource-lifecycle.service";
import { reviewGithubActionsTerraformPlan } from "../projects/github-actions-terraform-plan-policy";
import {
  acquireProjectConfigurationAdvisoryLock,
  DatabaseServiceBindingService,
  EffectiveDeploymentConfiguration,
} from "./database-service-binding.service";
import {
  CanonicalDeploymentContract,
  DeploymentContractValidationService,
  EcsTaskDefinitionDraft,
} from "./deployment-contract-validation.service";
import { TerraformApprovalStateService } from "./terraform-approval-state.service";

type RequestInfo = Request | undefined;
type ApplyEligibilityClaim = {
  planArtifactPath: string;
  planArtifactSha256: string;
  planArtifactDevice: number;
  planArtifactInode: number;
  planArtifactSize: number;
  planArtifactMtimeMs: number;
  planFingerprint: string;
  contractFingerprint: string;
  terraformInputFingerprint: string;
  approvalRequired: boolean;
  claimedAt: string;
};

@Injectable()
export class InfrastructureService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectDeploymentContract)
    private readonly contractRepository: Repository<ProjectDeploymentContract>,
    @InjectRepository(ProjectDatabaseTier)
    private readonly databaseTierRepository: Repository<ProjectDatabaseTier>,
    @InjectRepository(ProjectEnvironmentVariable)
    private readonly envRepository: Repository<ProjectEnvironmentVariable>,
    private readonly environmentCrypto: ProjectEnvironmentCryptoService,
    @InjectRepository(ProjectPipelineRun)
    private readonly runRepository: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectPipelineEvent)
    private readonly pipelineEventRepository: Repository<ProjectPipelineEvent>,
    @InjectRepository(ProjectCostEstimate)
    private readonly costEstimateRepository: Repository<ProjectCostEstimate>,
    @InjectRepository(ProjectInfrastructureEnvironment)
    private readonly environmentRepository: Repository<ProjectInfrastructureEnvironment>,
    @InjectRepository(ProjectInfrastructureEvent)
    private readonly eventRepository: Repository<ProjectInfrastructureEvent>,
    @InjectRepository(ProjectServiceDiscoveryRecord)
    private readonly serviceDiscoveryRepository: Repository<ProjectServiceDiscoveryRecord>,
    @InjectRepository(ProjectDeploymentReadinessSnapshot)
    private readonly readinessSnapshotRepository: Repository<ProjectDeploymentReadinessSnapshot>,
    @Inject(PIPELINE_QUEUE)
    private readonly pipelineQueue: Queue<PipelineJobData>,
    private readonly config: ConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly readinessService: InfrastructureReadinessService,
    private readonly terraformRunner: TerraformRunnerService,
    private readonly serviceDiscoveryService: ServiceDiscoveryService,
    private readonly terraformStateService: TerraformStateService,
    private readonly stateLockService: StateLockService,
    private readonly stateHeartbeatService: StateHeartbeatService,
    private readonly stateCorruptionService: StateCorruptionService,
    private readonly awsCliService: AwsCliService,
    private readonly storagePolicyService: StoragePolicyService,
    private readonly efsService: EfsService,
    private readonly resourceRegistry: ProjectResourceRegistryService,
    private readonly databaseBindings: DatabaseServiceBindingService,
    private readonly deploymentContractValidation: DeploymentContractValidationService,
    private readonly terraformApprovalState: TerraformApprovalStateService,
  ) {}

  async getDeploymentReadiness(user: User, projectId: string, req?: RequestInfo) {
    const readiness = await this.readinessService.getDeploymentReadiness(projectId, user);
    await this.audit("DEPLOYMENT_READINESS_CHECKED", projectId, user, "success", {
      ready: readiness.ready,
      blockingReasons: readiness.blockingReasons,
    }, req);

    if (!readiness.ready) {
      await this.audit("DEPLOYMENT_READINESS_FAILED", projectId, user, "failed", {
        ready: false,
        blockingReasons: readiness.blockingReasons,
      }, req);
    }

    return readiness;
  }

  async deploy(user: User, projectId: string, req?: RequestInfo) {
    const project = await this.findProjectForManage(user, projectId);
    const readiness = await this.readinessService.assertDeploymentReady(project.id, user);
    const run = await this.createInfrastructureRun(project, user, "full_deploy");
    await this.saveReadinessSnapshot(project.id, run.id, user.id, readiness);
    const environment = await this.createOrGetInfrastructureEnvironment(project.id, run.id);
    environment.status = InfrastructureEnvironmentStatus.QUEUED;
    environment.readinessSnapshot = readiness;
    await this.environmentRepository.save(environment);
    await this.enqueue(run, user, "full_deploy");
    await this.event(project.id, run.id, environment.id, "deployment_queued", "queued", "Deployment queued.", user);
    await this.audit("DEPLOYMENT_QUEUED", project.id, user, "success", {
      pipelineRunId: run.id,
      infrastructureEnvironmentId: environment.id,
    }, req);

    return { pipelineRunId: run.id, infrastructureEnvironmentId: environment.id };
  }

  async queuePlan(user: User, projectId: string, req?: RequestInfo) {
    const project = await this.findProjectForManage(user, projectId);
    const run = await this.createInfrastructureRun(project, user, "infrastructure_plan");
    const environment = await this.createOrGetInfrastructureEnvironment(project.id, run.id);
    environment.status = InfrastructureEnvironmentStatus.QUEUED;
    await this.environmentRepository.save(environment);
    await this.enqueue(run, user, "infrastructure_plan");
    await this.event(project.id, run.id, environment.id, "infrastructure_plan_queued", "queued", "Infrastructure plan queued.", user);
    await this.audit("INFRASTRUCTURE_PLAN_QUEUED", project.id, user, "success", {
      pipelineRunId: run.id,
      infrastructureEnvironmentId: environment.id,
    }, req);

    return { pipelineRunId: run.id, infrastructureEnvironmentId: environment.id };
  }

  async queueApply(user: User, projectId: string, req?: RequestInfo) {
    const project = await this.findProjectForManage(user, projectId);
    await this.assertCostGatePassed(project.id);
    const run = await this.createInfrastructureRun(project, user, "infrastructure_apply");
    const environment = await this.createOrGetInfrastructureEnvironment(project.id, run.id);
    environment.status = InfrastructureEnvironmentStatus.QUEUED;
    await this.environmentRepository.save(environment);
    await this.enqueue(run, user, "infrastructure_apply");
    await this.event(project.id, run.id, environment.id, "infrastructure_apply_queued", "queued", "Infrastructure apply queued.", user);

    return { pipelineRunId: run.id, infrastructureEnvironmentId: environment.id };
  }

  async createOrGetInfrastructureEnvironment(projectId: string, pipelineRunId?: string | null) {
    const existing = await this.environmentRepository.findOne({
      where: { projectId, environmentName: "dev" },
      order: { createdAt: "DESC" },
    });

    if (existing) {
      if (pipelineRunId) {
        existing.pipelineRunId = pipelineRunId;
      }
      return this.environmentRepository.save(existing);
    }

    const infraConfig = getInfrastructureConfig(this.config);
    return this.environmentRepository.save(
      this.environmentRepository.create({
        projectId,
        pipelineRunId: pipelineRunId || null,
        environmentName: "dev",
        environmentType: InfrastructureEnvironmentType.TESTING,
        autoDestroyEnabled: false,
        ttlExpiresAt: null,
        cleanupStatus: "not_scheduled",
        status: InfrastructureEnvironmentStatus.NOT_PROVISIONED,
        awsRegion: infraConfig.awsRegion,
      })
    );
  }

  async prepareInfrastructureWorkspace(projectId: string, pipelineRunId: string) {
    const infraConfig = getInfrastructureConfig(this.config);
    const stateConfig = getStateManagementConfig(this.config);
    if (!/^[A-Za-z0-9-]+$/.test(projectId) || !/^[A-Za-z0-9-]+$/.test(pipelineRunId)) {
      throw new BadRequestException("Invalid Terraform workspace identifier.");
    }

    await mkdir(infraConfig.terraformWorkingBaseDir, { recursive: true });
    const workdir = join(infraConfig.terraformWorkingBaseDir, projectId, pipelineRunId);

    await mkdir(workdir, { recursive: true });
    await this.assertWorkspaceInsideRoot(workdir, infraConfig.terraformWorkingBaseDir);
    await this.prepareBackendMode(workdir, stateConfig.mockMode ? "local" : "s3");
    await cp(infraConfig.terraformNetworkTemplateDir, workdir, {
      recursive: true,
      force: true,
    });
    await cp(
      resolve(infraConfig.terraformNetworkTemplateDir, "..", "modules"),
      join(workdir, "..", "modules"),
      {
        recursive: true,
        force: true,
      }
    );
    await this.writeBackendDeclaration(workdir, stateConfig.mockMode ? "local" : "s3");
    await rm(join(workdir, "tfplan"), { force: true });

    return workdir;
  }

  async renderTerraformVariables(
    project: Project,
    contract: ProjectDeploymentContract,
    pipelineRunId?: string | null,
    effectiveConfiguration?: EffectiveDeploymentConfiguration,
  ) {
    const infraConfig = getInfrastructureConfig(this.config);
    const namespaceBase = infraConfig.cloudMapNamespace.replace(/^\.+|\.+$/g, "");
    const efsVars = await this.storagePolicyService.buildEfsTerraformVariables(project.id, "dev");
    const ecsVars = await this.buildEcsTerraformVariables(
      project,
      contract,
      pipelineRunId || null,
      effectiveConfiguration,
    );
    const vars = {
      project_id: project.id,
      project_name: project.name,
      environment_name: "dev",
      aws_region: infraConfig.awsRegion,
      vpc_cidr: infraConfig.defaultVpcCidr,
      public_subnet_cidrs: infraConfig.publicSubnetCidrs,
      private_subnet_cidrs: infraConfig.privateSubnetCidrs,
      single_nat_gateway: infraConfig.singleNatGateway,
      cloud_map_namespace: `project-${project.id}.${namespaceBase}`,
      enable_https: infraConfig.enableHttps,
      app_port: contract.ecsPlan.containerPort,
      tags: {
        Project: "DeployGuard",
        ManagedBy: "DeployGuard",
        ProjectId: project.id,
        DeployGuardProjectId: project.id,
        PipelineRunId: pipelineRunId || "unknown",
        Repository: project.repositoryFullName || "unknown",
        Environment: "dev",
        CreatedBy: "DeployGuard",
      },
      ...efsVars,
      ...ecsVars,
    };

    return vars;
  }

  async runInfrastructurePlan(projectId: string, pipelineRunId: string, actorUser?: User | null) {
    const project = await this.requireProject(projectId);
    const contract = await this.contractRepository.findOne({ where: { projectId } });
    if (!contract?.deployable) {
      throw new BadRequestException(
        contract?.blockers?.[0] || "A deployable deployment contract is required before Terraform plan."
      );
    }
    await this.databaseBindings.ensureIntent(projectId, pipelineRunId);
    const validated = await this.buildValidatedTerraformInputs(project, contract, pipelineRunId);
    const environment = await this.createOrGetInfrastructureEnvironment(projectId, pipelineRunId);
    const plannedRun = await this.runRepository.findOne({ where: { id: pipelineRunId, projectId } });
    if (!plannedRun) {
      throw new BadRequestException({ code: "run_not_found", message: "Pipeline run is unavailable." });
    }
    if (plannedRun.ecrImageUri && typeof plannedRun.metadata?.buildFingerprint !== "string") {
      throw new BadRequestException({
        code: "build_checkpoint_missing",
        message: "The reusable image has no completed build fingerprint. Resume from Docker build before infrastructure planning.",
      });
    }
    const prePlanEvidence = {
      deploymentContractSchemaVersion: validated.canonical.schemaVersion,
      contractFingerprint: validated.canonical.contractFingerprint,
      taskDefinitionDraftFingerprint: validated.taskDefinitionDraft.draftFingerprint,
      terraformInputFingerprint: validated.terraformInputFingerprint,
      managedBindingRevisions: validated.bindingRevisions,
      prePlanValidatedAt: new Date().toISOString(),
    };
    environment.metadata = { ...(environment.metadata || {}), ...prePlanEvidence };
    plannedRun.metadata = { ...(plannedRun.metadata || {}), ...prePlanEvidence };
    await this.environmentRepository.save(environment);
    await this.runRepository.save(plannedRun);
    const workdir = await this.prepareInfrastructureWorkspace(projectId, pipelineRunId);
    const vars = validated.terraformVariables;
    const lockId = this.stateLockService.buildLockId(projectId, "dev");
    let lockAcquired = false;

    environment.status = InfrastructureEnvironmentStatus.PLANNING;
    environment.terraformWorkspacePath = workdir;
    environment.terraformStateKey = this.terraformStateService.buildStateKey(project, "dev");
    environment.errorMessage = null;
    environment.failedAt = null;
    await this.environmentRepository.save(environment);
    await writeFile(join(workdir, "terraform.tfvars.json"), JSON.stringify(vars, null, 2), { encoding: "utf8", mode: 0o600 });
    await this.event(projectId, pipelineRunId, environment.id, "infrastructure_plan_started", "running", "Terraform plan started.", actorUser);
    await this.audit("INFRASTRUCTURE_PLAN_STARTED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });

    try {
      await this.verifyStateBackend(project, pipelineRunId, environment.id, actorUser);
      await this.event(projectId, pipelineRunId, environment.id, "state_lock_acquire_started", "running", "Terraform state lock acquisition started.", actorUser, { operation: "plan" });
      await this.audit("STATE_LOCK_ACQUIRE_STARTED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });
      const lockResult = await this.stateLockService.acquireLock(projectId, pipelineRunId, actorUser?.id || null, "dev", {
        operation: "plan",
      });

      if (!lockResult.acquired) {
        environment.status = InfrastructureEnvironmentStatus.QUEUED;
        await this.environmentRepository.save(environment);
        await this.updateRun(pipelineRunId, {
          status: PipelineRunStatus.WAITING_FOR_STATE_LOCK,
          currentStage: "state_lock_waiting",
        });
        await this.event(projectId, pipelineRunId, environment.id, "state_lock_waiting", "queued", "Deployment queued behind existing Terraform state lock.", actorUser, { operation: "plan" });
        await this.audit("STATE_LOCK_WAITING", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });
        await this.audit("DEPLOYMENT_QUEUED_FOR_STATE_LOCK", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });
        return environment;
      }

      lockAcquired = true;
      await this.updateRun(pipelineRunId, {
        status: PipelineRunStatus.STATE_LOCK_ACQUIRED,
        currentStage: "state_lock_acquired",
      });
      await this.event(projectId, pipelineRunId, environment.id, "state_lock_acquired", "success", "Terraform state lock acquired.", actorUser, { operation: "plan" });
      await this.audit("STATE_LOCK_ACQUIRED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });
      await this.stateHeartbeatService.startHeartbeat(lockId, pipelineRunId);
      await this.updateRun(pipelineRunId, {
        status: PipelineRunStatus.STATE_HEARTBEAT_ACTIVE,
        currentStage: "state_heartbeat_active",
      });
      await this.event(projectId, pipelineRunId, environment.id, "state_heartbeat_started", "success", "Terraform state heartbeat started.", actorUser, { operation: "plan" });
      await this.audit("STATE_HEARTBEAT_STARTED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });

      const env = this.terraformEnv();
      const stateConfig = getStateManagementConfig(this.config);
      const backendMode = stateConfig.mockMode ? "local" : "s3";
      const backendConfigPath = backendMode === "s3"
        ? await this.terraformStateService.writeBackendConfig(workdir, project, "dev")
        : undefined;
      await this.event(projectId, pipelineRunId, environment.id, "state_backend_config_generated", "success", backendMode === "local" ? "Terraform local backend selected for mock state mode." : "Terraform S3 backend configuration generated.", actorUser, { backendMode, operation: "plan" });
      await this.recordPipelineEventForRun(projectId, pipelineRunId, "terraform_plan_backend_initialized", "running", `Terraform ${backendMode} backend initialization started.`, { backendMode, operation: "plan" });
      await this.terraformRunner.runTerraformFmtCheck(workdir, env);
      await this.terraformRunner.runTerraformInit(workdir, env, { mode: backendMode, configPath: backendConfigPath });
      const managedSecretReconciliation = await new ManagedSecretLifecycleService(this.awsCliService, this.terraformRunner).reconcileBeforePlan(workdir, vars, env);
      const logGroupReconciliation = await new CloudWatchLogLifecycleService(this.awsCliService, this.terraformRunner).reconcileBeforePlan(workdir, vars, env);
      const persistentResourceReconciliation = await new PersistentResourceLifecycleService(this.awsCliService, this.terraformRunner).reconcileBeforePlan(workdir, vars, env);
      await this.terraformRunner.runTerraformValidate(workdir, env);
      const plan = await this.terraformRunner.runTerraformPlanDetailed(workdir, env);
      const show = await this.terraformRunner.runTerraformShowJson(workdir, env);
      const planReview = reviewGithubActionsTerraformPlan(show.stdout, {
        projectId,
        environment: "dev",
        infrastructureNamespace: `/deployguard/${projectId}`,
      });
      const reconciliationEvidence = {
        managedSecrets: managedSecretReconciliation.map(({ name, resourceAddress, initialStatus, restoreResult, importResult }) => ({ name, resourceAddress, initialStatus, restoreResult, importResult })),
        logGroups: logGroupReconciliation.map(({ name, resourceAddress, status, importResult }) => ({ name, resourceAddress, status, importResult })),
        persistentResources: persistentResourceReconciliation.map(({ kind, identity, resourceAddress, status, importResult }) => ({ kind, identity, resourceAddress, status, importResult })),
      };
      environment.terraformPlanSummary = planReview.summary;
      environment.metadata = { ...(environment.metadata || {}), terraformPrePlanReconciliation: reconciliationEvidence, terraformPlanSafety: planReview.safe ? "passed" : "rejected", terraformPlanViolations: planReview.violations };
      plannedRun.metadata = { ...(plannedRun.metadata || {}), terraformPrePlanReconciliation: reconciliationEvidence, terraformPlanSummary: planReview.summary, terraformPlanSafety: planReview.safe ? "passed" : "rejected" };
      await this.environmentRepository.save(environment);
      await this.runRepository.save(plannedRun);
      if (!planReview.safe) {
        throw new BadRequestException({
          code: "terraform_plan_unsafe",
          message: "Terraform plan contains an unexpected retained-resource, ownership or namespace change.",
          violations: planReview.violations,
        });
      }
      const planPolicy = this.deploymentContractValidation.assertTerraformPlanPolicy(
        show.stdout,
        validated.canonical,
        validated.taskDefinitionDraft,
        validated.terraformInputFingerprint,
      );
      if (planPolicy.auditAction) {
        await this.event(
          projectId,
          pipelineRunId,
          environment.id,
          "plan_task_definition_unknown_canonical_equivalence_used",
          "warning",
          "Terraform reported the application task definition as computed; the validated canonical input mapping was used.",
          actorUser,
          planPolicy,
        );
        await this.audit(planPolicy.auditAction, projectId, actorUser || null, "success", {
          pipelineRunId,
          infrastructureEnvironmentId: environment.id,
          ...planPolicy,
        });
      }
      const planSummary = planReview.summary;
      const snapshot = await this.databaseBindings.assertRunConfigurationCurrent(projectId, pipelineRunId);
      const artifactSha256 = createHash("sha256").update(await readFile(join(workdir, "tfplan"))).digest("hex");
      const planFingerprint = this.deploymentContractValidation.planFingerprint(
        artifactSha256,
        validated.terraformInputFingerprint,
        validated.canonical.contractFingerprint,
        pipelineRunId,
      );
      const planGeneratedAt = new Date();
      const configuredTtl = Number(this.config.get<string>("TERRAFORM_PLAN_TTL_SECONDS", "3600"));
      const planTtlSeconds = Number.isFinite(configuredTtl) && configuredTtl >= 60 ? configuredTtl : 3600;

      environment.status = InfrastructureEnvironmentStatus.COST_CHECK_REQUIRED;
      environment.terraformPlanSummary = planSummary;
      environment.metadata = {
        ...(environment.metadata || {}),
        planLog: plan.stdout || plan.stderr || null,
        planFingerprint,
        planArtifactSha256: artifactSha256,
        planConfigurationFingerprint: snapshot.configurationFingerprint,
        contractFingerprint: validated.canonical.contractFingerprint,
        terraformInputFingerprint: validated.terraformInputFingerprint,
        planPolicyStatus: "passed",
        planPolicyMode: planPolicy.mode,
        planTaskDefinitionDraftFingerprint: planPolicy.taskDefinitionDraftFingerprint,
        deploymentContract: validated.canonical,
        planConfigurationSnapshotId: snapshot.id,
        planGeneratedAt: planGeneratedAt.toISOString(),
        planExpiresAt: new Date(planGeneratedAt.getTime() + planTtlSeconds * 1000).toISOString(),
      };
      environment.errorMessage = null;
      environment.failedAt = null;
      await this.environmentRepository.save(environment);
      plannedRun.metadata = {
        ...(plannedRun.metadata || {}),
        contractFingerprint: validated.canonical.contractFingerprint,
        terraformInputFingerprint: validated.terraformInputFingerprint,
        taskDefinitionDraftFingerprint: validated.taskDefinitionDraft.draftFingerprint,
        managedBindingRevisions: validated.bindingRevisions,
        deploymentContractSchemaVersion: validated.canonical.schemaVersion,
        terraformPlanFingerprint: planFingerprint,
        terraformPlanArtifactHash: artifactSha256,
        terraformPlanGeneratedAt: planGeneratedAt.toISOString(),
        terraformPlanExpiresAt: new Date(planGeneratedAt.getTime() + planTtlSeconds * 1000).toISOString(),
        terraformPlanPolicyMode: planPolicy.mode,
      };
      await this.runRepository.save(plannedRun);
      await this.event(projectId, pipelineRunId, environment.id, "infrastructure_plan_completed", "success", "Terraform plan completed.", actorUser, planSummary);
      await this.audit("INFRASTRUCTURE_PLAN_COMPLETED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });
      await this.validateAndPersistState(project, environment, pipelineRunId, "plan", actorUser);
      await this.releaseStateLock(lockId, pipelineRunId, projectId, environment.id, "plan", actorUser);

      return environment;
    } catch (error) {
      const message = this.publicError(error);
      environment.status = InfrastructureEnvironmentStatus.PLAN_FAILED;
      environment.errorMessage = message;
      environment.failedAt = new Date();
      await this.environmentRepository.save(environment);
      await this.event(projectId, pipelineRunId, environment.id, "infrastructure_plan_failed", "failed", message, actorUser);
      await this.audit("INFRASTRUCTURE_PLAN_FAILED", projectId, actorUser || null, "failed", { pipelineRunId, infrastructureEnvironmentId: environment.id, reason: message });
      if (lockAcquired) {
        await this.releaseStateLock(lockId, pipelineRunId, projectId, environment.id, "plan", actorUser);
      }
      throw error;
    }
  }

  async runInfrastructureApply(projectId: string, pipelineRunId: string, actorUser?: User | null) {
    const infraConfig = getInfrastructureConfig(this.config);
    const project = await this.requireProject(projectId);
    const contract = await this.contractRepository.findOne({ where: { projectId } });
    if (!contract?.deployable) {
      throw new BadRequestException(contract?.blockers?.[0] || "A deployable deployment contract is required before Terraform apply.");
    }
    const validated = await this.buildValidatedTerraformInputs(project, contract, pipelineRunId);
    const run = await this.runRepository.findOne({ where: { id: pipelineRunId, projectId } });
    if (!run) throw new BadRequestException("Pipeline run is unavailable.");
    await this.assertCostGatePassed(projectId);
    const environment = await this.createOrGetInfrastructureEnvironment(projectId, pipelineRunId);

    if (!infraConfig.terraformApplyEnabled) {
      environment.status = InfrastructureEnvironmentStatus.DISABLED_BY_CONFIG;
      environment.errorMessage = "Terraform apply is disabled. Set TERRAFORM_APPLY_ENABLED=true for real provisioning.";
      environment.failedAt = null;
      await this.environmentRepository.save(environment);
      await this.event(projectId, pipelineRunId, environment.id, "infrastructure_apply_disabled_by_config", "disabled_by_config", environment.errorMessage, actorUser);
      await this.audit("INFRASTRUCTURE_APPLY_DISABLED_BY_CONFIG", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id, reason: environment.errorMessage });
      return null;
    }

    if (!environment.terraformWorkspacePath) {
      await this.runInfrastructurePlan(projectId, pipelineRunId, actorUser);
    }

    const freshEnvironment = await this.createOrGetInfrastructureEnvironment(projectId, pipelineRunId);
    const lockId = this.stateLockService.buildLockId(projectId, "dev");
    let lockAcquired = false;
    let applyClaimed = false;

    try {
      await this.verifyStateBackend(project, pipelineRunId, freshEnvironment.id, actorUser);
      await this.event(projectId, pipelineRunId, freshEnvironment.id, "state_lock_acquire_started", "running", "Terraform state lock acquisition started.", actorUser, { operation: "apply" });
      const lockResult = await this.stateLockService.acquireLock(projectId, pipelineRunId, actorUser?.id || null, "dev", {
        operation: "apply",
      });

      if (!lockResult.acquired) {
        freshEnvironment.status = InfrastructureEnvironmentStatus.QUEUED;
        await this.environmentRepository.save(freshEnvironment);
        await this.updateRun(pipelineRunId, {
          status: PipelineRunStatus.WAITING_FOR_STATE_LOCK,
          currentStage: "state_lock_waiting",
        });
        await this.event(projectId, pipelineRunId, freshEnvironment.id, "state_lock_waiting", "queued", "Deployment queued behind existing Terraform state lock.", actorUser, { operation: "apply" });
        await this.audit("STATE_LOCK_WAITING", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: freshEnvironment.id });
        return freshEnvironment;
      }

      lockAcquired = true;
      const applyEligibility = await this.claimInfrastructureApplyEligibility(
        projectId,
        pipelineRunId,
        freshEnvironment.id,
        validated,
      );
      applyClaimed = true;
      await this.awsCliService.validateCredentials();
      await this.databaseBindings.markProvisioning(projectId, pipelineRunId);
      freshEnvironment.status = InfrastructureEnvironmentStatus.PROVISIONING;
      freshEnvironment.errorMessage = null;
      freshEnvironment.failedAt = null;
      await this.environmentRepository.save(freshEnvironment);
      await this.event(projectId, pipelineRunId, freshEnvironment.id, "infrastructure_apply_started", "running", "Terraform apply started.", actorUser);
      await this.audit("INFRASTRUCTURE_APPLY_STARTED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: freshEnvironment.id });
      await this.stateHeartbeatService.startHeartbeat(lockId, pipelineRunId);
      await this.event(projectId, pipelineRunId, freshEnvironment.id, "state_heartbeat_started", "success", "Terraform state heartbeat started.", actorUser, { operation: "apply" });
      const env = this.terraformEnv();
      const stateConfig = getStateManagementConfig(this.config);
      const backendMode = stateConfig.mockMode ? "local" : "s3";
      const backendConfigPath = backendMode === "s3"
        ? await this.terraformStateService.writeBackendConfig(freshEnvironment.terraformWorkspacePath, project, "dev")
        : undefined;
      await this.event(projectId, pipelineRunId, freshEnvironment.id, "state_backend_config_generated", "success", backendMode === "local" ? "Terraform local backend selected for mock state mode." : "Terraform S3 backend configuration refreshed for apply.", actorUser, { backendMode, operation: "apply" });
      await this.terraformRunner.runTerraformInit(freshEnvironment.terraformWorkspacePath, env, { mode: backendMode, configPath: backendConfigPath });
      const verifiedPlanPath = await this.verifyFinalPlanIntegrity(
        projectId,
        pipelineRunId,
        freshEnvironment.id,
        freshEnvironment.terraformWorkspacePath,
        applyEligibility,
      );
      await this.terraformRunner.runTerraformApply(freshEnvironment.terraformWorkspacePath, env, verifiedPlanPath);
      const outputs = await this.terraformRunner.parseOutputs(freshEnvironment.terraformWorkspacePath, env);
      const saved = await this.saveInfrastructureOutputs(projectId, pipelineRunId, outputs);
      await this.event(projectId, pipelineRunId, saved.id, "vpc_provisioned", "success", "VPC provisioned.", actorUser, { vpcId: saved.vpcId });
      await this.event(projectId, pipelineRunId, saved.id, "subnets_provisioned", "success", "Public and private subnets provisioned.", actorUser);
      await this.event(projectId, pipelineRunId, saved.id, "nat_gateway_provisioned", "success", "NAT gateway provisioned.", actorUser);
      await this.event(projectId, pipelineRunId, saved.id, "security_groups_provisioned", "success", "Security groups provisioned.", actorUser);
      await this.event(projectId, pipelineRunId, saved.id, "cloud_map_namespace_created", "success", "Cloud Map namespace created.", actorUser);
      await this.event(projectId, pipelineRunId, saved.id, "service_discovery_ready", "success", "Service discovery is ready.", actorUser);
      await this.event(projectId, pipelineRunId, saved.id, "terraform_outputs_saved", "success", "Terraform outputs saved.", actorUser);
      await this.event(projectId, pipelineRunId, saved.id, "infrastructure_apply_completed", "success", "Infrastructure apply completed.", actorUser);
      await this.audit("INFRASTRUCTURE_APPLY_COMPLETED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: saved.id });
      await this.markInfrastructureApplyCompleted(projectId, pipelineRunId);
      await this.validateAndPersistState(project, saved, pipelineRunId, "apply", actorUser);
      await this.releaseStateLock(lockId, pipelineRunId, projectId, saved.id, "apply", actorUser);

      return saved;
    } catch (error) {
      const message = this.publicError(error);
      const reasonCode = this.infrastructureFailureCode(error);
      if (applyClaimed) {
        if (reasonCode === "plan_artifact_changed_before_apply") {
          await this.markPlanIntegrityReconciliationRequired(pipelineRunId, message);
        }
        freshEnvironment.status = InfrastructureEnvironmentStatus.FAILED;
        freshEnvironment.errorMessage = message;
        freshEnvironment.failedAt = new Date();
        await this.environmentRepository.save(freshEnvironment);
        await this.event(projectId, pipelineRunId, freshEnvironment.id, "infrastructure_apply_failed", "failed", message, actorUser);
        await this.audit("INFRASTRUCTURE_APPLY_FAILED", projectId, actorUser || null, "failed", { pipelineRunId, infrastructureEnvironmentId: freshEnvironment.id, reason: message });
      } else {
        await this.event(projectId, pipelineRunId, freshEnvironment.id, "infrastructure_apply_eligibility_rejected", "blocked", message, actorUser, { reasonCode });
        await this.audit("INFRASTRUCTURE_APPLY_ELIGIBILITY_REJECTED", projectId, actorUser || null, "failed", {
          pipelineRunId,
          infrastructureEnvironmentId: freshEnvironment.id,
          reasonCode,
          reason: message,
        });
      }
      if (lockAcquired) {
        await this.releaseStateLock(lockId, pipelineRunId, projectId, freshEnvironment.id, "apply", actorUser);
      }
      throw error;
    }
  }

  private async claimInfrastructureApplyEligibility(
    projectId: string,
    pipelineRunId: string,
    infrastructureEnvironmentId: string,
    validated: {
      canonical: CanonicalDeploymentContract;
      taskDefinitionDraft: EcsTaskDefinitionDraft;
      terraformInputFingerprint: string;
      bindingRevisions: Array<Record<string, unknown>>;
    },
  ) {
    return this.runRepository.manager.transaction(async (manager): Promise<ApplyEligibilityClaim> => {
      await acquireProjectConfigurationAdvisoryLock(manager, projectId, "production");
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `deployguard:terraform-apply:${projectId}:dev`,
      ]);
      const runs = manager.getRepository(ProjectPipelineRun);
      const environments = manager.getRepository(ProjectInfrastructureEnvironment);
      const contracts = manager.getRepository(ProjectDeploymentContract);
      const pipelineEvents = manager.getRepository(ProjectPipelineEvent);
      // A transaction owns one PostgreSQL client. Keep its queries serialized;
      // pg 8.16+ rejects overlapping query calls on that client.
      const currentRun = await runs.findOne({ where: { id: pipelineRunId, projectId } });
      const latestRun = await runs.findOne({ where: { projectId }, order: { createdAt: "DESC" } });
      const currentEnvironment = await environments.findOne({ where: { id: infrastructureEnvironmentId, projectId, pipelineRunId } });
      const currentContract = await contracts.findOne({ where: { projectId } });
      const configurationSnapshot = await this.databaseBindings.assertRunConfigurationCurrent(projectId, pipelineRunId, manager);

      if (!currentRun) this.applyEligibilityFailure("run_not_found", "The deployment run no longer exists.");
      if (!latestRun || latestRun.id !== currentRun.id) {
        this.applyEligibilityFailure("run_superseded", "A newer deployment or recovery run superseded this run.");
      }
      if (
        isPipelineTerminal(currentRun.status)
        || currentRun.completedAt
        || currentRun.failedAt
        || currentRun.status === PipelineRunStatus.CANCELLED
      ) {
        this.applyEligibilityFailure("run_terminal", "This deployment run is cancelled, failed, or terminal.");
      }
      if (!currentEnvironment?.terraformWorkspacePath) {
        this.applyEligibilityFailure("plan_missing", "The saved Terraform plan artifact is unavailable. Generate a new plan.");
      }

      const runMetadata = (currentRun.metadata || {}) as Record<string, unknown>;
      const planMetadata = (currentEnvironment.metadata || {}) as Record<string, unknown>;
      if (
        runMetadata.isStale === true
        || runMetadata.latestRunIsStale === true
        || runMetadata.supersededByRunId
        || runMetadata.cancelRequestedAt
        || runMetadata.cancellationRequestedAt
      ) {
        this.applyEligibilityFailure("run_stale", "This deployment run is stale, superseded, or cancellation was requested.");
      }
      const alreadyStartedEvent = await pipelineEvents.findOne({
        where: {
          projectId,
          pipelineRunId,
          stage: In(["infrastructure_apply_started", "infrastructure_apply_completed"]),
        },
        order: { occurredAt: "DESC" },
      });
      if (
        runMetadata.terraformApplyCompletedAt
        || runMetadata.applyCompletedPlanFingerprint
        || alreadyStartedEvent?.stage === "infrastructure_apply_completed"
      ) {
        this.applyEligibilityFailure("apply_already_completed", "Terraform apply already completed for this run.");
      }
      if (
        runMetadata.terraformApplyStartedAt
        || alreadyStartedEvent
      ) {
        this.applyEligibilityFailure("apply_already_started", "Terraform apply already started for this run.");
      }

      if (!currentContract?.deployable || currentContract.contractHash !== validated.canonical.deploymentContractRevision) {
        this.applyEligibilityFailure("contract_invalid", "The deployment contract is no longer valid.");
      }
      if (
        runMetadata.deploymentContractSchemaVersion !== validated.canonical.schemaVersion
        || runMetadata.contractFingerprint !== validated.canonical.contractFingerprint
        || planMetadata.contractFingerprint !== validated.canonical.contractFingerprint
      ) {
        this.applyEligibilityFailure("configuration_changed", "The deployment contract changed after planning. Generate a new plan.");
      }
      if (
        runMetadata.terraformInputFingerprint !== validated.terraformInputFingerprint
        || planMetadata.terraformInputFingerprint !== validated.terraformInputFingerprint
      ) {
        this.applyEligibilityFailure("configuration_changed", "Terraform inputs changed after planning. Generate a new plan.");
      }
      if (
        runMetadata.taskDefinitionDraftFingerprint !== validated.taskDefinitionDraft.draftFingerprint
        || planMetadata.taskDefinitionDraftFingerprint !== validated.taskDefinitionDraft.draftFingerprint
      ) {
        this.applyEligibilityFailure("configuration_changed", "The ECS task-definition draft changed after planning. Generate a new plan.");
      }
      if (
        runMetadata.desiredStateRevision !== configurationSnapshot.configurationFingerprint
        || runMetadata.configurationFingerprint !== configurationSnapshot.configurationFingerprint
        || planMetadata.planConfigurationFingerprint !== configurationSnapshot.configurationFingerprint
      ) {
        this.applyEligibilityFailure("configuration_changed", "The immutable desired-state revision changed after planning. Generate a new plan.");
      }
      const snapshotBindingFingerprint = analysisFingerprint({
        revisions: this.normalizedBindingRevisions(configurationSnapshot.bindingRevisions),
      });
      if (
        analysisFingerprint({ revisions: this.normalizedBindingRevisions(runMetadata.managedBindingRevisions) }) !== snapshotBindingFingerprint
        || analysisFingerprint({ revisions: this.normalizedBindingRevisions(planMetadata.managedBindingRevisions) }) !== snapshotBindingFingerprint
        || analysisFingerprint({ revisions: this.normalizedBindingRevisions(validated.bindingRevisions) }) !== snapshotBindingFingerprint
      ) {
        this.applyEligibilityFailure("configuration_changed", "Managed service binding revisions changed after planning. Generate a new plan.");
      }
      if (planMetadata.planPolicyStatus !== "passed") {
        this.applyEligibilityFailure("plan_policy_failed", "Terraform task-definition policy validation did not pass.");
      }
      if (
        planMetadata.planTaskDefinitionDraftFingerprint !== validated.taskDefinitionDraft.draftFingerprint
        || !["known", "unknown_canonical_equivalence"].includes(String(planMetadata.planPolicyMode || ""))
      ) {
        this.applyEligibilityFailure("plan_policy_failed", "Terraform task-definition policy evidence is incomplete.");
      }

      const expectedArtifactSha256 = this.nonEmptyString(planMetadata.planArtifactSha256);
      const expectedPlanFingerprint = this.nonEmptyString(planMetadata.planFingerprint);
      const expiresAt = this.nonEmptyString(planMetadata.planExpiresAt);
      if (!expectedArtifactSha256 || !expectedPlanFingerprint || !expiresAt) {
        this.applyEligibilityFailure("plan_stale", "Terraform plan integrity evidence is incomplete. Generate a new plan.");
      }
      if (new Date(expiresAt).getTime() <= Date.now()) {
        this.applyEligibilityFailure("plan_expired", "The Terraform plan and approval expired. Generate and approve a new plan.");
      }
      let artifactSha256: string;
      let artifactStat;
      const artifactPath = resolve(currentEnvironment.terraformWorkspacePath, "tfplan");
      try {
        artifactStat = await lstat(artifactPath);
        if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
          this.applyEligibilityFailure("plan_missing", "The saved Terraform plan artifact is not a regular file. Generate a new plan.");
        }
        if (await realpath(artifactPath) !== artifactPath) {
          this.applyEligibilityFailure("plan_missing", "The saved Terraform plan artifact path is not canonical. Generate a new plan.");
        }
        const artifact = await readFile(artifactPath);
        artifactSha256 = createHash("sha256").update(artifact).digest("hex");
      } catch {
        this.applyEligibilityFailure("plan_missing", "The saved Terraform plan artifact is missing or unreadable. Generate a new plan.");
      }
      const currentPlanFingerprint = this.deploymentContractValidation.planFingerprint(
        artifactSha256,
        validated.terraformInputFingerprint,
        validated.canonical.contractFingerprint,
        pipelineRunId,
      );
      if (artifactSha256 !== expectedArtifactSha256 || currentPlanFingerprint !== expectedPlanFingerprint) {
        this.applyEligibilityFailure("plan_stale", "The saved Terraform plan artifact changed after approval. Generate and approve a new plan.");
      }

      const approvalRequired = envBoolean(this.config, "TERRAFORM_APPLY_REQUIRES_APPROVAL", true);
      if (approvalRequired) {
        const approvedAt = this.nonEmptyString(runMetadata.applyApprovedAt);
        const approvalTtlSeconds = Math.max(
          60,
          Number(this.config.get<string>("TERRAFORM_APPLY_APPROVAL_TTL_SECONDS", "3600")) || 3600,
        );
        if (!approvedAt) {
          this.applyEligibilityFailure("approval_missing", "Explicit Terraform apply approval is required.");
        }
        if (new Date(approvedAt).getTime() + approvalTtlSeconds * 1000 <= Date.now()) {
          this.applyEligibilityFailure("approval_expired", "Terraform apply approval expired. Request fresh approval.");
        }
        if (
          runMetadata.applyApprovedRunId !== pipelineRunId
          || runMetadata.applyApprovedPlanFingerprint !== currentPlanFingerprint
          || runMetadata.applyApprovedContractFingerprint !== validated.canonical.contractFingerprint
          || runMetadata.applyApprovedTerraformInputFingerprint !== validated.terraformInputFingerprint
        ) {
          this.applyEligibilityFailure("approval_stale", "Terraform apply approval does not belong to this exact run, plan, and deployment contract.");
        }
        if (runMetadata.applyApprovalConsumedAt) {
          this.applyEligibilityFailure("approval_consumed", "Terraform apply approval was already consumed.");
        }
      }

      const claimedAt = new Date().toISOString();
      currentRun.currentStage = "infrastructure_apply_started";
      currentRun.currentStageStartedAt = new Date(claimedAt);
      currentRun.metadata = {
        ...runMetadata,
        terraformApplyStartedAt: claimedAt,
        applyEligibilityCheckedAt: claimedAt,
        applyStartedPlanArtifactSha256: artifactSha256,
        applyStartedPlanFingerprint: currentPlanFingerprint,
        applyStartedPlanArtifactPath: artifactPath,
        applyStartedPlanArtifactDevice: Number(artifactStat.dev),
        applyStartedPlanArtifactInode: Number(artifactStat.ino),
        applyStartedPlanArtifactSize: artifactStat.size,
        applyStartedPlanArtifactMtimeMs: artifactStat.mtimeMs,
        ...(approvalRequired
          ? {
              applyApprovalConsumedAt: claimedAt,
              applyApprovalConsumedByRunId: pipelineRunId,
            }
          : {}),
      };
      await runs.save(currentRun);
      return {
        planArtifactPath: artifactPath,
        planArtifactSha256: artifactSha256,
        planArtifactDevice: Number(artifactStat.dev),
        planArtifactInode: Number(artifactStat.ino),
        planArtifactSize: artifactStat.size,
        planArtifactMtimeMs: artifactStat.mtimeMs,
        planFingerprint: currentPlanFingerprint,
        contractFingerprint: validated.canonical.contractFingerprint,
        terraformInputFingerprint: validated.terraformInputFingerprint,
        approvalRequired,
        claimedAt,
      };
    });
  }

  private async verifyFinalPlanIntegrity(
    projectId: string,
    pipelineRunId: string,
    infrastructureEnvironmentId: string,
    terraformWorkspacePath: string,
    eligibility: ApplyEligibilityClaim,
  ) {
    const [run, environment] = await Promise.all([
      this.runRepository.findOne({ where: { id: pipelineRunId, projectId } }),
      this.environmentRepository.findOne({
        where: { id: infrastructureEnvironmentId, projectId, pipelineRunId },
      }),
    ]);
    const runMetadata = (run?.metadata || {}) as Record<string, unknown>;
    const planMetadata = (environment?.metadata || {}) as Record<string, unknown>;
    const planPath = resolve(terraformWorkspacePath, "tfplan");
    const persistedPath = environment?.terraformWorkspacePath
      ? resolve(environment.terraformWorkspacePath, "tfplan")
      : null;
    const currentPlanFingerprint = this.deploymentContractValidation.planFingerprint(
      eligibility.planArtifactSha256,
      eligibility.terraformInputFingerprint,
      eligibility.contractFingerprint,
      pipelineRunId,
    );
    if (
      !run
      || !environment
      || persistedPath !== planPath
      || eligibility.planArtifactPath !== planPath
      || planMetadata.planArtifactSha256 !== eligibility.planArtifactSha256
      || planMetadata.planFingerprint !== eligibility.planFingerprint
      || planMetadata.contractFingerprint !== eligibility.contractFingerprint
      || planMetadata.terraformInputFingerprint !== eligibility.terraformInputFingerprint
      || currentPlanFingerprint !== eligibility.planFingerprint
      || runMetadata.applyStartedPlanArtifactSha256 !== eligibility.planArtifactSha256
      || runMetadata.applyStartedPlanFingerprint !== eligibility.planFingerprint
      || runMetadata.applyStartedPlanArtifactPath !== eligibility.planArtifactPath
      || runMetadata.contractFingerprint !== eligibility.contractFingerprint
      || runMetadata.terraformInputFingerprint !== eligibility.terraformInputFingerprint
      || (eligibility.approvalRequired && (
        runMetadata.applyApprovedRunId !== pipelineRunId
        || runMetadata.applyApprovalConsumedByRunId !== pipelineRunId
        || runMetadata.applyApprovalConsumedAt !== eligibility.claimedAt
      ))
      || runMetadata.terraformApplyStartedAt !== eligibility.claimedAt
    ) {
      this.finalPlanIntegrityFailure();
    }

    let finalStat;
    let finalArtifact: Buffer;
    try {
      finalStat = await lstat(planPath);
      if (!finalStat.isFile() || finalStat.isSymbolicLink() || await realpath(planPath) !== planPath) {
        this.finalPlanIntegrityFailure();
      }
      finalArtifact = await readFile(planPath);
    } catch {
      this.finalPlanIntegrityFailure();
    }
    const finalArtifactSha256 = createHash("sha256").update(finalArtifact).digest("hex");
    const finalPlanFingerprint = this.deploymentContractValidation.planFingerprint(
      finalArtifactSha256,
      eligibility.terraformInputFingerprint,
      eligibility.contractFingerprint,
      pipelineRunId,
    );
    if (
      Number(finalStat.dev) !== eligibility.planArtifactDevice
      || Number(finalStat.ino) !== eligibility.planArtifactInode
      || finalStat.size !== eligibility.planArtifactSize
      || finalStat.mtimeMs !== eligibility.planArtifactMtimeMs
      || finalArtifactSha256 !== eligibility.planArtifactSha256
      || finalPlanFingerprint !== eligibility.planFingerprint
    ) {
      this.finalPlanIntegrityFailure();
    }
    return planPath;
  }

  private finalPlanIntegrityFailure(): never {
    throw new BadRequestException({
      code: "plan_artifact_changed_before_apply",
      internalCode: "PLAN_ARTIFACT_CHANGED_BEFORE_APPLY",
      message: "The approved Terraform plan changed before apply. Generate and approve a new plan.",
    });
  }

  private async markPlanIntegrityReconciliationRequired(pipelineRunId: string, message: string) {
    const run = await this.runRepository.findOne({ where: { id: pipelineRunId } });
    if (!run) return;
    run.status = PipelineRunStatus.FAILED;
    run.currentStage = "terraform_plan_reconciliation_required";
    run.currentStageStartedAt = new Date();
    run.failedAt = new Date();
    run.errorMessage = message;
    run.metadata = {
      ...(run.metadata || {}),
      failureClass: "plan_artifact_changed_before_apply",
      reconciliationRequired: true,
      requiresNewTerraformPlan: true,
    };
    await this.runRepository.save(run);
  }

  private async markInfrastructureApplyCompleted(projectId: string, pipelineRunId: string) {
    const run = await this.runRepository.findOne({ where: { id: pipelineRunId, projectId } });
    if (!run) return;
    run.metadata = {
      ...(run.metadata || {}),
      terraformApplyCompletedAt: new Date().toISOString(),
      applyCompletedPlanFingerprint: run.metadata?.applyStartedPlanFingerprint || null,
    };
    await this.runRepository.save(run);
  }

  private applyEligibilityFailure(code: string, message: string): never {
    throw new BadRequestException({ code, message });
  }

  private nonEmptyString(value: unknown) {
    return typeof value === "string" && value.trim() ? value : null;
  }

  private normalizedBindingRevisions(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => {
        const row = item && typeof item === "object"
          ? item as Record<string, unknown>
          : {};
        return {
          id: String(row.id || ""),
          type: String(row.type || ""),
          provider: String(row.provider || ""),
          engine: String(row.engine || ""),
          configurationFingerprint: String(row.configurationFingerprint || ""),
        };
      })
      .sort((left, right) =>
        `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`),
      );
  }

  private infrastructureFailureCode(error: unknown) {
    if (!error || typeof error !== "object" || !("getResponse" in error)) return "infrastructure_apply_failed";
    const response = (error as { getResponse(): unknown }).getResponse();
    return response && typeof response === "object" && "code" in response
      ? String((response as { code?: unknown }).code || "infrastructure_apply_failed")
      : "infrastructure_apply_failed";
  }

  async parseTerraformOutputs(projectId: string, pipelineRunId: string) {
    const environment = await this.createOrGetInfrastructureEnvironment(projectId, pipelineRunId);

    if (!environment.terraformWorkspacePath) {
      throw new Error("Terraform workspace is not prepared.");
    }

    return this.terraformRunner.parseOutputs(environment.terraformWorkspacePath, this.terraformEnv());
  }

  async saveInfrastructureOutputs(projectId: string, pipelineRunId: string, outputs: Record<string, unknown>) {
    const environment = await this.createOrGetInfrastructureEnvironment(projectId, pipelineRunId);
    environment.status = InfrastructureEnvironmentStatus.PROVISIONED;
    environment.vpcId = this.stringOutput(outputs.vpc_id);
    environment.publicSubnetIds = this.arrayOutput(outputs.public_subnet_ids);
    environment.privateSubnetIds = this.arrayOutput(outputs.private_subnet_ids);
    environment.internetGatewayId = this.stringOutput(outputs.internet_gateway_id);
    environment.natGatewayIds = this.arrayOutput(outputs.nat_gateway_ids);
    environment.routeTableIds = {
      public: this.stringOutput(outputs.public_route_table_id),
      private: this.stringOutput(outputs.private_route_table_id),
    };
    environment.albSecurityGroupId = this.stringOutput(outputs.alb_security_group_id);
    environment.appSecurityGroupId = this.stringOutput(outputs.app_security_group_id);
    environment.internalSecurityGroupId = this.stringOutput(outputs.internal_security_group_id);
    environment.cloudMapNamespaceId = this.stringOutput(outputs.cloud_map_namespace_id);
    environment.cloudMapNamespaceName = this.stringOutput(outputs.cloud_map_namespace_name);
    environment.cloudMapServiceDiscoveryDomain = this.stringOutput(outputs.cloud_map_service_discovery_domain);
    environment.terraformOutputs = this.safeOutputs(outputs);
    environment.provisionedAt = new Date();
    const saved = await this.environmentRepository.save(environment);
    await this.serviceDiscoveryService.saveServiceDiscoveryRecord(projectId, saved.id, "app", outputs);
    await this.efsService.saveEfsOutputs(projectId, pipelineRunId, outputs);
    const databaseTier = await this.databaseTierRepository.findOne({ where: { projectId } });
    if (databaseTier && outputs.database_enabled === true) {
      databaseTier.status = DatabaseTierStatus.PROVISIONING;
      databaseTier.internalHost = this.stringOutput(outputs.database_internal_host);
      databaseTier.efsFileSystemId = this.stringOutput(outputs.database_efs_file_system_id);
      databaseTier.efsAccessPointId = this.stringOutput(outputs.database_efs_access_point_id);
      databaseTier.credentialsSecretArn = this.stringOutput(outputs.database_password_secret_arn);
      databaseTier.databaseUrlSecretArn = this.stringOutput(outputs.database_url_secret_arn);
      databaseTier.backupPlanId = this.stringOutput(outputs.database_backup_plan_id);
      databaseTier.lastError = null;
      await this.databaseTierRepository.save(databaseTier);
    }
    if (databaseTier?.provider === "managed") {
      await this.databaseBindings.applyTerraformOutputs(projectId, pipelineRunId, outputs, `${saved.id}:${saved.updatedAt.toISOString()}`);
    }
    await this.resourceRegistry.registerTerraformOutputs(
      projectId,
      pipelineRunId,
      saved.awsRegion || this.config.get<string>("AWS_REGION", "us-east-1"),
      saved.terraformOutputs || outputs,
    );
    await this.audit("INFRASTRUCTURE_OUTPUTS_SAVED", projectId, null, "success", { pipelineRunId, infrastructureEnvironmentId: saved.id });

    return saved;
  }

  async getInfrastructureStatus(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    const environment = await this.environmentRepository.findOne({
      where: { projectId: project.id },
      order: { createdAt: "DESC" },
    });

    return environment ? this.toEnvironmentResponse(environment) : null;
  }

  async getInfrastructureEvents(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.eventRepository.find({
      where: { projectId: project.id },
      order: { occurredAt: "ASC", sequenceNumber: "ASC" },
    });
  }

  async getServiceDiscoveryInfo(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.serviceDiscoveryRepository.find({
      where: { projectId: project.id },
      order: { createdAt: "DESC" },
    });
  }

  async assertCostGatePassed(projectId: string) {
    const estimate = await this.costEstimateRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });

    if (!estimate) {
      throw new BadRequestException("Generate a cost estimate before deployment.");
    }

    const finopsConfig = getFinopsConfig(this.config);
    const legacyTierWarning =
      !finopsConfig.enforceTierLimits &&
      estimate.status === CostEstimateStatus.BLOCKED_BY_TIER_LIMIT;
    if (![CostEstimateStatus.NO_APPROVAL_REQUIRED, CostEstimateStatus.APPROVED, CostEstimateStatus.WARNING_OVER_TIER].includes(estimate.status) && !legacyTierWarning) {
      throw new BadRequestException("Infrastructure provisioning blocked by FinOps cost gate.");
    }

    return estimate;
  }

  async recordPipelineEvent(
    run: ProjectPipelineRun,
    stage: string,
    status: string,
    message: string,
    metadata: Record<string, unknown> = {}
  ) {
    await this.pipelineEventRepository.save(
      this.pipelineEventRepository.create({
        pipelineRunId: run.id,
        projectId: run.projectId,
        stage,
        status,
        message,
        occurredAt: new Date(),
        ingestedAt: new Date(),
        source: "terraform",
        metadata: this.safeMetadata({
          projectId: run.projectId,
          pipelineRunId: run.id,
          stage,
          status,
          ...metadata,
        }),
      })
    );
  }

  async finishStateLockQueueItem(pipelineRunId: string, succeeded: boolean, reason?: string) {
    return this.stateLockService.finishQueuedDeployment(pipelineRunId, succeeded, reason);
  }

  private async createInfrastructureRun(project: Project, user: User, jobType: PipelineJobData["jobType"]) {
    let run: ProjectPipelineRun;
    run = await this.runRepository.save(
        this.runRepository.create({
        projectId: project.id,
        triggeredByUserId: user.id,
        repositoryUrl: project.repositoryUrl,
        repositoryFullName: project.repositoryFullName,
        targetBranch: project.targetBranch,
        status: PipelineRunStatus.QUEUED,
        currentStage: "deployment_queued",
        metadata: { jobType },
        })
    );
      const snapshot = await this.databaseBindings.createRunConfigurationSnapshot(project.id, run.id, "production");
      run.configurationSnapshotId = snapshot.id;
      run.metadata = {
        ...(run.metadata || {}),
        desiredStateRevision: snapshot.configurationFingerprint,
        desiredStateUpdatedAt: snapshot.createdAt?.toISOString() || new Date().toISOString(),
        configurationFingerprint: snapshot.configurationFingerprint,
        configurationSnapshotId: snapshot.id,
        configurationSnapshotCreatedAt: snapshot.createdAt?.toISOString() || new Date().toISOString(),
      };
    return await this.runRepository.save(run);
  }

  private async enqueue(run: ProjectPipelineRun, user: User, jobType: PipelineJobData["jobType"]) {
    await this.pipelineQueue.add(
      jobType,
      {
        pipelineRunId: run.id,
        projectId: run.projectId,
        triggeredByUserId: user.id,
        jobType,
        options: {
          triggerGithubActions: true,
          buildImage: true,
          pushToEcr: true,
          runTerraform: true,
        },
      },
      {
        attempts: Number(process.env.PIPELINE_JOB_ATTEMPTS || "1"),
        backoff: { type: "fixed", delay: 5000 },
      }
    );
  }

  private async saveReadinessSnapshot(
    projectId: string,
    pipelineRunId: string,
    createdByUserId: number,
    readiness: { ready: boolean; checks: Record<string, unknown>[]; blockingReasons: string[] }
  ) {
    await this.readinessSnapshotRepository.save(
      this.readinessSnapshotRepository.create({
        projectId,
        pipelineRunId,
        createdByUserId,
        ready: readiness.ready,
        checks: readiness.checks,
        blockingReasons: readiness.blockingReasons,
      })
    );
  }

  private async event(
    projectId: string,
    pipelineRunId: string | null,
    infrastructureEnvironmentId: string | null,
    eventType: string,
    status: string,
    message: string,
    actorUser?: User | null,
    metadata: Record<string, unknown> = {}
  ) {
    const savedEvent = await this.eventRepository.save(
      this.eventRepository.create({
        projectId,
        pipelineRunId,
        infrastructureEnvironmentId,
        eventType,
        status,
        message,
        source: "terraform",
        actorUserId: actorUser?.id || null,
        metadata: this.safeMetadata({
          projectId,
          pipelineRunId,
          infrastructureEnvironmentId,
          eventType,
          status,
          ...metadata,
        }),
      })
    );

    const operation = metadata.operation === "apply" ? "apply" : metadata.operation === "plan" ? "plan" : null;
    if (pipelineRunId && operation && /^state_(?:lock|heartbeat|corruption|recovery)/.test(eventType)) {
      await this.recordPipelineEventForRun(
        projectId,
        pipelineRunId,
        `terraform_${operation}_lock_${eventType}`,
        status,
        message,
        { ...metadata, infrastructureEventId: savedEvent.id, operation }
      );
    }
  }

  private async audit(
    action: string,
    projectId: string,
    actorUser: User | null,
    status: string,
    metadata: Record<string, unknown>,
    req?: RequestInfo
  ) {
    await this.auditLogService.record({
      actorUser,
      action,
      resourceType: "infrastructure",
      resourceId: projectId,
      status,
      metadata: this.safeMetadata({ projectId, ...metadata }),
      req,
    });
  }

  private async verifyStateBackend(
    project: Project,
    pipelineRunId: string,
    infrastructureEnvironmentId: string,
    actorUser?: User | null
  ) {
    const preflight = await this.terraformStateService.validateRemoteBackend(project, "dev");
    await this.event(project.id, pipelineRunId, infrastructureEnvironmentId, "state_bucket_verified", "success", "Terraform state bucket verified.", actorUser);
    await this.audit("STATE_BUCKET_VERIFIED", project.id, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId, stateKey: preflight.stateKey, lockMode: preflight.mode === "s3" ? "s3_lockfile" : "local" });
    await this.event(project.id, pipelineRunId, infrastructureEnvironmentId, "state_bucket_versioning_verified", "success", "Terraform state bucket versioning verified.", actorUser);
    await this.audit("STATE_BUCKET_VERSIONING_ENABLED", project.id, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId });
    await this.event(project.id, pipelineRunId, infrastructureEnvironmentId, "state_native_lockfile_verified", "success", "Terraform S3 native lockfile configuration verified.", actorUser);
    await this.audit("STATE_NATIVE_LOCKFILE_VERIFIED", project.id, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId, stateKey: preflight.stateKey, lockfileKey: preflight.lockfileKey });
  }

  private async validateAndPersistState(
    project: Project,
    environment: ProjectInfrastructureEnvironment,
    pipelineRunId: string,
    operation: "plan" | "apply",
    actorUser?: User | null
  ) {
    await this.updateRun(pipelineRunId, {
      status: PipelineRunStatus.STATE_VALIDATION_RUNNING,
      currentStage: "state_validation_running",
    });
    await this.event(project.id, pipelineRunId, environment.id, "state_validation_started", "running", "Terraform state validation started.", actorUser, { operation });
    await this.audit("STATE_VALIDATION_STARTED", project.id, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });
    if (!environment.terraformWorkspacePath) {
      throw new Error("Terraform workspace is missing for state validation.");
    }

    let rawState: string;

    try {
      const pulled = await this.terraformRunner.pullTerraformState(
        environment.terraformWorkspacePath,
        this.terraformEnv()
      );
      rawState = pulled.stdout;
    } catch (error) {
      if (environment.status === InfrastructureEnvironmentStatus.COST_CHECK_REQUIRED) {
        await this.event(
          project.id,
          pipelineRunId,
          environment.id,
          "state_validation_skipped_no_state",
          "skipped",
          "No applied Terraform state exists yet; validation will run after apply.",
          actorUser
        );
        return;
      }
      throw error;
    }
    if (
      environment.status === InfrastructureEnvironmentStatus.COST_CHECK_REQUIRED &&
      !rawState.trim()
    ) {
      await this.event(
        project.id,
        pipelineRunId,
        environment.id,
        "state_validation_skipped_no_state",
        "skipped",
        "No applied Terraform state exists yet; validation will run after apply.",
        actorUser,
        { operation }
      );
      return;
    }
    const result = await this.stateCorruptionService.detectCorruption(
      project.id,
      "dev",
      rawState,
      false
    );
    const stateIsSafe = [StateValidationStatus.VALID, StateValidationStatus.WARNING].includes(result.status as StateValidationStatus);
    await this.terraformStateService.upsertStateMetadata({
      project,
      environment,
      environmentName: "dev",
      rawState,
      resourceCount: result.resourceCount,
      status: stateIsSafe ? "active" : "recovery_required",
    });

    if (stateIsSafe) {
      const warning = result.status === StateValidationStatus.WARNING;
      await this.event(project.id, pipelineRunId, environment.id, warning ? "state_validation_warning" : "state_validation_passed", warning ? "warning" : "success", warning ? "Terraform state passed blocking safety checks with advisory dependency references." : "Terraform state validation passed.", actorUser, { operation, issues: result.issues || [] });
      await this.audit(warning ? "STATE_VALIDATION_WARNING" : "STATE_VALIDATION_PASSED", project.id, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id, issues: result.issues || [] });
      return;
    }

    await this.updateRun(pipelineRunId, {
      status: PipelineRunStatus.STATE_RECOVERY_REQUIRED,
      currentStage: "state_recovery_required",
    });
    await this.event(project.id, pipelineRunId, environment.id, "state_corruption_detected", "failed", "Terraform state corruption detected.", actorUser, { operation });
    await this.event(project.id, pipelineRunId, environment.id, "state_recovery_required", "failed", "State recovery decision is required.", actorUser, { operation });
    await this.audit("STATE_CORRUPTION_DETECTED", project.id, actorUser || null, "failed", { pipelineRunId, infrastructureEnvironmentId: environment.id });
    await this.audit("STATE_RECOVERY_REQUIRED", project.id, actorUser || null, "failed", { pipelineRunId, infrastructureEnvironmentId: environment.id });
    throw new Error(`Terraform state recovery is required: ${(result.issues || []).join(" ") || "blocking state validation failed."}`);
  }

  private async releaseStateLock(
    lockId: string,
    pipelineRunId: string,
    projectId: string,
    infrastructureEnvironmentId: string,
    operation: "plan" | "apply",
    actorUser?: User | null
  ) {
    await this.stateHeartbeatService.stopHeartbeat(lockId, pipelineRunId);
    await this.event(projectId, pipelineRunId, infrastructureEnvironmentId, "state_heartbeat_stopped", "success", "Terraform state heartbeat stopped.", actorUser, { operation });
    await this.audit("STATE_HEARTBEAT_STOPPED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId });
    try {
      await this.stateLockService.releaseLock(lockId, pipelineRunId);
    } catch (error) {
      const message = "Terraform state lock release failed and must be retried.";
      await this.updateRun(pipelineRunId, {
        status: PipelineRunStatus.STATE_LOCK_FAILED,
        currentStage: "state_lock_release_failed",
      });
      await this.event(projectId, pipelineRunId, infrastructureEnvironmentId, "state_lock_release_failed", "failed", message, actorUser, { operation });
      throw error;
    }
    await this.updateRun(pipelineRunId, {
      status: PipelineRunStatus.STATE_LOCK_RELEASED,
      currentStage: "state_lock_released",
    });
    await this.event(projectId, pipelineRunId, infrastructureEnvironmentId, "state_lock_released", "success", "Terraform state lock released.", actorUser, { operation });
    await this.audit("STATE_LOCK_RELEASED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId });
    const next = await this.stateLockService.processNextQueuedDeployment(projectId);

    if (next) {
      const queuedRun = await this.runRepository.findOne({
        where: { id: next.pipelineRunId, projectId },
      });
      const operation = next.metadata?.operation === "apply" ? "apply" : "plan";

      if (queuedRun) {
        await this.pipelineQueue.add(
          "resumeAfterStateLock",
          {
            pipelineRunId: queuedRun.id,
            projectId,
            triggeredByUserId: queuedRun.triggeredByUserId,
            jobType: "resume_after_state_lock",
            resumeOperation: operation,
            options: {
              triggerGithubActions: false,
              buildImage: false,
              pushToEcr: false,
              runTerraform: true,
            },
          },
          { jobId: `state-lock-${next.id}` }
        );
      }
    }
  }

  private async updateRun(pipelineRunId: string, patch: Partial<ProjectPipelineRun>) {
    const run = await this.runRepository.findOne({ where: { id: pipelineRunId } });

    if (!run) return;

    if (patch.currentStage && patch.currentStage !== run.currentStage && !patch.currentStageStartedAt) patch.currentStageStartedAt = new Date();
    Object.assign(run, patch);
    await this.runRepository.save(run);
  }

  private async findProjectForView(user: User, projectId: string) {
    const project = await this.requireProject(projectId);

    if (
      user.role === UserRole.ADMIN ||
      project.ownerUserId === user.id ||
      (user.role === UserRole.READONLY && project.visibility === ProjectVisibility.WORKSPACE)
    ) {
      return project;
    }

    throw new ForbiddenException("Insufficient permissions");
  }

  private async findProjectForManage(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);

    if (user.role === UserRole.READONLY) {
      throw new ForbiddenException("Insufficient permissions");
    }

    if (user.role === UserRole.ADMIN || project.ownerUserId === user.id) {
      return project;
    }

    throw new ForbiddenException("Insufficient permissions");
  }

  private async requireProject(projectId: string) {
    const project = await this.projectRepository.findOne({ where: { id: projectId } });

    if (!project || project.status === ProjectStatus.ARCHIVED) {
      throw new NotFoundException("Project not found");
    }

    return project;
  }

  private terraformEnv(): NodeJS.ProcessEnv {
    return {
      AWS_REGION: this.config.get<string>("AWS_REGION", ""),
      AWS_ACCESS_KEY_ID: this.config.get<string>("AWS_ACCESS_KEY_ID", ""),
      AWS_SECRET_ACCESS_KEY: this.config.get<string>("AWS_SECRET_ACCESS_KEY", ""),
      AWS_SESSION_TOKEN: this.config.get<string>("AWS_SESSION_TOKEN", ""),
    };
  }

  private summarizePlan(rawJson: string) {
    try {
      const parsed = JSON.parse(rawJson || "{}") as {
        resource_changes?: Array<{ change?: { actions?: string[] } }>;
      };
      const counts = { create: 0, update: 0, replace: 0, delete: 0, noOp: 0 };

      for (const resource of parsed.resource_changes || []) {
        const actions = resource.change?.actions || [];
        if (actions.includes("create") && actions.includes("delete")) counts.replace += 1;
        else if (actions.includes("create")) counts.create += 1;
        else if (actions.includes("update")) counts.update += 1;
        else if (actions.includes("delete")) counts.delete += 1;
        else counts.noOp += 1;
      }

      return counts;
    } catch {
      return { create: 0, update: 0, replace: 0, delete: 0, noOp: 0 };
    }
  }

  private safeOutputs(outputs: Record<string, unknown>) {
    const allowed = [
      "vpc_id",
      "public_subnet_ids",
      "private_subnet_ids",
      "internet_gateway_id",
      "nat_gateway_ids",
      "public_route_table_id",
      "private_route_table_id",
      "alb_security_group_id",
      "app_security_group_id",
      "internal_security_group_id",
      "cloud_map_namespace_id",
      "cloud_map_namespace_name",
      "cloud_map_service_discovery_domain",
      "default_cloud_map_service_id",
      "efs_enabled",
      "efs_file_system_id",
      "efs_file_system_arn",
      "efs_dns_name",
      "efs_access_point_id",
      "efs_access_point_arn",
      "efs_security_group_id",
      "efs_kms_key_id",
      "efs_kms_key_arn",
      "efs_mount_target_ids",
      "efs_root_directory",
      "efs_posix_uid",
      "efs_posix_gid",
      "efs_root_permissions",
      "efs_backup_enabled",
      "efs_backup_vault_name",
      "efs_backup_plan_id",
      "alb_arn",
      "alb_dns_name",
      "alb_target_group_arn",
      "alb_listener_arn",
      "alb_health_check_path",
      "ecs_cluster_arn",
      "ecs_cluster_name",
      "ecs_service_arn",
      "ecs_service_name",
      "ecs_task_definition_arn",
      "ecs_capacity_provider_strategy",
      "ecs_desired_count",
      "ecs_min_tasks",
      "ecs_max_tasks",
      "ecs_cpu_target_percent",
      "ecs_container_name",
      "ecs_container_port",
      "ecs_log_group_name",
      "spot_event_rule_name",
      "spot_event_rule_arn",
      "spot_event_log_group_name",
      "database_enabled",
      "database_internal_host",
      "database_port",
      "database_service_arn",
      "database_task_definition_arn",
      "database_cloud_map_service_arn",
      "database_cloud_map_service_id",
      "database_efs_file_system_id",
      "database_efs_access_point_id",
      "database_password_secret_arn",
      "database_url_secret_arn",
      "database_backup_plan_id",
    ];

    return Object.entries(outputs).reduce(
      (safe, [key, value]) => {
        if (allowed.includes(key)) {
          safe[key] = value;
        }
        return safe;
      },
      {} as Record<string, unknown>
    );
  }

  private async assertWorkspaceInsideRoot(workdir: string, rootDir: string) {
    const root = await realpath(resolve(rootDir));
    const workspace = await realpath(resolve(workdir));
    const fromRoot = relative(root, workspace);
    if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new BadRequestException("Terraform workspace escaped the configured workspace root.");
    }
    const stats = await lstat(workspace);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new BadRequestException("Terraform workspace must be a real directory.");
    }
  }

  private async prepareBackendMode(workdir: string, mode: "local" | "s3") {
    const markerPath = join(workdir, ".deployguard-backend-mode.json");
    let previousMode: string | null = null;
    try {
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as { mode?: string };
      previousMode = marker.mode || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }

    if (previousMode && previousMode !== mode) {
      const statePaths = [join(workdir, "terraform.tfstate"), join(workdir, ".terraform", "terraform.tfstate")];
      for (const statePath of statePaths) {
        try {
          const stats = await lstat(statePath);
          if (stats.size > 0) {
            throw new BadRequestException(
              `Terraform backend mode changed from ${previousMode} to ${mode}; explicit state migration or a new run workspace is required.`
            );
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await rm(join(workdir, ".terraform"), { recursive: true, force: true });
    }

    await writeFile(markerPath, JSON.stringify({ mode, version: 1 }, null, 2), "utf8");
  }

  private async writeBackendDeclaration(workdir: string, mode: "local" | "s3") {
    const versionsPath = join(workdir, "versions.tf");
    const original = await readFile(versionsPath, "utf8");
    const declaration = mode === "local"
      ? 'backend "local" {\n    path = "terraform.tfstate"\n  }'
      : 'backend "s3" {}';
    const updated = original.replace(/backend\s+"(?:s3|local)"\s*\{[^}]*\}/m, declaration);
    if (updated === original && !/backend\s+"(?:s3|local)"/.test(original)) {
      throw new Error("Terraform template does not contain a supported backend declaration.");
    }
    await writeFile(versionsPath, updated, "utf8");
    if (mode === "local") await rm(join(workdir, "backend.hcl"), { force: true });
  }

  private async recordPipelineEventForRun(
    projectId: string,
    pipelineRunId: string,
    stage: string,
    status: string,
    message: string,
    metadata: Record<string, unknown>
  ) {
    const run = await this.runRepository.findOne({ where: { id: pipelineRunId, projectId } });
    if (run) await this.recordPipelineEvent(run, stage, status, message, metadata);
  }

  private safeMetadata(metadata: Record<string, unknown>) {
    const allowed = [
      "projectId",
      "pipelineRunId",
      "infrastructureEnvironmentId",
      "eventType",
      "status",
      "ready",
      "blockingReasons",
      "vpcId",
      "reason",
      "stage",
      "create",
      "update",
      "delete",
      "noOp",
      "backendMode",
      "operation",
      "infrastructureEventId",
    ];

    return Object.entries(metadata).reduce(
      (safe, [key, value]) => {
        if (allowed.includes(key) && value !== undefined) {
          safe[key] = value;
        }
        return safe;
      },
      {} as Record<string, unknown>
    );
  }

  private stringOutput(value: unknown) {
    return value === undefined || value === null ? null : String(value);
  }

  private arrayOutput(value: unknown) {
    return Array.isArray(value) ? value.map(String) : [];
  }

  private async buildValidatedTerraformInputs(
    project: Project,
    contract: ProjectDeploymentContract,
    pipelineRunId: string,
  ): Promise<{
    canonical: CanonicalDeploymentContract;
    taskDefinitionDraft: EcsTaskDefinitionDraft;
    terraformVariables: Record<string, unknown>;
    terraformInputFingerprint: string;
    bindingRevisions: Array<Record<string, unknown>>;
  }> {
    await this.databaseBindings.assertRunConfigurationCurrent(project.id, pipelineRunId);
    const effective = await this.databaseBindings.resolveEffectiveDeploymentConfiguration(
      project.id,
      pipelineRunId,
      "production",
      { requireReady: false, useSnapshot: true, throwOnBlockers: false },
    );
    const run = await this.runRepository.findOne({ where: { id: pipelineRunId, projectId: project.id } });
    const imageDigest = typeof run?.metadata?.imageDigest === "string"
      ? run.metadata.imageDigest
      : run?.ecrImageUri || null;
    const canonical = this.deploymentContractValidation.buildCanonicalContract(
      project.id,
      "production",
      contract,
      effective,
      imageDigest,
    );
    this.deploymentContractValidation.assertSemantic(project.id, contract, effective, canonical);
    const terraformVariables = await this.renderTerraformVariables(
      project,
      contract,
      pipelineRunId,
      effective,
    );
    const terraformInputFingerprint = this.deploymentContractValidation.terraformInputFingerprint(
      terraformVariables,
      canonical,
    );
    const taskDefinitionDraft = this.deploymentContractValidation.taskDefinitionDraft(
      terraformVariables,
      canonical.contractFingerprint,
      terraformInputFingerprint,
    );
    this.deploymentContractValidation.assertRenderedDraft(canonical, taskDefinitionDraft);
    return {
      canonical,
      taskDefinitionDraft,
      terraformVariables,
      terraformInputFingerprint,
      bindingRevisions: effective.serviceBindingRevisions,
    };
  }

  private async buildEcsTerraformVariables(
    project: Project,
    contract: ProjectDeploymentContract,
    pipelineRunId: string | null,
    effectiveConfiguration?: EffectiveDeploymentConfiguration,
  ) {
    const config = getOrchestrationConfig(this.config);
    const run = pipelineRunId
      ? await this.runRepository.findOne({ where: { id: pipelineRunId, projectId: project.id } })
      : null;
    const enableEcs = Boolean(
      run?.ecrImageUri && run?.commitSha && /^[0-9a-f]{40}$/i.test(run.commitSha)
    );
    const effective = effectiveConfiguration || await this.databaseBindings.resolveEffectiveDeploymentConfiguration(
      project.id,
      pipelineRunId,
      "production",
      { requireReady: false, useSnapshot: Boolean(pipelineRunId) },
    );
    const environmentVariables = Object.fromEntries(Object.entries(effective.runtimeVariables).map(([key, value]) => [key, { value, isSecret: false }]));
    const allowedRuntimeKeys = new Set(
      contract.ecsPlan.environmentMappings
        .map((mapping) => mapping.name)
    );
    const runtimeEnvironmentVariables = Object.fromEntries(
      Object.entries(environmentVariables)
        .filter(([key, variable]) => allowedRuntimeKeys.has(key) && !variable.isSecret)
        .map(([key, variable]) => [key, variable.value])
    );
    const allowedSecretKeys = new Set(contract.ecsPlan.secretMappings.map((mapping) => mapping.name));
    const projectSecretKeys = new Set(contract.ecsPlan.secretMappings.filter((mapping) => mapping.source === "project_secret").map((mapping) => mapping.name));
    const runtimeSecretEnvironmentVariables = Object.fromEntries(Object.entries(effective.projectSecretValues).filter(([key]) => projectSecretKeys.has(key)));
    const databaseSecretAliasTypes = Object.fromEntries(Object.entries(effective.secretReferences)
      .filter(([key]) => allowedSecretKeys.has(key) && effective.ownership[key]?.owner === "managed_service")
      .map(([key]) => [key, serviceAlias(key, effective.binding?.engine || contract.databaseEngine || "postgres")?.property === "url" ? "url" : "password"]));
    if (contract.runtimeType === "server") {
      runtimeEnvironmentVariables.HOST = runtimeEnvironmentVariables.HOST || "0.0.0.0";
      runtimeEnvironmentVariables.PORT = String(contract.ecsPlan.containerPort);
    }
    const database = effective.binding ? {
      ...contract.ecsPlan.database,
      provider: effective.binding.provider,
      engine: effective.binding.engine,
      host: effective.binding.hostReference,
      port: effective.binding.port,
      databaseName: effective.binding.databaseName,
      databaseUser: effective.binding.usernameReference,
    } : contract.ecsPlan.database;
    const databaseProfile = managedDatabaseProfile(database.engine) || managedDatabaseProfile("postgres")!;
    if (database.provider === "managed" && (!database.databaseName || !database.databaseUser || !database.host)) {
      throw new BadRequestException("Managed database bindings are incomplete. Resolve deployment requirements before Terraform planning.");
    }
    if (database.required && database.provider && database.provider !== "none") {
      if (database.host) runtimeEnvironmentVariables.DB_HOST = database.host;
      if (database.port) runtimeEnvironmentVariables.DB_PORT = String(database.port);
      if (database.databaseName) runtimeEnvironmentVariables.DB_NAME = database.databaseName;
      if (database.databaseUser) runtimeEnvironmentVariables.DB_USER = database.databaseUser;
    }
    const backendUrl = this.config.get<string>("BACKEND_URL", "").replace(/\/$/, "");
    const spotSecret = this.config.get<string>(
      "DEPLOYGUARD_SPOT_EVENT_WEBHOOK_SECRET",
      ""
    );
    const spotEndpoint = /^https:\/\//i.test(backendUrl)
      ? `${backendUrl}/api/projects/${project.id}/orchestration/spot-event`
      : "";

    return {
      enable_ecs_service: enableEcs,
      ecs_container_image: enableEcs ? run!.ecrImageUri : "",
      ecs_container_name: "app",
      ecs_task_cpu: contract.ecsPlan.cpu,
      ecs_task_memory: contract.ecsPlan.memory,
      ecs_environment_variables: runtimeEnvironmentVariables,
      ecs_secret_environment_variables: runtimeSecretEnvironmentVariables,
      database_secret_alias_types: databaseSecretAliasTypes,
      database_service: {
        enabled: enableEcs && database.provider === "managed",
        engine: database.engine || "postgres",
        image: database.image || databaseProfile.image,
        port: database.port || databaseProfile.port,
        cpu: 512,
        memory: 1024,
        database_name: database.databaseName || "",
        database_user: database.databaseUser || "",
        efs_enabled: database.persistenceEnabled,
        efs_mount_path: database.dataPath || databaseProfile.dataPath,
        cloud_map_name: "db",
        persistence_enabled: database.persistenceEnabled,
        backup_enabled: database.persistenceEnabled,
      },
      ecs_use_fargate_spot: config.useFargateSpot,
      ecs_enable_fargate_fallback: config.enableFargateFallback,
      ecs_desired_count: database.provider === "managed" ? 0 : config.minTasks,
      ecs_min_tasks: config.minTasks,
      ecs_max_tasks: config.maxTasks,
      ecs_cpu_target_percent: config.cpuTargetPercent,
      ecs_healthcheck_grace_seconds: config.healthcheckGraceSeconds,
      ecs_container_insights: config.containerInsights,
      alb_health_check_path: contract.ecsPlan.healthCheckPath,
      enable_eventbridge_spot_rule: config.enableEventBridgeSpotRule,
      spot_event_api_destination_endpoint: spotEndpoint,
      spot_event_api_destination_secret: spotEndpoint ? spotSecret : "",
    };
  }

  private publicError(error: unknown) {
    if (error && typeof error === "object" && "getResponse" in error) {
      const response = (error as { getResponse(): unknown }).getResponse();
      if (response && typeof response === "object") {
        const code = String((response as { code?: unknown }).code || "");
        const responseMessage = (response as { message?: unknown }).message;
        if (code === "contract_invalid") {
          return "DeployGuard needs one application configuration fix before deployment can continue. No cloud resources were changed.";
        }
        if (code === "plan_policy_failed") {
          return "DeployGuard stopped an unsafe application configuration before cloud changes. Generate a corrected plan.";
        }
        if (
          [
            "run_not_found",
            "run_superseded",
            "run_stale",
            "run_terminal",
            "apply_already_started",
            "apply_already_completed",
            "configuration_changed",
            "plan_missing",
            "plan_stale",
            "plan_expired",
            "approval_missing",
            "approval_expired",
            "approval_stale",
            "approval_consumed",
            "plan_artifact_changed_before_apply",
          ].includes(code)
          && typeof responseMessage === "string"
        ) {
          return responseMessage;
        }
      }
    }
    const message = error instanceof Error ? error.message : "Infrastructure operation failed.";

    if (
      message === "Terraform state region is not configured." ||
      message === "AWS credentials cannot access Terraform state bucket or lockfile." ||
      /^Terraform state bucket .+ was not found or is not accessible\.$/.test(message) ||
      /^Terraform S3 lockfile (?:exists and may be stale|is currently active)\. Lockfile: projects\/[0-9a-f-]+\/terraform\.tfstate\.tflock$/i.test(message)
    ) {
      return message;
    }

    if (/AWS credentials are missing or invalid/i.test(message)) {
      return "AWS credentials are missing or invalid. Configure backend AWS credentials before deployment.";
    }

    if (/secret|password|token|credential|access.?key/i.test(message)) {
      return "Infrastructure operation failed because required cloud configuration is invalid or missing.";
    }

    return message;
  }

  private toEnvironmentResponse(environment: ProjectInfrastructureEnvironment) {
    return {
      id: environment.id,
      projectId: environment.projectId,
      pipelineRunId: environment.pipelineRunId,
      environmentName: environment.environmentName,
      environmentType: environment.environmentType,
      ttlExpiresAt: environment.ttlExpiresAt,
      autoDestroyEnabled: environment.autoDestroyEnabled,
      cleanupStatus: environment.cleanupStatus,
      status: environment.status,
      awsRegion: environment.awsRegion,
      vpcId: environment.vpcId,
      publicSubnetIds: environment.publicSubnetIds,
      privateSubnetIds: environment.privateSubnetIds,
      internetGatewayId: environment.internetGatewayId,
      natGatewayIds: environment.natGatewayIds,
      routeTableIds: environment.routeTableIds,
      albSecurityGroupId: environment.albSecurityGroupId,
      appSecurityGroupId: environment.appSecurityGroupId,
      internalSecurityGroupId: environment.internalSecurityGroupId,
      cloudMapNamespaceId: environment.cloudMapNamespaceId,
      cloudMapNamespaceName: environment.cloudMapNamespaceName,
      cloudMapServiceDiscoveryDomain: environment.cloudMapServiceDiscoveryDomain,
      terraformPlanSummary: environment.terraformPlanSummary,
      errorMessage: environment.errorMessage,
      provisionedAt: environment.provisionedAt,
      failedAt: environment.failedAt,
      createdAt: environment.createdAt,
      updatedAt: environment.updatedAt,
    };
  }
}
