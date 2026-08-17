import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Job, Worker } from "bullmq";
import { In, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { createRedisConnection } from "../projects/pipeline/redis.config";
import { DestroyOperation } from "./destroy-operation.entity";
import { EmergencyCleanupOperation } from "./emergency-cleanup-operation.entity";
import { CentralCloudCleanupService } from "./central-cloud-cleanup.service";
import { InfrastructureLifecycleService } from "./infrastructure-lifecycle.service";
import { EMERGENCY_CLEANUP_QUEUE_NAME, EmergencyCleanupJob } from "./lifecycle.queue";

@Injectable()
export class EmergencyCleanupWorkerService implements OnModuleDestroy {
  private worker?: Worker<EmergencyCleanupJob>;
  private timer?: NodeJS.Timeout;
  private readonly logger = new Logger(EmergencyCleanupWorkerService.name);
  constructor(@InjectRepository(EmergencyCleanupOperation) private readonly operations: Repository<EmergencyCleanupOperation>, @InjectRepository(DestroyOperation) private readonly destroys: Repository<DestroyOperation>, private readonly lifecycle: InfrastructureLifecycleService, private readonly cleanup: CentralCloudCleanupService, private readonly config: ConfigService, private readonly audit: AuditLogService) {}
  start() {
    if (this.worker) return;
    this.worker = new Worker<EmergencyCleanupJob>(EMERGENCY_CLEANUP_QUEUE_NAME, (job) => this.process(job), { connection: createRedisConnection(this.config), concurrency: 3 });
    this.worker.on("failed", (_job, error) => this.logger.error(error.message));
    this.timer = setInterval(() => void this.reconcile(), 5000); this.timer.unref();
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.worker?.close(); }
  private async process(job: Job<EmergencyCleanupJob>) {
    const operation = await this.operations.findOne({ where: { id: job.data.operationId } });
    if (!operation || !["queued", "running"].includes(operation.status)) return;
    operation.status = "running"; operation.startedAt = operation.startedAt || new Date(); await this.operations.save(operation);
    const targets = [...operation.targets];
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]; if (target.status !== "queued") continue;
      try {
        const destroy = await this.lifecycle.enqueueAutomatedDestroy({ projectId: String(target.projectId), environmentId: String(target.environmentId), userId: operation.userId, source: "emergency", emergencyOperationId: operation.id, priority: 1 });
        targets[index] = { ...target, status: "destroy_queued", destroyOperationId: destroy.id };
      } catch (error) { targets[index] = { ...target, status: "failed", error: this.safeError(error) }; }
      operation.targets = targets; await this.operations.save(operation);
    }
    operation.status = "waiting_for_project_cleanup"; await this.operations.save(operation);
  }
  private async reconcile() {
    const operations = await this.operations.find({ where: { status: In(["running", "waiting_for_project_cleanup"]) } });
    for (const operation of operations) {
      const targets = [...operation.targets]; let changed = false;
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index]; if (!["destroy_queued", "destroy_running"].includes(String(target.status))) continue;
        const destroy = await this.destroys.findOne({ where: { id: String(target.destroyOperationId), emergencyOperationId: operation.id } });
        if (!destroy || ["queued", "running"].includes(destroy.status)) { if (destroy?.status === "running" && target.status !== "destroy_running") { targets[index] = { ...target, status: "destroy_running" }; changed = true; } continue; }
        if (destroy.status !== "completed") { targets[index] = { ...target, status: "failed", error: destroy.errorMessage || "Project destroy failed." }; changed = true; continue; }
        try {
          const residues = await this.cleanup.cleanupEmergencyResidues(String(target.projectId), operation.userId);
          const failed = residues.results?.filter((result: any) => result.status === "failed").length || 0;
          targets[index] = { ...target, status: failed ? "needs_attention" : "completed", residueCleanup: { attempted: residues.results?.length || 0, failed } };
        } catch (error) { targets[index] = { ...target, status: "needs_attention", error: this.safeError(error) }; }
        changed = true;
      }
      if (!changed) continue;
      operation.targets = targets;
      operation.completedCount = targets.filter((target) => target.status === "completed").length;
      operation.failedCount = targets.filter((target) => ["failed", "needs_attention"].includes(String(target.status))).length;
      if (operation.completedCount + operation.failedCount === operation.targetCount) { operation.status = operation.failedCount ? "completed_with_errors" : "completed"; operation.completedAt = new Date(); }
      await this.operations.save(operation);
      if (operation.completedAt) await this.audit.record({ action: "EMERGENCY_NON_PRODUCTION_CLEANUP_COMPLETED", resourceType: "emergency_cleanup", resourceId: operation.id, status: operation.failedCount ? "warning" : "success", metadata: { actorUserId: operation.userId, completedCount: operation.completedCount, failedCount: operation.failedCount, productionExcluded: true } });
    }
  }
  private safeError(error: unknown) { const message = error instanceof Error ? error.message : String(error); return /secret|token|password|credential|access.?key/i.test(message) ? "Cleanup failed because required cloud configuration is invalid or missing." : message.slice(0, 500); }
}
