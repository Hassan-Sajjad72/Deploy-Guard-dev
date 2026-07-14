import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectDeploymentQueueItem, DeploymentQueueStatus } from "./project-deployment-queue-item.entity";
import { ProjectTerraformLock, TerraformLockStatus } from "./project-terraform-lock.entity";
import { getStateManagementConfig } from "./state-management.config";

const ACTIVE_LOCK_STATUSES = [
  TerraformLockStatus.ACQUIRED,
  TerraformLockStatus.HEARTBEAT_ACTIVE,
];

@Injectable()
export class StateLockService {
  private readonly ownerWorkerId = `${process.pid}-${Date.now()}`;

  constructor(
    @InjectRepository(ProjectTerraformLock)
    private readonly lockRepository: Repository<ProjectTerraformLock>,
    @InjectRepository(ProjectDeploymentQueueItem)
    private readonly queueRepository: Repository<ProjectDeploymentQueueItem>,
    private readonly config: ConfigService
  ) {}

  buildLockId(projectId: string, environmentName = "dev") {
    return `project#${projectId}#environment#${environmentName}`;
  }

  async acquireLock(
    projectId: string,
    pipelineRunId: string,
    userId: number | null,
    environmentName = "dev",
    metadata: Record<string, unknown> = {}
  ) {
    const lockId = this.buildLockId(projectId, environmentName);
    const existing = await this.lockRepository.findOne({ where: { lockId } });
    const config = getStateManagementConfig(this.config);
    const now = new Date();

    if (existing && ACTIVE_LOCK_STATUSES.includes(existing.status as TerraformLockStatus) && !this.isStale(existing)) {
      await this.enqueueBehindExistingLock(projectId, pipelineRunId, environmentName, metadata);
      return { acquired: false, lock: existing };
    }

    const lock = existing || this.lockRepository.create({ lockId, projectId, pipelineRunId, environmentName });
    lock.projectId = projectId;
    lock.pipelineRunId = pipelineRunId;
    lock.userId = userId;
    lock.status = TerraformLockStatus.ACQUIRED;
    lock.ownerWorkerId = this.ownerWorkerId;
    lock.acquiredAt = now;
    lock.heartbeatAt = now;
    lock.heartbeatIntervalSeconds = config.heartbeatIntervalSeconds;
    lock.staleAfterSeconds = config.staleAfterSeconds;
    lock.releasedAt = null;
    lock.forceReleasedAt = null;
    lock.metadata = metadata;

    try {
      if (!existing) {
        return { acquired: true, lock: await this.lockRepository.save(lock) };
      }

      const staleBefore = new Date(
        Date.now() - (existing.staleAfterSeconds || config.staleAfterSeconds) * 1000
      );
      const update = await this.lockRepository
        .createQueryBuilder()
        .update(ProjectTerraformLock)
        .set({
          projectId,
          pipelineRunId,
          userId,
          environmentName,
          status: TerraformLockStatus.ACQUIRED,
          ownerWorkerId: this.ownerWorkerId,
          acquiredAt: now,
          heartbeatAt: now,
          heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
          staleAfterSeconds: config.staleAfterSeconds,
          releasedAt: null,
          forceReleasedAt: null,
          metadata,
        })
        .where("lock_id = :lockId", { lockId })
        .andWhere(
          "(status NOT IN (:...activeStatuses) OR COALESCE(heartbeat_at, acquired_at) < :staleBefore)",
          { activeStatuses: ACTIVE_LOCK_STATUSES, staleBefore }
        )
        .execute();

      if (!update.affected) {
        const current = await this.getLock(lockId);
        await this.enqueueBehindExistingLock(projectId, pipelineRunId, environmentName, metadata);
        return { acquired: false, lock: current || existing };
      }

      return { acquired: true, lock: (await this.getLock(lockId))! };
    } catch (error) {
      if (String((error as { code?: unknown }).code) === "23505") {
        const current = await this.getLock(lockId);
        await this.enqueueBehindExistingLock(projectId, pipelineRunId, environmentName, metadata);
        return { acquired: false, lock: current! };
      }
      throw error;
    }
  }

  async releaseLock(lockId: string, pipelineRunId: string) {
    const lock = await this.getLock(lockId);

    if (!lock || lock.pipelineRunId !== pipelineRunId) {
      return null;
    }

    lock.status = TerraformLockStatus.RELEASED;
    lock.releasedAt = new Date();
    return this.lockRepository.save(lock);
  }

  async getLock(lockId: string) {
    return this.lockRepository.findOne({ where: { lockId } });
  }

  async markLockOrphaned(lockId: string) {
    const lock = await this.getLock(lockId);

    if (!lock) return null;

    lock.status = TerraformLockStatus.ORPHANED;
    return this.lockRepository.save(lock);
  }

  async forceReleaseOrphanedLock(lockId: string) {
    const config = getStateManagementConfig(this.config);
    const lock = await this.getLock(lockId);

    if (!lock || !config.forceReleaseEnabled) {
      return null;
    }

    if (lock.status !== TerraformLockStatus.ORPHANED && !this.isStale(lock)) {
      throw new Error("Only orphaned or stale locks can be force released.");
    }

    lock.status = TerraformLockStatus.FORCE_RELEASED;
    lock.forceReleasedAt = new Date();
    return this.lockRepository.save(lock);
  }

  async enqueueBehindExistingLock(
    projectId: string,
    pipelineRunId: string,
    environmentName = "dev",
    metadata: Record<string, unknown> = {}
  ) {
    const count = await this.queueRepository.count({
      where: { projectId, environmentName, status: DeploymentQueueStatus.WAITING_FOR_LOCK },
    });

    return this.queueRepository.save(
      this.queueRepository.create({
        projectId,
        pipelineRunId,
        environmentName,
        status: DeploymentQueueStatus.WAITING_FOR_LOCK,
        position: count + 1,
        reason: "Waiting for Terraform state lock.",
        metadata,
      })
    );
  }

  async getQueuedDeployments(projectId: string, environmentName = "dev") {
    return this.queueRepository.find({
      where: { projectId, environmentName },
      order: { position: "ASC", createdAt: "ASC" },
    });
  }

  async processNextQueuedDeployment(projectId: string, environmentName = "dev") {
    const next = await this.queueRepository.findOne({
      where: { projectId, environmentName, status: DeploymentQueueStatus.WAITING_FOR_LOCK },
      order: { position: "ASC", createdAt: "ASC" },
    });

    if (!next) return null;

    next.status = DeploymentQueueStatus.PROCESSING;
    next.startedAt = new Date();
    return this.queueRepository.save(next);
  }

  async activeLocks() {
    return this.lockRepository.find({ where: ACTIVE_LOCK_STATUSES.map((status) => ({ status })) });
  }

  isStale(lock: ProjectTerraformLock) {
    const heartbeat = lock.heartbeatAt || lock.acquiredAt;
    const staleAfterMs = (lock.staleAfterSeconds || 300) * 1000;
    return Date.now() - new Date(heartbeat).getTime() > staleAfterMs;
  }
}
