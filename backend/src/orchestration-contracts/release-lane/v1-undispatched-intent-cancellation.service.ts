import { Inject, Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { DeploymentIntent } from "../entities/deployment-intent.entity";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { OrchestrationOutbox } from "../entities/orchestration-outbox.entity";
import { ProjectOperationLease } from "../entities/project-operation-lease.entity";
import { ProjectReleaseLaneOwnership } from "../entities/release-lane-ownership.entity";
import { ReleaseManifest } from "../entities/release-manifest.entity";
import { TerminalOutboxPolicyService } from "../outbox/terminal-outbox-policy.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANCELLATION_CODE = "INTENT_CANCELLED_BEFORE_DISPATCH";
const RETRYABLE_TRANSACTION_CODES = new Set(["40001", "40P01"]);

export type V1UndispatchedIntentCancellationInput = {
  intentId: string;
  projectId: string;
  environmentName: "dev";
  infrastructureManifestId: string;
  releaseManifestId: string;
};

export type V1UndispatchedIntentCancellationResult = {
  intentId: string;
  projectId: string;
  environmentName: "dev";
  infrastructureManifestId: string;
  releaseManifestId: string;
  outboxId: string;
  auditRecorded: true;
  safeCode: typeof CANCELLATION_CODE;
};

/**
 * Cancels only an intent that has never crossed the durable outbox boundary.
 * It deliberately has no queue, worker, Terraform, or cloud dependency.
 */
@Injectable()
export class V1UndispatchedIntentCancellationService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(TerminalOutboxPolicyService)
    private readonly terminalOutbox = new TerminalOutboxPolicyService(),
  ) {}

  async cancel(input: V1UndispatchedIntentCancellationInput): Promise<V1UndispatchedIntentCancellationResult> {
    if (!UUID.test(input.intentId) || !UUID.test(input.projectId)
      || !UUID.test(input.infrastructureManifestId) || !UUID.test(input.releaseManifestId)
      || input.environmentName !== "dev") {
      throw new Error("UNDISPATCHED_INTENT_CANCELLATION_SCOPE_INVALID");
    }

    let attempt = 0;
    while (true) {
      try {
        return await this.dataSource.transaction("SERIALIZABLE", (manager) => this.cancelInTransaction(manager, input));
      } catch (error) {
        const code = typeof error === "object" && error ? String((error as { code?: unknown }).code || "") : "";
        if (!RETRYABLE_TRANSACTION_CODES.has(code) || ++attempt >= 3) throw error;
      }
    }
  }

  private async cancelInTransaction(
    manager: EntityManager,
    input: V1UndispatchedIntentCancellationInput,
  ): Promise<V1UndispatchedIntentCancellationResult> {
    await manager.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`deployguard:planner:${input.projectId}:${input.environmentName}`],
    );

    const intents = manager.getRepository(DeploymentIntent);
    const intent = await intents.findOne({
      where: { id: input.intentId, projectId: input.projectId, environmentName: input.environmentName },
      lock: { mode: "pessimistic_write" },
    });
    const resumingKnownPartialCancellation = intent?.status === "cancelled"
      && intent.failureCode === CANCELLATION_CODE;
    if (!intent || (intent.status !== "planned" && !resumingKnownPartialCancellation)
      || intent.classification !== "infrastructure_change"
      || intent.infrastructureManifestId !== input.infrastructureManifestId
      || intent.releaseManifestId !== input.releaseManifestId
      || intent.enqueuedAt || intent.startedAt) {
      throw new Error("UNDISPATCHED_INTENT_CANCELLATION_NOT_ELIGIBLE");
    }

    const infrastructure = await manager.getRepository(InfrastructureManifest).findOne({
      where: { id: input.infrastructureManifestId, projectId: input.projectId, environmentName: input.environmentName },
      lock: { mode: "pessimistic_write" },
    });
    const release = await manager.getRepository(ReleaseManifest).findOne({
      where: { id: input.releaseManifestId, projectId: input.projectId, environmentName: input.environmentName },
      lock: { mode: "pessimistic_write" },
    });
    const originalManifests = infrastructure?.status === "desired" && release?.status === "blocked_on_infrastructure";
    const cancelledManifests = infrastructure?.status === "superseded" && infrastructure.failureCode === CANCELLATION_CODE
      && release?.status === "cancelled" && release.failureCode === CANCELLATION_CODE;
    if (!infrastructure || infrastructure.createdByIntentId !== intent.id
      || !release || release.createdByIntentId !== intent.id
      || release.infrastructureManifestId !== infrastructure.id) {
      throw new Error("UNDISPATCHED_INTENT_CANCELLATION_MANIFEST_MISMATCH");
    }
    if ((!resumingKnownPartialCancellation && !originalManifests)
      || (resumingKnownPartialCancellation && !cancelledManifests)) {
      throw new Error("UNDISPATCHED_INTENT_CANCELLATION_MANIFEST_STATE_INVALID");
    }

    const outbox = await manager.getRepository(OrchestrationOutbox).find({
      where: { intentId: intent.id },
      lock: { mode: "pessimistic_write" },
    });
    if (outbox.length !== 1 || (outbox[0].status !== "pending" && outbox[0].status !== "dead_letter") || outbox[0].attemptCount !== 0
      || outbox[0].claimedBy || outbox[0].claimExpiresAt || outbox[0].publishedAt || outbox[0].publishedJobId) {
      throw new Error("UNDISPATCHED_INTENT_CANCELLATION_OUTBOX_NOT_PRISTINE");
    }
    if (!resumingKnownPartialCancellation && outbox[0].status !== "pending") {
      throw new Error("UNDISPATCHED_INTENT_CANCELLATION_OUTBOX_STATE_INVALID");
    }

    const [leaseCount, ownershipCount] = await Promise.all([
      manager.getRepository(ProjectOperationLease).count({ where: { intentId: intent.id } }),
      manager.getRepository(ProjectReleaseLaneOwnership).count({
        where: { projectId: input.projectId, environmentName: input.environmentName, deploymentIntentId: intent.id },
      }),
    ]);
    if (leaseCount !== 0 || ownershipCount !== 0) {
      throw new Error("UNDISPATCHED_INTENT_CANCELLATION_OWNERSHIP_PRESENT");
    }

    const now = new Date();
    if (!resumingKnownPartialCancellation) {
      const releaseUpdate = await manager.getRepository(ReleaseManifest).update(
        { id: release.id, status: "blocked_on_infrastructure", createdByIntentId: intent.id },
        { status: "cancelled", failureCode: CANCELLATION_CODE, failureMessage: "Cancelled before dispatch." },
      );
      const infrastructureUpdate = await manager.getRepository(InfrastructureManifest).update(
        { id: infrastructure.id, status: "desired", createdByIntentId: intent.id },
        { status: "superseded", supersededAt: now, failureCode: CANCELLATION_CODE, failureMessage: "Cancelled before planning." },
      );
      const intentUpdate = await this.terminalOutbox.transitionIntentToTerminal(
        manager,
        {
          intentId: intent.id,
          expectedStatus: "planned",
          status: "cancelled",
          failureCode: CANCELLATION_CODE,
          failureMessage: "Cancelled before dispatch.",
          reason: CANCELLATION_CODE,
        },
      );
      if (releaseUpdate.affected !== 1 || infrastructureUpdate.affected !== 1 || !intentUpdate) {
        throw new Error("UNDISPATCHED_INTENT_CANCELLATION_FENCE_LOST");
      }
    } else {
      await this.terminalOutbox.terminalizeUndispatched(manager, {
        intentId: intent.id,
        intentStatus: "cancelled",
        reason: CANCELLATION_CODE,
      });
    }

    const existingAudit = await manager.query(
      "SELECT 1 FROM audit_logs WHERE resource_type = $1 AND resource_id = $2 AND action = $3 AND status = $4 FOR UPDATE",
      ["deployment_intent", intent.id, "deployment_intent.cancelled_before_dispatch", "cancelled"],
    );
    if (existingAudit.length === 0) await manager.query(
      `INSERT INTO audit_logs (
        actor_user_id, actor_email, actor_role, action, category, resource_type,
        resource_id, status, ip_address, user_agent, metadata
      ) VALUES ($1, NULL, NULL, $2, 'infrastructure', 'deployment_intent', $3, 'cancelled', NULL, NULL, $4::jsonb)`,
      [
        intent.requestedByUserId,
        "deployment_intent.cancelled_before_dispatch",
        intent.id,
        JSON.stringify({
          projectId: input.projectId,
          environment: input.environmentName,
          infrastructureManifestId: infrastructure.id,
          releaseManifestId: release.id,
          outboxId: outbox[0].id,
          outcome: "cancelled_before_dispatch",
          safeCode: CANCELLATION_CODE,
        }),
      ],
    );

    return {
      intentId: intent.id,
      projectId: input.projectId,
      environmentName: input.environmentName,
      infrastructureManifestId: infrastructure.id,
      releaseManifestId: release.id,
      outboxId: outbox[0].id,
      auditRecorded: true,
      safeCode: CANCELLATION_CODE,
    };
  }
}
