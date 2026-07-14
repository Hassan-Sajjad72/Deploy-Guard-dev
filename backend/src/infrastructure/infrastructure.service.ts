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
import { cp, mkdir, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { CostEstimateStatus, ProjectCostEstimate } from "../finops/project-cost-estimate.entity";
import { getFinopsConfig } from "../finops/finops.config";
import { ProjectDetectionProfile } from "../projects/project-detection-profile.entity";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import {
  PipelineRunStatus,
  ProjectPipelineRun,
} from "../projects/project-pipeline-run.entity";
import { Project, ProjectStatus, ProjectVisibility } from "../projects/project.entity";
import { PIPELINE_QUEUE, PipelineJobData } from "../projects/pipeline/pipeline.types";
import { User, UserRole } from "../users/user.entity";
import { StateCorruptionService } from "../state-management/state-corruption.service";
import { StateHeartbeatService } from "../state-management/state-heartbeat.service";
import { StateLockService } from "../state-management/state-lock.service";
import { TerraformStateService } from "../state-management/terraform-state.service";
import { getStateManagementConfig } from "../state-management/state-management.config";
import { getOrchestrationConfig } from "../orchestration/orchestration.config";
import { EfsService } from "../storage/efs.service";
import { StoragePolicyService } from "../storage/storage-policy.service";
import { getInfrastructureConfig } from "./infrastructure.config";
import { InfrastructureReadinessService } from "./infrastructure-readiness.service";
import {
  InfrastructureEnvironmentStatus,
  ProjectInfrastructureEnvironment,
} from "./project-infrastructure-environment.entity";
import { ProjectInfrastructureEvent } from "./project-infrastructure-event.entity";
import { ProjectServiceDiscoveryRecord } from "./project-service-discovery-record.entity";
import { ProjectDeploymentReadinessSnapshot } from "./project-deployment-readiness-snapshot.entity";
import { ServiceDiscoveryService } from "./service-discovery.service";
import { TerraformRunnerService } from "./terraform-runner.service";

type RequestInfo = Request | undefined;

@Injectable()
export class InfrastructureService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectDetectionProfile)
    private readonly profileRepository: Repository<ProjectDetectionProfile>,
    @InjectRepository(ProjectEnvironmentVariable)
    private readonly envRepository: Repository<ProjectEnvironmentVariable>,
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
    private readonly storagePolicyService: StoragePolicyService,
    private readonly efsService: EfsService
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
        status: InfrastructureEnvironmentStatus.NOT_PROVISIONED,
        awsRegion: infraConfig.awsRegion,
      })
    );
  }

  async prepareInfrastructureWorkspace(projectId: string, pipelineRunId: string) {
    const infraConfig = getInfrastructureConfig(this.config);
    const workdir = join(infraConfig.terraformWorkingBaseDir, projectId, pipelineRunId);

    await mkdir(workdir, { recursive: true });
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

    return workdir;
  }

  async renderTerraformVariables(
    project: Project,
    profile: ProjectDetectionProfile | null,
    pipelineRunId?: string | null
  ) {
    const infraConfig = getInfrastructureConfig(this.config);
    const namespaceBase = infraConfig.cloudMapNamespace.replace(/^\.+|\.+$/g, "");
    const efsVars = await this.storagePolicyService.buildEfsTerraformVariables(project.id, "dev");
    const ecsVars = await this.buildEcsTerraformVariables(project, profile, pipelineRunId || null);
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
      app_port: profile?.expectedPort || infraConfig.defaultAppPort,
      tags: {
        Project: "DeployGuard",
        ManagedBy: "DeployGuard",
        DeployGuardProjectId: project.id,
        Environment: "dev",
      },
      ...efsVars,
      ...ecsVars,
    };

    return vars;
  }

  async runInfrastructurePlan(projectId: string, pipelineRunId: string, actorUser?: User | null) {
    const project = await this.requireProject(projectId);
    const profile = await this.profileRepository.findOne({ where: { projectId } });
    const environment = await this.createOrGetInfrastructureEnvironment(projectId, pipelineRunId);
    const workdir = await this.prepareInfrastructureWorkspace(projectId, pipelineRunId);
    const vars = await this.renderTerraformVariables(project, profile, pipelineRunId);
    const lockId = this.stateLockService.buildLockId(projectId, "dev");
    let lockAcquired = false;

    environment.status = InfrastructureEnvironmentStatus.PLANNING;
    environment.terraformWorkspacePath = workdir;
    environment.terraformStateKey = this.terraformStateService.buildStateKey(project, "dev");
    await this.environmentRepository.save(environment);
    await writeFile(join(workdir, "terraform.tfvars.json"), JSON.stringify(vars, null, 2), "utf8");
    await this.event(projectId, pipelineRunId, environment.id, "infrastructure_plan_started", "running", "Terraform plan started.", actorUser);
    await this.audit("INFRASTRUCTURE_PLAN_STARTED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });

    try {
      await this.verifyStateBackend(project, pipelineRunId, environment.id, actorUser);
      await this.event(projectId, pipelineRunId, environment.id, "state_lock_acquire_started", "running", "Terraform state lock acquisition started.", actorUser);
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
        await this.event(projectId, pipelineRunId, environment.id, "state_lock_waiting", "queued", "Deployment queued behind existing Terraform state lock.", actorUser);
        await this.audit("STATE_LOCK_WAITING", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });
        await this.audit("DEPLOYMENT_QUEUED_FOR_STATE_LOCK", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });
        return environment;
      }

      lockAcquired = true;
      await this.updateRun(pipelineRunId, {
        status: PipelineRunStatus.STATE_LOCK_ACQUIRED,
        currentStage: "state_lock_acquired",
      });
      await this.event(projectId, pipelineRunId, environment.id, "state_lock_acquired", "success", "Terraform state lock acquired.", actorUser);
      await this.audit("STATE_LOCK_ACQUIRED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });
      await this.stateHeartbeatService.startHeartbeat(lockId, pipelineRunId);
      await this.updateRun(pipelineRunId, {
        status: PipelineRunStatus.STATE_HEARTBEAT_ACTIVE,
        currentStage: "state_heartbeat_active",
      });
      await this.event(projectId, pipelineRunId, environment.id, "state_heartbeat_started", "success", "Terraform state heartbeat started.", actorUser);
      await this.audit("STATE_HEARTBEAT_STARTED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });

      const env = this.terraformEnv();
      const stateConfig = getStateManagementConfig(this.config);
      const backendConfigPath = stateConfig.mockMode
        ? null
        : await this.terraformStateService.writeBackendConfig(workdir, project, "dev");
      await this.event(projectId, pipelineRunId, environment.id, "state_backend_config_generated", "success", stateConfig.mockMode ? "Terraform local backend selected for mock state mode." : "Terraform backend config generated.", actorUser);
      await this.terraformRunner.runTerraformInit(workdir, env, backendConfigPath);
      await this.terraformRunner.runTerraformValidate(workdir, env);
      const plan = await this.terraformRunner.runTerraformPlan(workdir, env);
      const show = await this.terraformRunner.runTerraformShowJson(workdir, env);
      const planSummary = this.summarizePlan(show.stdout);

      environment.status = InfrastructureEnvironmentStatus.COST_CHECK_REQUIRED;
      environment.terraformPlanSummary = planSummary;
      environment.metadata = { planLog: plan.stdout || plan.stderr || null };
      await this.environmentRepository.save(environment);
      await this.event(projectId, pipelineRunId, environment.id, "infrastructure_plan_completed", "success", "Terraform plan completed.", actorUser, planSummary);
      await this.audit("INFRASTRUCTURE_PLAN_COMPLETED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });
      await this.validateAndPersistState(project, environment, pipelineRunId, actorUser);
      await this.releaseStateLock(lockId, pipelineRunId, projectId, environment.id, actorUser);

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
        await this.releaseStateLock(lockId, pipelineRunId, projectId, environment.id, actorUser);
      }
      throw error;
    }
  }

  async runInfrastructureApply(projectId: string, pipelineRunId: string, actorUser?: User | null) {
    await this.assertCostGatePassed(projectId);
    const infraConfig = getInfrastructureConfig(this.config);
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
    const project = await this.requireProject(projectId);
    const lockId = this.stateLockService.buildLockId(projectId, "dev");
    let lockAcquired = false;
    freshEnvironment.status = InfrastructureEnvironmentStatus.PROVISIONING;
    await this.environmentRepository.save(freshEnvironment);
    await this.event(projectId, pipelineRunId, freshEnvironment.id, "infrastructure_apply_started", "running", "Terraform apply started.", actorUser);
    await this.audit("INFRASTRUCTURE_APPLY_STARTED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: freshEnvironment.id });

    try {
      await this.verifyStateBackend(project, pipelineRunId, freshEnvironment.id, actorUser);
      await this.event(projectId, pipelineRunId, freshEnvironment.id, "state_lock_acquire_started", "running", "Terraform state lock acquisition started.", actorUser);
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
        await this.event(projectId, pipelineRunId, freshEnvironment.id, "state_lock_waiting", "queued", "Deployment queued behind existing Terraform state lock.", actorUser);
        await this.audit("STATE_LOCK_WAITING", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: freshEnvironment.id });
        return freshEnvironment;
      }

      lockAcquired = true;
      await this.stateHeartbeatService.startHeartbeat(lockId, pipelineRunId);
      await this.event(projectId, pipelineRunId, freshEnvironment.id, "state_heartbeat_started", "success", "Terraform state heartbeat started.", actorUser);
      const env = this.terraformEnv();
      await this.terraformRunner.runTerraformApply(freshEnvironment.terraformWorkspacePath, env);
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
      await this.validateAndPersistState(project, saved, pipelineRunId, actorUser);
      await this.releaseStateLock(lockId, pipelineRunId, projectId, saved.id, actorUser);

      return saved;
    } catch (error) {
      const message = this.publicError(error);
      freshEnvironment.status = InfrastructureEnvironmentStatus.FAILED;
      freshEnvironment.errorMessage = message;
      freshEnvironment.failedAt = new Date();
      await this.environmentRepository.save(freshEnvironment);
      await this.event(projectId, pipelineRunId, freshEnvironment.id, "infrastructure_apply_failed", "failed", message, actorUser);
      await this.audit("INFRASTRUCTURE_APPLY_FAILED", projectId, actorUser || null, "failed", { pipelineRunId, infrastructureEnvironmentId: freshEnvironment.id, reason: message });
      if (lockAcquired) {
        await this.releaseStateLock(lockId, pipelineRunId, projectId, freshEnvironment.id, actorUser);
      }
      throw error;
    }
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
      order: { createdAt: "ASC" },
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

  private async createInfrastructureRun(project: Project, user: User, jobType: PipelineJobData["jobType"]) {
    return this.runRepository.save(
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
    await this.eventRepository.save(
      this.eventRepository.create({
        projectId,
        pipelineRunId,
        infrastructureEnvironmentId,
        eventType,
        status,
        message,
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
    await this.terraformStateService.ensureStateBucket();
    await this.event(project.id, pipelineRunId, infrastructureEnvironmentId, "state_bucket_verified", "success", "Terraform state bucket verified.", actorUser);
    await this.audit("STATE_BUCKET_VERIFIED", project.id, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId });
    await this.terraformStateService.ensureStateBucketVersioning();
    await this.event(project.id, pipelineRunId, infrastructureEnvironmentId, "state_bucket_versioning_verified", "success", "Terraform state bucket versioning verified.", actorUser);
    await this.audit("STATE_BUCKET_VERSIONING_ENABLED", project.id, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId });
    await this.terraformStateService.ensureStateBucketEncryption();
    await this.terraformStateService.ensureStateBucketPublicAccessBlock();
    await this.terraformStateService.ensureLockTable();
    await this.event(project.id, pipelineRunId, infrastructureEnvironmentId, "state_lock_table_verified", "success", "Terraform state lock table verified.", actorUser);
    await this.audit("STATE_LOCK_TABLE_VERIFIED", project.id, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId });
  }

  private async validateAndPersistState(
    project: Project,
    environment: ProjectInfrastructureEnvironment,
    pipelineRunId: string,
    actorUser?: User | null
  ) {
    await this.updateRun(pipelineRunId, {
      status: PipelineRunStatus.STATE_VALIDATION_RUNNING,
      currentStage: "state_validation_running",
    });
    await this.event(project.id, pipelineRunId, environment.id, "state_validation_started", "running", "Terraform state validation started.", actorUser);
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
    const result = await this.stateCorruptionService.detectCorruption(
      project.id,
      "dev",
      rawState,
      false
    );
    await this.terraformStateService.upsertStateMetadata({
      project,
      environment,
      environmentName: "dev",
      rawState,
      resourceCount: result.resourceCount,
      status: result.status === "valid" ? "active" : "recovery_required",
    });

    if (result.status === "valid") {
      await this.event(project.id, pipelineRunId, environment.id, "state_validation_passed", "success", "Terraform state validation passed.", actorUser);
      await this.audit("STATE_VALIDATION_PASSED", project.id, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId: environment.id });
      return;
    }

    await this.updateRun(pipelineRunId, {
      status: PipelineRunStatus.STATE_RECOVERY_REQUIRED,
      currentStage: "state_recovery_required",
    });
    await this.event(project.id, pipelineRunId, environment.id, "state_corruption_detected", "failed", "Terraform state corruption detected.", actorUser);
    await this.event(project.id, pipelineRunId, environment.id, "state_recovery_required", "failed", "State recovery decision is required.", actorUser);
    await this.audit("STATE_CORRUPTION_DETECTED", project.id, actorUser || null, "failed", { pipelineRunId, infrastructureEnvironmentId: environment.id });
    await this.audit("STATE_RECOVERY_REQUIRED", project.id, actorUser || null, "failed", { pipelineRunId, infrastructureEnvironmentId: environment.id });
    throw new Error("Terraform state recovery is required before continuing.");
  }

  private async releaseStateLock(
    lockId: string,
    pipelineRunId: string,
    projectId: string,
    infrastructureEnvironmentId: string,
    actorUser?: User | null
  ) {
    await this.stateHeartbeatService.stopHeartbeat(lockId, pipelineRunId);
    await this.event(projectId, pipelineRunId, infrastructureEnvironmentId, "state_heartbeat_stopped", "success", "Terraform state heartbeat stopped.", actorUser);
    await this.audit("STATE_HEARTBEAT_STOPPED", projectId, actorUser || null, "success", { pipelineRunId, infrastructureEnvironmentId });
    await this.stateLockService.releaseLock(lockId, pipelineRunId);
    await this.updateRun(pipelineRunId, {
      status: PipelineRunStatus.STATE_LOCK_RELEASED,
      currentStage: "state_lock_released",
    });
    await this.event(projectId, pipelineRunId, infrastructureEnvironmentId, "state_lock_released", "success", "Terraform state lock released.", actorUser);
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
    };
  }

  private summarizePlan(rawJson: string) {
    try {
      const parsed = JSON.parse(rawJson || "{}") as {
        resource_changes?: Array<{ change?: { actions?: string[] } }>;
      };
      const counts = { create: 0, update: 0, delete: 0, noOp: 0 };

      for (const resource of parsed.resource_changes || []) {
        const actions = resource.change?.actions || [];
        if (actions.includes("create")) counts.create += 1;
        else if (actions.includes("update")) counts.update += 1;
        else if (actions.includes("delete")) counts.delete += 1;
        else counts.noOp += 1;
      }

      return counts;
    } catch {
      return { create: 0, update: 0, delete: 0, noOp: 0 };
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

  private async buildEcsTerraformVariables(
    project: Project,
    profile: ProjectDetectionProfile | null,
    pipelineRunId: string | null
  ) {
    const config = getOrchestrationConfig(this.config);
    const run = pipelineRunId
      ? await this.runRepository.findOne({ where: { id: pipelineRunId, projectId: project.id } })
      : null;
    const enableEcs = Boolean(
      run?.ecrImageUri && run?.commitSha && /^[0-9a-f]{40}$/i.test(run.commitSha)
    );
    const framework = (profile?.framework || profile?.ecosystem || "").toLowerCase();
    const large = framework.includes("next") || framework.includes("django");
    const environmentVariables = await this.safeProjectEnvironmentVariables(project.id);
    const detectedHealthPath = profile?.healthCheckPath;
    const healthCheckPath =
      detectedHealthPath &&
      (detectedHealthPath !== "/" || config.allowHealthcheckFallback)
        ? detectedHealthPath
        : config.allowHealthcheckFallback
          ? "/"
          : config.defaultHealthCheckPath;
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
      ecs_task_cpu: large ? config.largeCpu : config.defaultCpu,
      ecs_task_memory: large ? config.largeMemory : config.defaultMemory,
      ecs_environment_variables: environmentVariables,
      ecs_use_fargate_spot: config.useFargateSpot,
      ecs_enable_fargate_fallback: config.enableFargateFallback,
      ecs_desired_count: config.minTasks,
      ecs_min_tasks: config.minTasks,
      ecs_max_tasks: config.maxTasks,
      ecs_cpu_target_percent: config.cpuTargetPercent,
      ecs_healthcheck_grace_seconds: config.healthcheckGraceSeconds,
      ecs_container_insights: config.containerInsights,
      alb_health_check_path: healthCheckPath || "/health",
      enable_eventbridge_spot_rule: config.enableEventBridgeSpotRule,
      spot_event_api_destination_endpoint: spotEndpoint,
      spot_event_api_destination_secret: spotEndpoint ? spotSecret : "",
    };
  }

  private async safeProjectEnvironmentVariables(projectId: string) {
    const rows = await this.envRepository
      .createQueryBuilder("env")
      .addSelect("env.value")
      .where("env.projectId = :projectId", { projectId })
      .andWhere("env.isSecret = false")
      .getMany();

    return rows.reduce(
      (safe, row) => {
        if (/^[A-Z_][A-Z0-9_]*$/.test(row.key)) {
          safe[row.key] = row.value;
        }
        return safe;
      },
      {} as Record<string, string>
    );
  }

  private publicError(error: unknown) {
    const message = error instanceof Error ? error.message : "Infrastructure operation failed.";

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
