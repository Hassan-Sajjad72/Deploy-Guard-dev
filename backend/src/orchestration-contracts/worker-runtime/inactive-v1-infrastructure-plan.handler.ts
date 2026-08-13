import { DataSource } from "typeorm";
import { canonicalSha256 } from "../contracts/canonical-json";
import { workerEnvelopeJobId } from "../contracts/worker-envelope.validator";
import {
  V1InfrastructureManifestPlanService,
} from "../infrastructure/v1-infrastructure-manifest-plan.service";
import {
  V1FencedPlaceholderHandler,
  V1FencedPlaceholderHandlerContext,
  V1FencedPlaceholderOutcome,
} from "./v1-fenced-invocation.types";

type PlanService = Pick<V1InfrastructureManifestPlanService, "plan">;

type PlanEvidenceRow = {
  draftId: string;
  draftHash: string;
  releaseDraft: Record<string, unknown>;
  planOutboxId: string;
  planArtifactSha256: string | null;
  planInputFingerprint: string | null;
  planReference: Record<string, unknown> | null;
};

/**
 * The plan-only infrastructure handler deliberately adapts the established
 * manifest planner.  It owns no Terraform lifecycle itself and cannot apply,
 * publish, or create a release.
 */
export class InactiveV1InfrastructurePlanHandler
implements V1FencedPlaceholderHandler<"intent.infrastructure.plan"> {
  readonly messageType = "intent.infrastructure.plan" as const;
  readonly sideEffectPolicy = "deployguard.side-effect/v1" as const;
  readonly infrastructurePlanPolicy =
    "deployguard.infrastructure-plan-handler/inactive-v1" as const;

  constructor(
    private readonly dataSource: DataSource,
    private readonly planner: PlanService,
  ) {
    if (!planner || typeof planner.plan !== "function") {
      throw new Error("INACTIVE_INFRASTRUCTURE_PLAN_HANDLER_INVALID");
    }
  }

  async invoke(
    context: V1FencedPlaceholderHandlerContext<"intent.infrastructure.plan">,
  ): Promise<V1FencedPlaceholderOutcome> {
    const preflight = await this.preflight(context);
    if (!preflight) return this.failure("INFRASTRUCTURE_PLAN_CONTEXT_INVALID");
    const inputFingerprint = canonicalSha256({
      schemaVersion: 1,
      intentId: context.intent.id,
      infrastructureManifestId: context.intent.infrastructureManifestId,
      initialReleaseDraftId: preflight.draftId,
      initialReleaseDraftHash: preflight.draftHash,
      envelopePayloadSha256: context.envelope.idempotency.payloadSha256,
    });
    try {
      const sideEffect = await context.sideEffects.execute({
        operationId: context.intent.id,
        idempotencyKey: context.intent.canonicalIdempotencyKey,
        effectType: "infrastructure_terraform_plan",
        inputFingerprint,
        timeoutMs: 15 * 60_000,
        perform: async () => {
          const result = await this.planner.plan(
            context.intent.infrastructureManifestId!,
          );
          if (result.state === "failed") {
            return {
              outcome: "failed" as const,
              safeFailureCode: this.safeCode(
                result.safeCode,
                "INFRASTRUCTURE_PLAN_FAILED",
              ),
            };
          }
          if (result.state === "planning") {
            return {
              outcome: "uncertain" as const,
              safeFailureCode: "INFRASTRUCTURE_PLAN_RECONCILIATION_REQUIRED",
            };
          }
          const evidence = await this.planEvidence(context, preflight.draftId);
          if (!this.savedPlanMatches(evidence)) {
            return {
              outcome: "uncertain" as const,
              safeFailureCode: "INFRASTRUCTURE_PLAN_EVIDENCE_UNCERTAIN",
            };
          }
          return {
            outcome: "succeeded" as const,
            safeResultCode: "INFRASTRUCTURE_PLAN_SAVED",
            resultFingerprint: canonicalSha256({
              planArtifactSha256: evidence.planArtifactSha256,
              planInputFingerprint: evidence.planInputFingerprint,
              planSummary: evidence.planReference?.planSummary ?? null,
            }),
            externalReferenceHash: canonicalSha256({
              workspaceRef: evidence.planReference?.workspaceRef ?? null,
              stateKey: evidence.planReference?.stateKey ?? null,
            }),
          };
        },
      });
      if (
        (sideEffect.disposition !== "executed"
          && sideEffect.disposition !== "replayed")
        || sideEffect.effect.status !== "succeeded"
      ) {
        return this.failure(
          sideEffect.disposition === "failed"
            ? sideEffect.effect.failureCode ?? "INFRASTRUCTURE_PLAN_FAILED"
            : "INFRASTRUCTURE_PLAN_RECONCILIATION_REQUIRED",
        );
      }
      const evidence = await this.planEvidence(context, preflight.draftId);
      if (!this.savedPlanMatches(evidence)) {
        return this.failure("INFRASTRUCTURE_PLAN_EVIDENCE_UNCERTAIN");
      }
      return Object.freeze({
        outcome: "plan_completed" as const,
        initialReleaseDraftId: evidence.draftId,
        planOutboxId: evidence.planOutboxId,
        planArtifactSha256: evidence.planArtifactSha256!,
        planInputFingerprint: evidence.planInputFingerprint!,
      });
    } catch {
      return this.failure("INFRASTRUCTURE_PLAN_HANDLER_FAILED");
    }
  }

  private async preflight(
    context: V1FencedPlaceholderHandlerContext<"intent.infrastructure.plan">,
  ) {
    if (
      context.route.messageType !== "intent.infrastructure.plan"
      || context.route.queueName !== "deployguard-infrastructure-v1"
      || context.route.lane !== "infrastructure"
      || context.route.operation !== "plan"
      || context.intent.classification !== "infrastructure_change"
      || context.intent.status !== "running"
      || !context.infrastructureManifest
      || context.infrastructureManifest.id !== context.intent.infrastructureManifestId
      || context.infrastructureManifest.status === "applied"
      || context.releaseManifest !== null
      || context.envelope.identity.releaseManifestId !== null
      || context.envelope.identity.infrastructureManifestId
        !== context.intent.infrastructureManifestId
      || context.envelope.identity.intentId !== context.intent.id
    ) return null;
    const evidence = await this.planEvidence(context, null);
    return evidence
      && evidence.draftId
      && evidence.draftHash === canonicalSha256(evidence.releaseDraft)
      && evidence.planOutboxId
      ? evidence
      : null;
  }

  private async planEvidence(
    context: V1FencedPlaceholderHandlerContext<"intent.infrastructure.plan">,
    requiredDraftId: string | null,
  ): Promise<PlanEvidenceRow | null> {
    const rows = this.rows<PlanEvidenceRow>(await this.dataSource.query(
      `SELECT draft.id AS "draftId", draft.draft_hash AS "draftHash",
              draft.release_draft AS "releaseDraft",
              outbox.id AS "planOutboxId",
              manifest.plan_artifact_sha256 AS "planArtifactSha256",
              manifest.plan_input_fingerprint AS "planInputFingerprint",
              manifest.plan_artifact_reference AS "planReference"
       FROM infrastructure_manifests manifest
       INNER JOIN initial_release_drafts draft
         ON draft.intent_id = $1
        AND draft.project_id = $2
        AND draft.environment_name = $3
        AND draft.infrastructure_manifest_id = manifest.id
       INNER JOIN orchestration_outbox outbox
         ON outbox.intent_id = $1
        AND outbox.event_type = 'intent.infrastructure.plan'
       WHERE manifest.id = $4
         AND manifest.project_id = $2
         AND manifest.environment_name = $3
         AND ($5::uuid IS NULL OR draft.id = $5::uuid)
         AND outbox.status = 'published'
         AND outbox.attempt_count >= 1
         AND outbox.claimed_by IS NULL
         AND outbox.claim_expires_at IS NULL
         AND outbox.published_job_id = $6
         AND outbox.payload_sha256 = $7
       LIMIT 1`,
      [
        context.intent.id,
        context.intent.projectId,
        context.intent.environmentName,
        context.intent.infrastructureManifestId,
        requiredDraftId,
        workerEnvelopeJobId(context.envelope),
        context.envelope.idempotency.payloadSha256,
      ],
    ));
    return rows[0] ?? null;
  }

  private savedPlanMatches(
    evidence: PlanEvidenceRow | null,
  ) {
    return Boolean(
      evidence
      && /^[0-9a-f]{64}$/.test(evidence.planArtifactSha256 ?? "")
      && /^[0-9a-f]{64}$/.test(evidence.planInputFingerprint ?? "")
      && evidence.planReference?.phase === "planned"
      && evidence.planReference?.artifactSha256 === evidence.planArtifactSha256
      && evidence.planReference?.inputFingerprint === evidence.planInputFingerprint
      && evidence.planReference?.planSummary
      && typeof evidence.planReference.planSummary === "object",
    );
  }

  private safeCode(value: string | null, fallback: string) {
    return value && /^[A-Z0-9_]{3,128}$/.test(value) ? value : fallback;
  }

  private failure(safeFailureCode: string): V1FencedPlaceholderOutcome {
    return Object.freeze({ outcome: "terminal_failure", safeFailureCode });
  }

  private rows<T>(value: unknown): T[] {
    if (Array.isArray(value) && value.length === 2 && Array.isArray(value[0])) {
      return value[0] as T[];
    }
    return Array.isArray(value) ? value as T[] : [];
  }
}
