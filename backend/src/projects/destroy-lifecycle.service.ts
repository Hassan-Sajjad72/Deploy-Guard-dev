import { randomUUID } from "crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, In, Repository } from "typeorm";
import {
  DestroyRemainingResource,
  ProjectDestroyLifecycle,
  ProjectDestroyPhase,
  ProjectDestroyStatus,
} from "./project-destroy-lifecycle.entity";

const ACTIVE_DESTROY = [
  ProjectDestroyStatus.DELETING,
  ProjectDestroyStatus.DESTROYING,
  ProjectDestroyStatus.DESTROY_VERIFYING,
  ProjectDestroyStatus.DESTROY_INCOMPLETE,
  // AWS verification is not the terminal lifecycle boundary. Keep the row
  // resumable until external metadata and database extinction have finished.
  ProjectDestroyStatus.DESTROYED,
];

@Injectable()
export class DestroyLifecycleService {
  constructor(
    @InjectRepository(ProjectDestroyLifecycle) private readonly lifecycles: Repository<ProjectDestroyLifecycle>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  active(projectId: string, environmentName: string, manager?: EntityManager) {
    const repository = manager?.getRepository(ProjectDestroyLifecycle) || this.lifecycles;
    return repository.findOne({ where: { projectId, environmentName, status: In(ACTIVE_DESTROY) } });
  }

  async begin(input: {
    projectId: string;
    environmentName: string;
    generationId: string;
    operationId: string;
    resourceManifest: Record<string, unknown>;
  }, manager?: EntityManager) {
    if (!manager) return this.dataSource.transaction((transaction) => this.begin(input, transaction));
    await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`destroy-lifecycle:${input.projectId}:${input.environmentName}`]);
    const repository = manager.getRepository(ProjectDestroyLifecycle);
    const existing = await repository.findOne({ where: { projectId: input.projectId, environmentName: input.environmentName } });
    if (existing) {
      if (existing.generationId !== input.generationId || !ACTIVE_DESTROY.includes(existing.status)) {
        throw new BadRequestException({ code: "destroy_lifecycle_conflict", message: "A different or completed Destroy lifecycle already owns this project environment." });
      }
      existing.operationId = input.operationId;
      existing.status = ProjectDestroyStatus.DELETING;
      existing.phase = ProjectDestroyPhase.AWS_CLEANUP;
      existing.resourceManifest = this.mergeManifest(existing.resourceManifest, input.resourceManifest);
      existing.lastAttemptAt = new Date();
      existing.nextRetryAt = null;
      return repository.save(existing);
    }
    return repository.save(repository.create({
      id: randomUUID(),
      ...input,
      status: ProjectDestroyStatus.DELETING,
      phase: ProjectDestroyPhase.AWS_CLEANUP,
      remaining: [],
      terraformEvidence: {},
      verificationEvidence: {},
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      retryCount: 0,
      nextRetryAt: null,
      firstStartedAt: new Date(),
      lastAttemptAt: new Date(),
      escalation: null,
    }));
  }

  async acquire(projectId: string, environmentName: string, operationId: string) {
    return this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`destroy-lease:${projectId}:${environmentName}`]);
      const repository = manager.getRepository(ProjectDestroyLifecycle);
      const lifecycle = await repository.findOne({ where: { projectId, environmentName } });
      if (!lifecycle || !ACTIVE_DESTROY.includes(lifecycle.status)) throw new BadRequestException("No resumable Destroy lifecycle exists.");
      const now = new Date();
      if (lifecycle.leaseOwner && lifecycle.leaseOwner !== operationId && lifecycle.leaseExpiresAt && lifecycle.leaseExpiresAt > now) {
        return null;
      }
      const ttlMs = this.leaseTtlMs();
      lifecycle.operationId = operationId;
      lifecycle.leaseOwner = operationId;
      lifecycle.heartbeatAt = now;
      lifecycle.leaseExpiresAt = new Date(now.getTime() + ttlMs);
      lifecycle.status = ProjectDestroyStatus.DESTROYING;
      lifecycle.lastAttemptAt = now;
      return repository.save(lifecycle);
    });
  }

  async heartbeat(projectId: string, environmentName: string, operationId: string) {
    const now = new Date();
    const result = await this.lifecycles.createQueryBuilder()
      .update(ProjectDestroyLifecycle)
      .set({ heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + this.leaseTtlMs()) })
      .where("project_id = :projectId", { projectId })
      .andWhere("environment_name = :environmentName", { environmentName })
      .andWhere("lease_owner = :operationId", { operationId })
      .andWhere("lease_expires_at > CURRENT_TIMESTAMP")
      .execute();
    return result.affected === 1;
  }

  async recordIncomplete(input: {
    projectId: string;
    environmentName: string;
    operationId: string;
    remaining: DestroyRemainingResource[];
    terraformEvidence?: Record<string, unknown>;
    verificationEvidence?: Record<string, unknown>;
    phase?: ProjectDestroyPhase;
  }) {
    const lifecycle = await this.lifecycles.findOne({ where: { projectId: input.projectId, environmentName: input.environmentName } });
    if (!lifecycle || lifecycle.operationId !== input.operationId) throw new BadRequestException("Destroy lifecycle operation identity changed.");
    const now = new Date();
    const retryCount = lifecycle.retryCount + 1;
    const delayMs = Math.min(30 * 60_000, 15_000 * (2 ** Math.min(retryCount - 1, 7)));
    lifecycle.status = ProjectDestroyStatus.DESTROY_INCOMPLETE;
    lifecycle.phase = input.phase || ProjectDestroyPhase.AWS_CLEANUP;
    lifecycle.remaining = this.normalizeRemaining(input.remaining, now);
    lifecycle.terraformEvidence = { ...lifecycle.terraformEvidence, ...(input.terraformEvidence || {}) };
    lifecycle.verificationEvidence = { ...lifecycle.verificationEvidence, ...(input.verificationEvidence || {}) };
    lifecycle.retryCount = retryCount;
    lifecycle.nextRetryAt = new Date(now.getTime() + delayMs);
    lifecycle.leaseOwner = null;
    lifecycle.leaseExpiresAt = null;
    lifecycle.heartbeatAt = now;
    lifecycle.escalation = this.escalation(lifecycle, now);
    return this.lifecycles.save(lifecycle);
  }

  async recordAwsVerified(projectId: string, environmentName: string, operationId: string, evidence: Record<string, unknown>) {
    const lifecycle = await this.requireOwned(projectId, environmentName, operationId);
    lifecycle.status = ProjectDestroyStatus.DESTROYED;
    lifecycle.phase = ProjectDestroyPhase.AWS_VERIFIED;
    lifecycle.remaining = [];
    lifecycle.verificationEvidence = { ...lifecycle.verificationEvidence, ...evidence };
    lifecycle.nextRetryAt = null;
    return this.lifecycles.save(lifecycle);
  }

  async phase(projectId: string, environmentName: string, operationId: string, phase: ProjectDestroyPhase) {
    const lifecycle = await this.requireOwned(projectId, environmentName, operationId);
    lifecycle.phase = phase;
    if (phase === ProjectDestroyPhase.EXTINCT) lifecycle.status = ProjectDestroyStatus.EXTINCT;
    return this.lifecycles.save(lifecycle);
  }

  async due(limit = 25) {
    return this.lifecycles.createQueryBuilder("lifecycle")
      .innerJoinAndSelect("lifecycle.project", "project")
      .where("lifecycle.status IN (:...statuses)", { statuses: ACTIVE_DESTROY })
      .andWhere("(lifecycle.nextRetryAt IS NULL OR lifecycle.nextRetryAt <= CURRENT_TIMESTAMP)")
      .andWhere("(lifecycle.leaseExpiresAt IS NULL OR lifecycle.leaseExpiresAt <= CURRENT_TIMESTAMP)")
      .orderBy("lifecycle.nextRetryAt", "ASC", "NULLS FIRST")
      .addOrderBy("lifecycle.updatedAt", "ASC")
      .take(limit)
      .getMany();
  }

  private async requireOwned(projectId: string, environmentName: string, operationId: string) {
    const lifecycle = await this.lifecycles.findOne({ where: { projectId, environmentName } });
    if (!lifecycle || lifecycle.operationId !== operationId) throw new BadRequestException("Destroy lifecycle lease identity changed.");
    return lifecycle;
  }

  private leaseTtlMs() {
    const configured = Number(this.config.get<string>("DESTROY_LEASE_TTL_MS", "120000"));
    return Math.max(30_000, Math.min(15 * 60_000, Number.isFinite(configured) ? configured : 120_000));
  }

  private mergeManifest(current: Record<string, unknown>, incoming: Record<string, unknown>) {
    return { ...current, ...incoming, capturedAt: new Date().toISOString() };
  }

  private normalizeRemaining(items: DestroyRemainingResource[], now: Date) {
    return items.slice(0, 2_000).map((item) => ({
      ...item,
      resourceType: String(item.resourceType || "unknown").slice(0, 128),
      resourceId: String(item.resourceId || "unknown").slice(0, 2_048),
      reason: String(item.reason || "unresolved").slice(0, 512),
      errorCode: item.errorCode ? String(item.errorCode).slice(0, 128) : undefined,
      errorMessage: item.errorMessage ? String(item.errorMessage).slice(0, 1_000) : undefined,
      attemptCount: Math.max(1, Number(item.attemptCount || 1)),
      firstSeenAt: item.firstSeenAt && !Number.isNaN(Date.parse(item.firstSeenAt)) ? item.firstSeenAt : now.toISOString(),
      lastSeenAt: now.toISOString(),
    }));
  }

  private escalation(lifecycle: ProjectDestroyLifecycle, now: Date) {
    const threshold = Number(this.config.get<string>("DESTROY_ESCALATION_RETRY_COUNT", "8"));
    if (lifecycle.retryCount < Math.max(1, threshold)) return lifecycle.escalation;
    return {
      projectId: lifecycle.projectId,
      environmentName: lifecycle.environmentName,
      generationId: lifecycle.generationId,
      destroyOperationId: lifecycle.operationId,
      phase: lifecycle.phase,
      retryCount: lifecycle.retryCount,
      firstSeenAt: lifecycle.firstStartedAt.toISOString(),
      lastSeenAt: now.toISOString(),
      unresolved: lifecycle.remaining,
      requiredOperatorPrerequisite: lifecycle.remaining.some((item) => item.retryable === false)
        ? "Resolve the listed permission, ownership, or validation blocker. Automatic safe retries remain enabled."
        : null,
    };
  }
}
