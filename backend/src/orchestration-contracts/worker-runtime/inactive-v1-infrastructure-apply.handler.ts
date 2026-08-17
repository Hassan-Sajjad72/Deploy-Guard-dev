import { DataSource } from "typeorm";
import { V1InfrastructureManifestApplyService } from "../infrastructure/v1-infrastructure-manifest-apply.service";
import { V1FencedPlaceholderHandler, V1FencedPlaceholderHandlerContext, V1FencedPlaceholderOutcome } from "./v1-fenced-invocation.types";

type ApplyService = Pick<V1InfrastructureManifestApplyService, "applyFromFencedInvocation">;

/** Exact, fenced adapter for a separately approved infrastructure apply. */
export class InactiveV1InfrastructureApplyHandler
implements V1FencedPlaceholderHandler<"intent.infrastructure.apply"> {
  readonly messageType = "intent.infrastructure.apply" as const;
  readonly sideEffectPolicy = "deployguard.side-effect/v1" as const;
  readonly infrastructureApplyPolicy = "deployguard.infrastructure-apply-handler/inactive-v1" as const;

  constructor(private readonly dataSource: DataSource, private readonly apply: ApplyService) {}

  async invoke(context: V1FencedPlaceholderHandlerContext<"intent.infrastructure.apply">): Promise<V1FencedPlaceholderOutcome> {
    const evidence = await this.evidence(context);
    if (!evidence) return this.failure("INFRASTRUCTURE_APPLY_CONTEXT_INVALID");
    if (evidence.manifestStatus === "manual_review" && !evidence.allowReconciledPreflightRestart) {
      const reconciled = await this.apply.applyFromFencedInvocation(context.intent.infrastructureManifestId!, evidence.planHash);
      if (reconciled.state !== "applied") return { outcome: "apply_reconciliation_required" };
      const updated = await this.dataSource.query(
        `UPDATE deployment_side_effects SET status = 'succeeded', reconciliation_required = false,
           safe_result_code = 'INFRASTRUCTURE_APPLY_RECONCILED', failure_code = NULL,
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE intent_id = $1 AND effect_type = 'infrastructure_terraform_apply'
           AND status = 'uncertain'`,
        [context.intent.id],
      );
      if (!updated[1] && !updated.rowCount) return this.failure("INFRASTRUCTURE_APPLY_RECONCILIATION_CONFLICT");
      return { outcome: "success" };
    }
    const result = await context.sideEffects.execute({
      operationId: context.intent.id,
      idempotencyKey: context.intent.canonicalIdempotencyKey,
      effectType: "infrastructure_terraform_apply",
      inputFingerprint: evidence.planHash,
      timeoutMs: 15 * 60_000,
      perform: async () => {
        const applied = await this.apply.applyFromFencedInvocation(
          context.intent.infrastructureManifestId!, evidence.planHash,
          { allowReconciledPreflightRestart: evidence.allowReconciledPreflightRestart },
        );
        if (applied.state === "applied") return { outcome: "succeeded" as const, safeResultCode: "INFRASTRUCTURE_APPLY_VERIFIED", resultFingerprint: evidence.planHash };
        if (applied.state === "failed") return { outcome: "failed" as const, safeFailureCode: applied.safeCodes[0] || "INFRASTRUCTURE_APPLY_PREFLIGHT_FAILED" };
        return { outcome: "uncertain" as const, safeFailureCode: applied.safeCodes[0] || "INFRASTRUCTURE_APPLY_RECONCILIATION_REQUIRED" };
      },
    });
    return result.disposition === "failed"
      ? this.failure(result.effect.failureCode || "INFRASTRUCTURE_APPLY_PREFLIGHT_FAILED")
      : result.disposition === "reconciliation_required"
      ? { outcome: "apply_reconciliation_required" }
      : result.disposition !== "executed" && result.disposition !== "replayed"
      ? this.failure("INFRASTRUCTURE_APPLY_RECONCILIATION_REQUIRED")
      : result.effect.status === "succeeded"
        ? { outcome: "success" }
        : this.failure(result.effect.failureCode || "INFRASTRUCTURE_APPLY_RECONCILIATION_REQUIRED");
  }

  private async evidence(context: V1FencedPlaceholderHandlerContext<"intent.infrastructure.apply">) {
    if (context.intent.classification !== "infrastructure_change" || context.intent.status !== "running"
      || !context.intent.infrastructureManifestId || context.releaseManifest !== null
      || context.route.queueName !== "deployguard-infrastructure-v1" || context.route.lane !== "infrastructure"
      || context.route.operation !== "apply" || context.envelope.identity.intentId !== context.intent.id
      || context.envelope.identity.infrastructureManifestId !== context.intent.infrastructureManifestId) return null;
    const rows = await this.dataSource.query(
      `SELECT manifest.plan_artifact_sha256 AS "planHash", manifest.status AS "manifestStatus",
              child.request_payload->>'recoveryMode' AS "recoveryMode",
              child.request_payload->>'recoveryOfApplyIntentId' AS "recoveryOfApplyIntentId"
       FROM deployment_intents child
       INNER JOIN infrastructure_manifests manifest ON manifest.id = child.infrastructure_manifest_id
       INNER JOIN initial_release_drafts draft ON draft.intent_id = (child.request_payload->>'parentPlanIntentId')::uuid
       INNER JOIN deployment_intents parent ON parent.id = draft.intent_id
       INNER JOIN orchestration_outbox outbox ON outbox.intent_id = child.id
       WHERE child.id = $1 AND child.project_id = $2 AND child.environment_name = $3
         AND child.kind = 'apply' AND child.classification = 'infrastructure_change'
         AND child.request_payload->>'operation' = 'infrastructure_apply_continuation'
         AND (
           parent.status = 'plan_completed'
           OR (
             parent.status = 'failed'
             AND parent.failure_code = 'INFRASTRUCTURE_PLAN_CONTINUATION_FAILED'
             AND child.request_payload->>'parentPlanIntentId' = parent.id::text
           )
         ) AND manifest.status IN ('planned','manual_review')
         AND manifest.applied_at IS NULL AND draft.infrastructure_manifest_id = manifest.id
         AND outbox.event_type = 'intent.infrastructure.apply' AND outbox.status = 'published'
         AND outbox.published_job_id = $4 AND outbox.payload_sha256 = $5
       LIMIT 1`,
      [context.intent.id, context.intent.projectId, context.intent.environmentName, context.logicalJobId, context.envelope.idempotency.payloadSha256],
    ) as Array<{ planHash: string | null; manifestStatus: "planned" | "manual_review"; recoveryMode: string | null; recoveryOfApplyIntentId: string | null }>;
    const evidence = rows[0];
    if (!/^[0-9a-f]{64}$/.test(evidence?.planHash || "")) return null;
    return {
      ...evidence,
      allowReconciledPreflightRestart: ["reconciled_preflight", "reconciled_preflight_no_effect"].includes(evidence.recoveryMode || "")
        && typeof evidence.recoveryOfApplyIntentId === "string",
    };
  }
  private failure(safeFailureCode: string): V1FencedPlaceholderOutcome {
    return { outcome: "terminal_failure", safeFailureCode };
  }
}
