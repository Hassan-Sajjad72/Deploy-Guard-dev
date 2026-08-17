import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Job, Worker } from "bullmq";
import { resolve } from "path";
import { realpath } from "fs/promises";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { getInfrastructureConfig } from "../infrastructure/infrastructure.config";
import { InfrastructureEnvironmentStatus, ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { TerraformRunnerService } from "../infrastructure/terraform-runner.service";
import { NotificationDispatcherService } from "../notifications/notification-dispatcher.service";
import { createRedisConnection } from "../projects/pipeline/redis.config";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { ProjectTerraformState } from "../state-management/project-terraform-state.entity";
import { TerraformStateService } from "../state-management/terraform-state.service";
import { StateHeartbeatService } from "../state-management/state-heartbeat.service";
import { StateLockService } from "../state-management/state-lock.service";
import { DestroyOperation } from "./destroy-operation.entity";
import { InfrastructureLifecycleService } from "./infrastructure-lifecycle.service";
import { LIFECYCLE_QUEUE_NAME, LifecycleJob } from "./lifecycle.queue";
import { ProjectCloudInventoryService } from "./project-cloud-inventory.service";
import { ProjectResourceRegistryService } from "../resource-registry/project-resource-registry.service";
import { CloudStateReconciliationService } from "./cloud-state-reconciliation.service";

@Injectable()
export class InfrastructureLifecycleWorkerService implements OnModuleDestroy {
  private worker?: Worker<LifecycleJob>;
  private readonly logger = new Logger(InfrastructureLifecycleWorkerService.name);
  constructor(@InjectRepository(DestroyOperation) private readonly operations: Repository<DestroyOperation>, @InjectRepository(ProjectInfrastructureEnvironment) private readonly environments: Repository<ProjectInfrastructureEnvironment>, @InjectRepository(ProjectTerraformState) private readonly states: Repository<ProjectTerraformState>, @InjectRepository(ProjectPipelineEvent) private readonly events: Repository<ProjectPipelineEvent>, private readonly config: ConfigService, private readonly lifecycle: InfrastructureLifecycleService, private readonly locks: StateLockService, private readonly heartbeats: StateHeartbeatService, private readonly terraform: TerraformRunnerService, private readonly terraformState: TerraformStateService, private readonly cloudInventory: ProjectCloudInventoryService, private readonly notifications: NotificationDispatcherService, private readonly audit: AuditLogService, private readonly resourceRegistry: ProjectResourceRegistryService, private readonly cloudState: CloudStateReconciliationService) {}
  start() { if (this.worker) return; this.worker = new Worker<LifecycleJob>(LIFECYCLE_QUEUE_NAME, (job) => this.process(job), { connection: createRedisConnection(this.config), concurrency: 1 }); this.worker.on("failed", (_job, error) => this.logger.error(error.message)); }
  async onModuleDestroy() { await this.worker?.close(); }
  private async process(job: Job<LifecycleJob>) {
    const operation = await this.operations.findOne({ where: { id: job.data.operationId } });
    if (!operation || !["queued", "running"].includes(operation.status)) return;
    const environment = await this.environments.findOne({ where: { id: operation.infrastructureEnvironmentId, projectId: operation.projectId } });
    if (!environment) throw new Error("Infrastructure environment no longer exists.");
    operation.status = "running"; operation.startedAt = new Date(); environment.status = InfrastructureEnvironmentStatus.DESTROYING; environment.cleanupStatus = "running"; await Promise.all([this.operations.save(operation), this.environments.save(environment)]);
    await this.persistEvent(operation, environment, "started", "Terraform destroy started.");
    await this.audit.record({ action: "TERRAFORM_DESTROY_STARTED", resourceType: "infrastructure_destroy", resourceId: operation.id, status: "success", metadata: { projectId: operation.projectId, pipelineRunId: environment.pipelineRunId, stateKey: this.terraformState.buildStateKey({ id: operation.projectId }, operation.environmentName) } });
    await this.notifications.dispatch({ projectId: operation.projectId, eventId: operation.id, stage: "infrastructure_destroy", status: "started", message: "Infrastructure destroy started for project-scoped Terraform resources." }).catch(() => undefined);
    const acquired = await this.locks.acquireLock(operation.projectId, operation.id, operation.userId, operation.environmentName, { operation: "destroy" });
    if (!acquired.acquired) return this.fail(operation, environment, "Terraform state is locked. Another operation may be running.");
    const lockId = acquired.lock.lockId;
    try {
      await this.persistEvent(operation, environment, "lock_acquired", "Terraform destroy acquired the project state lock.");
      await this.heartbeats.startHeartbeat(lockId, operation.id);
      const state = await this.states.findOne({ where: { projectId: operation.projectId, environmentName: operation.environmentName }, order: { updatedAt: "DESC" } });
      const live = this.config.get<string>("DESTROY_ENABLED", "false") === "true";
      const demo = this.config.get<string>("DESTROY_DEMO_MODE", "false") === "true";
      if (!live && !demo) throw new Error("NOT_CONFIGURED: DESTROY_ENABLED=false and DESTROY_DEMO_MODE=false.");
      if (live) {
        if (!state || !operation.stateBackupReference) throw new Error("Unable to record Terraform state backup reference.");
        const configuredRoot = getInfrastructureConfig(this.config).terraformWorkingBaseDir;
        if (!environment.terraformWorkspacePath) throw new Error("Terraform workspace path is unavailable.");
        const workspace = this.lifecycle.validateWorkspace(await realpath(resolve(environment.terraformWorkspacePath)), await realpath(configuredRoot));
        const backend = await this.terraformState.validateDestroyBackend({ id: operation.projectId }, operation.environmentName);
        if (state.stateBucket !== backend.bucket || state.stateKey !== backend.stateKey || (environment.terraformStateKey && environment.terraformStateKey !== backend.stateKey)) {
          throw new Error(`Infrastructure destroy is restricted to project state key ${backend.stateKey}.`);
        }
        await this.terraform.assertBackendMode(workspace, backend.mode);
        const backendConfigPath = backend.mode === "s3" ? await this.terraformState.writeBackendConfig(workspace, { id: operation.projectId }, operation.environmentName) : undefined;
        await this.terraform.runTerraformInit(workspace, {}, { mode: backend.mode, configPath: backendConfigPath });
        await this.persistEvent(operation, environment, "backend_initialized", `Terraform destroy initialized the S3 backend for ${backend.stateKey}.`);
        const rawState = await this.terraformState.getStateObject({ id: operation.projectId }, operation.environmentName);
        this.lifecycle.assertSharedStateBucketNotTracked(rawState, backend.bucket);
        const addresses = await this.terraform.listTerraformState(workspace);
        const filtered = this.lifecycle.filterDestroyTargets(addresses, operation.deletePersistentDatabaseData);
        if (!filtered.targets.length) throw new Error("No disposable Terraform resources were found; protected resources were preserved.");
        await this.terraform.runTerraformDestroy(workspace, filtered.targets, {}, { sharedStateBucketAbsent: true });
        operation.preservedResources = filtered.preserved; operation.destroyedResources = filtered.targets;
      } else {
        operation.stateBackupReference = "demo:no_state_mutation";
        operation.preservedResources = ["shared_state_bucket", "project_state_object", "project_state_versions"];
        operation.destroyedResources = ["demo:application_infrastructure"];
      }
      operation.status = "completed"; operation.completedAt = new Date();
      if (live) await this.resourceRegistry.markTerraformDestroyCompleted(operation.projectId, environment.pipelineRunId);
      await this.persistEvent(operation, environment, "terraform_completed", "Terraform destroy completed. Cloud residue verification started.");
      let cleanupMessage = "No project cloud resources were found after Terraform destroy.";
      try {
        const inventory = await this.cloudInventory.scan(operation.projectId, null, operation.id);
        operation.resourceInventory = inventory as unknown as Record<string, unknown>;
        if (inventory.summary.verified && inventory.summary.remaining === 0) {
          operation.cleanupStatus = "completed";
          environment.cleanupStatus = "completed";
          environment.autoDestroyEnabled = false;
          operation.cleanupCompletedAt = new Date();
          environment.status = InfrastructureEnvironmentStatus.DESTROYED;
          environment.errorMessage = null;
        } else {
          operation.cleanupStatus = "cleanup_required";
          environment.cleanupStatus = "cleanup_required";
          environment.status = InfrastructureEnvironmentStatus.DESTROY_NEEDS_CLEANUP;
          environment.errorMessage = inventory.summary.verified ? "Some project cloud resources remain after Terraform destroy." : "Cloud residue verification was incomplete; admin review is required.";
          cleanupMessage = environment.errorMessage;
        }
      } catch {
        operation.cleanupStatus = "cleanup_required";
        environment.cleanupStatus = "cleanup_required";
        environment.status = InfrastructureEnvironmentStatus.DESTROY_NEEDS_CLEANUP;
        environment.errorMessage = "Cloud residue verification could not complete; admin review is required.";
        cleanupMessage = environment.errorMessage;
      }
      await Promise.all([this.environments.save(environment), this.operations.save(operation)]);
      await this.cloudState.reconcile(operation.projectId);
      await this.persistEvent(operation, environment, operation.cleanupStatus === "completed" ? "completed" : "cleanup_required", cleanupMessage);
      await this.audit.record({ action: "INFRASTRUCTURE_DESTROY_COMPLETED", resourceType: "infrastructure_destroy", resourceId: operation.id, status: operation.cleanupStatus === "completed" ? "success" : "warning", metadata: { projectId: operation.projectId, pipelineRunId: environment.pipelineRunId, environmentName: operation.environmentName, cleanupStatus: operation.cleanupStatus } });
      await this.notifications.dispatch({ projectId: operation.projectId, eventId: operation.id, stage: "infrastructure_destroy", status: operation.cleanupStatus === "completed" ? "completed" : "cleanup_required", message: cleanupMessage }).catch(() => undefined);
    } catch (error) { await this.fail(operation, environment, this.destroyError(error)); }
    finally { await Promise.allSettled([this.heartbeats.stopHeartbeat(lockId, operation.id), this.locks.releaseLock(lockId, operation.id)]); await this.persistEvent(operation, environment, "lock_released", "Terraform destroy released the project state lock."); }
  }
  private async persistEvent(operation: DestroyOperation, environment: ProjectInfrastructureEnvironment, status: string, message: string) { if (!environment.pipelineRunId) return; await this.events.save(this.events.create({ projectId: operation.projectId, pipelineRunId: environment.pipelineRunId, stage: `terraform_destroy_${status}`, status, message, metadata: { operationId: operation.id } })); }
  private destroyError(error: unknown) { const message = this.terraform.sanitizeTerraformLogs(error instanceof Error ? error.message : String(error)); if (/state object not found|No Terraform state was found/i.test(message)) return "Terraform state object not found."; if (/versioning is not enabled/i.test(message)) return "Terraform state bucket versioning is not enabled. Enable versioning before live destroy."; if (/backup reference/i.test(message)) return "Unable to record Terraform state backup reference."; if (/lock/i.test(message)) return "Terraform state is locked. Another operation may be running."; if (/credential|AccessDenied|Forbidden|InvalidAccessKeyId|SignatureDoesNotMatch|Unable to locate/i.test(message)) return "AWS credentials cannot read Terraform state object."; return message.slice(0, 2000); }
  private async fail(operation: DestroyOperation, environment: ProjectInfrastructureEnvironment, message: string) { operation.status = "failed"; operation.errorMessage = message.slice(0, 2000); operation.completedAt = new Date(); environment.status = InfrastructureEnvironmentStatus.DESTROY_FAILED; environment.cleanupStatus = operation.source === "ttl" ? "retry_pending" : "failed"; environment.errorMessage = operation.errorMessage; await Promise.all([this.operations.save(operation), this.environments.save(environment)]); await this.persistEvent(operation, environment, "failed", operation.errorMessage); await this.audit.record({ action: "INFRASTRUCTURE_DESTROY_FAILED", resourceType: "infrastructure_destroy", resourceId: operation.id, status: "failed", metadata: { projectId: operation.projectId, pipelineRunId: environment.pipelineRunId, source: operation.source, emergencyOperationId: operation.emergencyOperationId } }); await this.notifications.dispatch({ projectId: operation.projectId, eventId: operation.id, stage: "infrastructure_destroy", status: "failed", message: "Infrastructure destroy failed. Review the sanitized operation status before retrying." }); }
}
