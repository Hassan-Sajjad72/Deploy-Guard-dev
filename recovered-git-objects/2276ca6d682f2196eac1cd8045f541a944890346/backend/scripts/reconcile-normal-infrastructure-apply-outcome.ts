import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { TerraformRunnerService } from "../src/infrastructure/terraform-runner.service";
import { V1InfrastructureManifestApplyService } from "../src/orchestration-contracts/infrastructure/v1-infrastructure-manifest-apply.service";
import { InactiveReleaseLaneOwnershipService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;

function safe(state: "reconciled" | "blocked", safeCodes: string[]) {
  process.stdout.write(`${JSON.stringify({ state, safeCodes })}\n`);
}

void (async () => {
  const intentId = process.env.TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_OUTCOME_RECONCILIATION_INTENT_ID || "";
  if (process.env.TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_OUTCOME_RECONCILIATION_ENABLED !== "true" || !UUID.test(intentId)) {
    safe("blocked", ["NORMAL_INFRASTRUCTURE_APPLY_OUTCOME_RECONCILIATION_CONFIGURATION_INVALID"]);
    process.exitCode = 2;
    return;
  }
  const dataSource = new DataSource({ ...AppDataSource.options, migrations: [], synchronize: false, logging: false } as DataSourceOptions);
  try {
    await dataSource.initialize();
    const rows = await dataSource.query(
      `SELECT child.id AS "childId", child.status AS "childStatus", child.failure_code AS "childFailure",
              child.project_id AS "projectId", child.environment_name AS "environmentName",
              manifest.id AS "manifestId", manifest.status AS "manifestStatus", manifest.applied_at AS "appliedAt",
              manifest.state_version_id AS "stateVersionId", manifest.plan_artifact_sha256 AS "planHash",
              parent.status AS "parentStatus", parent.failure_code AS "parentFailure",
              effect.status AS "effectStatus", effect.failure_code AS "effectFailure",
              effect.reconciliation_required AS "reconciliationRequired",
              outbox.status AS "outboxStatus", outbox.attempt_count AS "attempts", outbox.claimed_by AS "claimedBy"
         FROM deployment_intents child
         JOIN deployment_intents parent ON parent.id = (child.request_payload->>'parentPlanIntentId')::uuid
         JOIN infrastructure_manifests manifest ON manifest.id = child.infrastructure_manifest_id
         JOIN deployment_side_effects effect ON effect.intent_id = child.id AND effect.effect_type = 'infrastructure_terraform_apply'
         JOIN orchestration_outbox outbox ON outbox.intent_id = child.id AND outbox.event_type = 'intent.infrastructure.apply'
        WHERE child.id = $1`,
      [intentId],
    ) as Array<Record<string, unknown>>;
    const evidence = rows[0];
    if (!evidence
      || evidence.childStatus !== "failed" || evidence.childFailure !== "INFRASTRUCTURE_APPLY_CONTEXT_INVALID"
      || evidence.parentStatus !== "failed" || evidence.parentFailure !== "INFRASTRUCTURE_PLAN_CONTINUATION_FAILED"
      || evidence.manifestStatus !== "applying" || evidence.appliedAt !== null || evidence.stateVersionId !== null
      || !HASH.test(String(evidence.planHash || ""))
      || evidence.effectStatus !== "uncertain" || evidence.effectFailure !== "SIDE_EFFECT_OUTCOME_UNKNOWN" || evidence.reconciliationRequired !== true
      || evidence.outboxStatus !== "published" || Number(evidence.attempts) !== 1 || evidence.claimedBy !== null) {
      throw new Error("NORMAL_INFRASTRUCTURE_APPLY_OUTCOME_RECONCILIATION_INELIGIBLE");
    }
    const active = await dataSource.query(
      `SELECT 1 FROM project_operation_leases WHERE project_id = $1 AND environment_name = $2
          AND status IN ('acquired','heartbeat_active') AND expires_at > clock_timestamp()
       UNION ALL
       SELECT 1 FROM project_release_lane_ownerships WHERE project_id = $1 AND environment_name = $2
          AND status IN ('acquired','heartbeat_active') AND expires_at > clock_timestamp()`,
      [evidence.projectId, evidence.environmentName],
    );
    if (active.length) throw new Error("NORMAL_INFRASTRUCTURE_APPLY_OUTCOME_RECONCILIATION_CONFLICT");

    const config = new ConfigService(process.env);
    const apply = new V1InfrastructureManifestApplyService(
      dataSource,
      config,
      new TerraformRunnerService(config),
      new InactiveReleaseLaneOwnershipService(dataSource),
    );
    const result = await apply.reconcileNormalAppliedState(String(evidence.manifestId), String(evidence.planHash));
    if (result.state !== "applied") throw new Error(result.safeCodes[0] || "NORMAL_INFRASTRUCTURE_APPLY_STATE_RECONCILIATION_REQUIRED");
    const persisted = await dataSource.query(
      `SELECT status, state_version_id AS "stateVersionId", terraform_outputs_hash AS "outputsHash"
         FROM infrastructure_manifests WHERE id = $1`,
      [evidence.manifestId],
    ) as Array<Record<string, unknown>>;
    if (persisted.length !== 1 || persisted[0].status !== "applied"
      || typeof persisted[0].stateVersionId !== "string" || !HASH.test(String(persisted[0].outputsHash || ""))) {
      throw new Error("NORMAL_INFRASTRUCTURE_APPLY_STATE_PERSISTENCE_MISSING");
    }

    await dataSource.transaction("SERIALIZABLE", async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`deployguard:normal-infrastructure-apply-outcome:${intentId}`]);
      const verified = await manager.query(
        `SELECT child.status AS "childStatus", child.failure_code AS "childFailure", manifest.status AS "manifestStatus",
                manifest.state_version_id AS "stateVersionId", manifest.terraform_outputs_hash AS "outputsHash",
                effect.status AS "effectStatus", effect.failure_code AS "effectFailure", outbox.status AS "outboxStatus"
           FROM deployment_intents child
           JOIN infrastructure_manifests manifest ON manifest.id = child.infrastructure_manifest_id
           JOIN deployment_side_effects effect ON effect.intent_id = child.id AND effect.effect_type = 'infrastructure_terraform_apply'
           JOIN orchestration_outbox outbox ON outbox.intent_id = child.id AND outbox.event_type = 'intent.infrastructure.apply'
          WHERE child.id = $1 FOR UPDATE`,
        [intentId],
      ) as Array<Record<string, unknown>>;
      const current = verified[0];
      if (!current || current.childStatus !== "failed" || current.childFailure !== "INFRASTRUCTURE_APPLY_CONTEXT_INVALID") {
        throw new Error("NORMAL_INFRASTRUCTURE_APPLY_OUTCOME_RECONCILIATION_INTENT_CHANGED");
      }
      if (current.manifestStatus !== "applied" || typeof current.stateVersionId !== "string" || !HASH.test(String(current.outputsHash || ""))) {
        throw new Error("NORMAL_INFRASTRUCTURE_APPLY_OUTCOME_RECONCILIATION_STATE_CHANGED");
      }
      if (current.effectStatus !== "uncertain" || current.effectFailure !== "SIDE_EFFECT_OUTCOME_UNKNOWN" || current.outboxStatus !== "published") {
        throw new Error("NORMAL_INFRASTRUCTURE_APPLY_OUTCOME_RECONCILIATION_EFFECT_CHANGED");
      }
      await manager.query(
        `UPDATE deployment_side_effects SET status = 'succeeded', reconciliation_required = false,
                safe_result_code = 'INFRASTRUCTURE_APPLY_RECONCILED_FROM_VERIFIED_STATE', result_fingerprint = $2,
                failure_code = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE intent_id = $1 AND effect_type = 'infrastructure_terraform_apply'
            AND status = 'uncertain' AND failure_code = 'SIDE_EFFECT_OUTCOME_UNKNOWN'`,
        [intentId, evidence.planHash],
      );
      await manager.query(
        `UPDATE deployment_intents SET status = 'completed', failure_code = NULL, failure_message = NULL,
                completed_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE id = $1 AND status = 'failed' AND failure_code = 'INFRASTRUCTURE_APPLY_CONTEXT_INVALID'`,
        [intentId],
      );
    });
    safe("reconciled", ["INFRASTRUCTURE_APPLY_RECONCILED_FROM_VERIFIED_STATE"]);
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "NORMAL_INFRASTRUCTURE_APPLY_OUTCOME_RECONCILIATION_FAILED";
    safe("blocked", [code]);
    process.exitCode = 3;
  } finally {
    await dataSource.destroy().catch(() => undefined);
  }
})();
