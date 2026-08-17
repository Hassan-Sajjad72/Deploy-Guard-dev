import { Inject, Injectable } from "@nestjs/common";
import { DataSource, EntityManager, In } from "typeorm";
import { canonicalSha256 } from "../contracts/canonical-json";
import { DeploymentIntent } from "../entities/deployment-intent.entity";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { InitialReleaseDraft } from "../entities/initial-release-draft.entity";
import { OrchestrationOutbox } from "../entities/orchestration-outbox.entity";
import { ProjectOperationLease } from "../entities/project-operation-lease.entity";
import { ProjectReleaseLaneOwnership } from "../entities/release-lane-ownership.entity";
import { TerminalOutboxPolicyService } from "../outbox/terminal-outbox-policy.service";
import { isNormalFirstReleasePlanOperation } from "./normal-first-release-plan-operation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = "FIRST_RELEASE_PLAN_CANCELLED_BEFORE_DISPATCH";
const RETRYABLE_TRANSACTION_CODES = new Set(["40001", "40P01"]);

export type NormalFirstReleaseUndispatchedPlanCancellationInput = Readonly<{
  intentId: string;
  projectId: string;
  environmentName: "dev";
  infrastructureManifestId: string;
  initialReleaseDraftId: string;
  outboxId: string;
  draftHash: string;
}>;

export type NormalFirstReleaseUndispatchedPlanCancellationResult = Readonly<{
  intentId: string;
  outboxId: string;
  safeCode: typeof SAFE_CODE;
  auditRecorded: true;
  replayed: boolean;
}>;

/**
 * Auditable recovery for a first-release plan operation that committed but was
 * never delivered. Historical manifests/drafts are immutable; only the exact
 * pristine intent and outbox are terminalized.
 */
@Injectable()
export class NormalFirstReleaseUndispatchedPlanCancellationService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(TerminalOutboxPolicyService)
    private readonly terminalOutbox = new TerminalOutboxPolicyService(),
  ) {}

  async cancel(
    input: NormalFirstReleaseUndispatchedPlanCancellationInput,
  ): Promise<NormalFirstReleaseUndispatchedPlanCancellationResult> {
    if (
      !UUID.test(input.intentId)
      || !UUID.test(input.projectId)
      || !UUID.test(input.infrastructureManifestId)
      || !UUID.test(input.initialReleaseDraftId)
      || !UUID.test(input.outboxId)
      || !/^[0-9a-f]{64}$/.test(input.draftHash)
      || input.environmentName !== "dev"
    ) throw new Error("FIRST_RELEASE_PLAN_CANCELLATION_SCOPE_INVALID");

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.dataSource.transaction(
          "SERIALIZABLE",
          (manager) => this.cancelInTransaction(manager, input),
        );
      } catch (error) {
        const code = String((error as { code?: unknown })?.code || "");
        if (attempt === 3 || !RETRYABLE_TRANSACTION_CODES.has(code)) throw error;
      }
    }
    throw new Error("FIRST_RELEASE_PLAN_CANCELLATION_RETRY_EXHAUSTED");
  }

  private async cancelInTransaction(
    manager: EntityManager,
    input: NormalFirstReleaseUndispatchedPlanCancellationInput,
  ) {
    await manager.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`deployguard:planner:${input.projectId}:${input.environmentName}`],
    );
    const intent = await manager.getRepository(DeploymentIntent).findOne({
      where: { id: input.intentId, projectId: input.projectId, environmentName: "dev" },
      lock: { mode: "pessimistic_write" },
    });
    const replayed = intent?.status === "cancelled" && intent.failureCode === SAFE_CODE;
    if (
      !intent
      || (!replayed && intent.status !== "planned")
      || !isNormalFirstReleasePlanOperation(intent)
      || intent.infrastructureManifestId !== input.infrastructureManifestId
      || intent.releaseManifestId !== null
      || intent.enqueuedAt !== null
      || intent.startedAt !== null
    ) throw new Error("FIRST_RELEASE_PLAN_CANCELLATION_NOT_ELIGIBLE");

    const manifest = await manager.getRepository(InfrastructureManifest).findOne({
        where: { id: input.infrastructureManifestId, projectId: input.projectId, environmentName: "dev" },
        lock: { mode: "pessimistic_read" },
      });
    const draft = await manager.getRepository(InitialReleaseDraft).findOne({
        where: {
          id: input.initialReleaseDraftId,
          intentId: input.intentId,
          projectId: input.projectId,
          environmentName: "dev",
        },
        lock: { mode: "pessimistic_read" },
      });
    const outboxes = await manager.getRepository(OrchestrationOutbox).find({
        where: { intentId: input.intentId },
        lock: { mode: "pessimistic_write" },
      });
    if (
      !manifest
      || !this.preExecutionManifest(manifest)
      || !draft
      || draft.infrastructureManifestId !== manifest.id
      || String(draft.infrastructureRevision) !== String(manifest.revision)
      || draft.draftHash !== input.draftHash
      || draft.draftHash !== canonicalSha256(draft.releaseDraft)
    ) throw new Error("FIRST_RELEASE_PLAN_CANCELLATION_EVIDENCE_CHANGED");

    const outbox = outboxes[0];
    if (
      outboxes.length !== 1
      || outbox.id !== input.outboxId
      || outbox.eventType !== "intent.infrastructure.plan"
      || !["pending", "dead_letter"].includes(outbox.status)
      || outbox.attemptCount !== 0
      || outbox.claimedBy !== null
      || outbox.claimExpiresAt !== null
      || outbox.publishedAt !== null
      || outbox.publishedJobId !== null
      || (!replayed && outbox.status !== "pending")
    ) throw new Error("FIRST_RELEASE_PLAN_CANCELLATION_OUTBOX_NOT_PRISTINE");

    const activeLeases = await manager.getRepository(ProjectOperationLease).count({
        where: { intentId: intent.id, status: In(["acquired", "heartbeat_active"]) },
      });
    const activeOwners = await manager.getRepository(ProjectReleaseLaneOwnership).count({
        where: {
          projectId: input.projectId,
          environmentName: "dev",
          deploymentIntentId: intent.id,
          status: In(["acquired", "heartbeat_active"]),
        },
      });
    const sideEffects = Number(rows<{ count: number }>(await manager.query(
      "SELECT count(*)::int AS count FROM deployment_side_effects WHERE intent_id = $1",
      [intent.id],
    ))[0]?.count || 0);
    if (activeLeases || activeOwners || sideEffects) {
      throw new Error("FIRST_RELEASE_PLAN_CANCELLATION_EXECUTION_EVIDENCE_PRESENT");
    }

    if (!replayed) {
      const transitioned = await this.terminalOutbox.transitionIntentToTerminal(manager, {
        intentId: intent.id,
        expectedStatus: "planned",
        status: "cancelled",
        failureCode: SAFE_CODE,
        failureMessage: "Cancelled before infrastructure planning dispatch.",
        reason: "INTENT_CANCELLED_BEFORE_DISPATCH",
      });
      if (!transitioned) throw new Error("FIRST_RELEASE_PLAN_CANCELLATION_FENCE_LOST");
    } else {
      await this.terminalOutbox.terminalizeUndispatched(manager, {
        intentId: intent.id,
        intentStatus: "cancelled",
        reason: "INTENT_CANCELLED_BEFORE_DISPATCH",
      });
    }

    const audit = rows<{ id: string }>(await manager.query(
      `SELECT id FROM audit_logs
       WHERE resource_type = 'deployment_intent' AND resource_id = $1
         AND action = 'deployment_intent.first_release_plan_cancelled_before_dispatch'
       FOR UPDATE`,
      [intent.id],
    ));
    if (audit.length === 0) await manager.query(
      `INSERT INTO audit_logs (
         actor_user_id, actor_email, actor_role, action, category,
         resource_type, resource_id, status, ip_address, user_agent, metadata
       ) VALUES (
         $1, NULL, NULL,
         'deployment_intent.first_release_plan_cancelled_before_dispatch',
         'infrastructure', 'deployment_intent', $2, 'cancelled',
         NULL, NULL, $3::jsonb
       )`,
      [
        intent.requestedByUserId,
        intent.id,
        JSON.stringify({
          projectId: input.projectId,
          environment: "dev",
          infrastructureManifestId: manifest.id,
          initialReleaseDraftId: draft.id,
          outboxId: outbox.id,
          safeCode: SAFE_CODE,
        }),
      ],
    );
    return Object.freeze({
      intentId: intent.id,
      outboxId: outbox.id,
      safeCode: SAFE_CODE,
      auditRecorded: true as const,
      replayed,
    });
  }

  private preExecutionManifest(manifest: InfrastructureManifest) {
    if (manifest.status === "desired") return manifest.appliedAt === null;
    return manifest.status === "failed"
      && manifest.failureCode === "REMOTE_CANARY_PLAN_NOT_ALLOWED"
      && manifest.planArtifactReference === null
      && manifest.planArtifactSha256 === null
      && manifest.planInputFingerprint === null
      && manifest.stateVersionId === null
      && manifest.terraformOutputs === null
      && manifest.terraformOutputsHash === null
      && manifest.resourceCount === null
      && manifest.plannedAt === null
      && manifest.applyStartedAt === null
      && manifest.appliedAt === null;
  }
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? result as T[] : [];
}
