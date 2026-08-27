import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { Project } from "../projects/project.entity";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { InfrastructureLifecycleService } from "./infrastructure-lifecycle.service";

@Injectable()
export class TtlCleanupSchedulerService implements OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(TtlCleanupSchedulerService.name);
  constructor(@InjectRepository(Project) private readonly projects: Repository<Project>, @InjectRepository(ProjectInfrastructureEnvironment) private readonly environments: Repository<ProjectInfrastructureEnvironment>, private readonly lifecycle: InfrastructureLifecycleService, private readonly config: ConfigService, private readonly audit: AuditLogService) {}

  start() {
    if (this.timer || this.config.get<string>("TTL_CLEANUP_ENABLED", "true").toLowerCase() !== "true") return;
    const interval = Math.max(15, Number(this.config.get<string>("TTL_CLEANUP_INTERVAL_SECONDS", "60"))) * 1000;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
    void this.tick();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const environment of await this.lifecycle.expiredTtlEnvironments()) {
        const project = await this.projects.findOne({ where: { id: environment.projectId } });
        if (!project) continue;
        try {
          await this.lifecycle.enqueueAutomatedDestroy({ projectId: project.id, environmentId: environment.id, userId: project.ownerUserId, source: "ttl", priority: 5 });
          await this.audit.record({ action: "TTL_CLEANUP_SCHEDULE_TRIGGERED", resourceType: "infrastructure_environment", resourceId: environment.id, status: "success", metadata: { projectId: project.id, environmentType: environment.environmentType, ttlExpiresAt: environment.ttlExpiresAt } });
        } catch (error) {
          environment.cleanupStatus = "retry_pending";
          await this.environments.save(environment);
          await this.audit.record({ action: "TTL_CLEANUP_QUEUE_FAILED", resourceType: "infrastructure_environment", resourceId: environment.id, status: "failed", metadata: { projectId: project.id, reason: error instanceof Error ? error.message.slice(0, 500) : "Cleanup could not be queued." } });
        }
      }
    } catch (error) { this.logger.error(error instanceof Error ? error.message : String(error)); }
    finally { this.running = false; }
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}
