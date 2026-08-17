import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { canonicalSha256 } from "../contracts/canonical-json";
import { ReleaseLaneShadowDecision } from "../entities/release-lane-shadow-observation.entity";
import { normalizeReleaseLaneEnvironment } from "./inactive-release-lane-ownership.pure";
import {
  ReleaseLaneShadowInsertionSource,
  ReleaseLaneShadowObservation,
  ReleaseLaneShadowObservationError,
  ReleaseLaneShadowObservationInput,
  ReleaseLaneShadowOperationClass,
  ReleaseLaneShadowResult,
} from "./inactive-release-lane-shadow-observer.types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY = /^[A-Za-z0-9._:@/-]{1,160}$/;
const OPERATION_CLASSES: readonly ReleaseLaneShadowOperationClass[] = [
  "legacy_full_deployment_run", "legacy_retry", "legacy_full_recovery_resume",
  "legacy_stage_selective_resume", "legacy_cost_approval_resume",
  "legacy_apply_approval_resume", "legacy_state_lock_resume",
  "legacy_infrastructure_deploy", "legacy_infrastructure_plan",
  "legacy_infrastructure_apply", "legacy_storage_provision", "legacy_rollback", "legacy_cancel",
  "legacy_worker_terminal_success", "legacy_worker_terminal_failure",
  "v1_plan_release", "v1_plan_infrastructure", "v1_plan_unsafe_or_unknown", "v1_plan_no_op",
  "v1_dispatch_release", "v1_dispatch_infrastructure", "v1_dispatch_deletion",
  "v1_consumer_claim_release", "v1_consumer_claim_infrastructure", "v1_consumer_claim_deletion",
];
const INSERTION_SOURCES: readonly ReleaseLaneShadowInsertionSource[] = [
  "pipeline_service.start_run", "stage_selective_resume.execute",
  "finops_service.resume_after_cost_approval", "pipeline_service.approve_terraform_apply",
  "infrastructure_service.release_state_lock", "infrastructure_service.deploy",
  "infrastructure_service.queue_plan", "infrastructure_service.queue_apply",
  "storage_service.provision",
  "pipeline_worker.full_deploy_pickup", "pipeline_worker.stage_selective_resume_pickup",
  "pipeline_worker.cost_approval_resume_pickup", "pipeline_worker.apply_approval_resume_pickup",
  "pipeline_worker.state_lock_resume_pickup", "pipeline_worker.infrastructure_plan_pickup",
  "pipeline_worker.infrastructure_apply_pickup", "pipeline_worker.storage_provision_pickup",
  "pipeline_worker.full_deploy_pre_mutation", "pipeline_worker.stage_selective_resume_pre_mutation",
  "pipeline_worker.cost_approval_resume_pre_mutation", "pipeline_worker.apply_approval_resume_pre_mutation",
  "pipeline_worker.state_lock_resume_pre_mutation", "pipeline_worker.infrastructure_plan_pre_mutation",
  "pipeline_worker.infrastructure_apply_pre_mutation", "pipeline_worker.storage_provision_pre_mutation",
  "rollback_service.rollback_to_previous_stable", "rollback_service.record_created",
  "rollback_service.before_ecs_update", "rollback_service.terminal_succeeded",
  "rollback_service.terminal_failed", "pipeline_service.cancel_persisted",
  "pipeline_worker.completed_persisted", "pipeline_worker.failed_persisted",
  "transactional_deployment_planner.plan",
  "durable_outbox_dispatcher.dispatch_one", "inactive_v1_bullmq_consumer.process_job",
];
const ACTIVE_LEGACY_STATUSES = [
  "queued", "running", "cost_analysis_running", "waiting_for_cost_approval",
  "state_lock_acquiring", "waiting_for_state_lock", "state_lock_acquired",
  "state_heartbeat_active", "state_validation_running", "state_lock_released",
  "storage_evaluation_running", "storage_not_required", "storage_provisioning",
  "storage_provisioned", "backup_configuring", "backup_configured",
  "ecs_deployment_queued", "ecs_task_definition_registering", "ecs_service_updating",
  "ecs_waiting_for_stability", "ecs_service_healthy", "rollback_started",
  "spot_interruption_handled", "apply_disabled",
];
const ACTIVE_V1_INTENT_STATUSES = ["received", "planned", "enqueued", "running"];
const ACTIVE_OPERATION_STATUSES = ["acquired", "heartbeat_active"];

type OwnershipEvidence = {
  ownerLane: "legacy" | "v1";
  fencingToken: string;
  status: string;
  expired: boolean;
  intentMismatched: boolean;
  leaseMismatched: boolean;
};

/**
 * Default-off observation only. It neither calls the ownership services nor
 * locks ownership rows, so it cannot alter release behavior.
 */
@Injectable()
export class InactiveReleaseLaneShadowObserverService {
  constructor(private readonly dataSource: DataSource) {}

  async observe(input: ReleaseLaneShadowObservationInput): Promise<ReleaseLaneShadowResult> {
    if (!isReleaseLaneShadowModeEnabled()) return { enabled: false };
    const normalized = this.validate(input);
    const canonicalOperationKey = canonicalSha256({ domain: "deployguard.release-lane-shadow.v1", identity: normalized.logicalOperationIdentity });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.dataSource.transaction("REPEATABLE READ", async (manager) => {
          const existing = await manager.query(
            `SELECT project_id AS "projectId", environment_name AS "environmentName", proposed_lane AS "proposedLane",
                    operation_class AS "operationClass", insertion_source AS "insertionSource", decision,
                    current_owner_lane AS "currentOwnerLane", current_fencing_token::text AS "currentFencingToken",
                    evidence_hash AS "evidenceHash", observed_at AS "observedAt"
             FROM project_release_lane_shadow_observations
             WHERE canonical_operation_key = $1 FOR UPDATE`,
            [canonicalOperationKey],
          );
          if (existing.length === 1) return this.replay(existing[0], normalized);

          const evidence = await this.readEvidence(manager, normalized.projectId, normalized.environmentName);
          const decision = this.decide(normalized, evidence);
          const evidenceHash = canonicalSha256({
            projectExists: evidence.projectExists,
            ownership: evidence.ownership ? {
              ownerLane: evidence.ownership.ownerLane,
              fencingToken: evidence.ownership.fencingToken,
              status: evidence.ownership.status,
              expired: evidence.ownership.expired,
              intentMismatched: evidence.ownership.intentMismatched,
              leaseMismatched: evidence.ownership.leaseMismatched,
            } : null,
            activeLegacy: evidence.activeLegacy,
            activeV1Intent: evidence.activeV1Intent,
            activeV1Operation: evidence.activeV1Operation,
            activeLegacyCorrelation: evidence.activeLegacyCorrelation,
          });
          const safeCurrentOwner = evidence.ownership
            && !evidence.ownership.expired
            && !evidence.ownership.intentMismatched
            && !evidence.ownership.leaseMismatched
            ? evidence.ownership
            : null;
          const saved = await manager.query(
            `INSERT INTO project_release_lane_shadow_observations (
              project_id, environment_name, proposed_lane, operation_class, insertion_source,
              canonical_operation_key, decision, current_owner_lane, current_fencing_token,
              evidence_hash, observed_at, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,$10,clock_timestamp(),clock_timestamp(),clock_timestamp())
            RETURNING project_id AS "projectId", environment_name AS "environmentName", proposed_lane AS "proposedLane",
              operation_class AS "operationClass", insertion_source AS "insertionSource", decision,
              current_owner_lane AS "currentOwnerLane", current_fencing_token::text AS "currentFencingToken",
              evidence_hash AS "evidenceHash", observed_at AS "observedAt"`,
            [normalized.projectId, normalized.environmentName, normalized.proposedLane,
              normalized.operationClass, normalized.insertionSource, canonicalOperationKey, decision,
              safeCurrentOwner?.ownerLane ?? null, safeCurrentOwner?.fencingToken ?? null, evidenceHash],
          );
          return { enabled: true, disposition: "observed", observation: this.observation(saved[0]) };
        });
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        if (attempt === 3 || !isSerializationFailure(error)) throw error;
      }
    }
    throw new ReleaseLaneShadowObservationError("SHADOW_OBSERVATION_TRANSACTION_CONFLICT");
  }

  private replay(row: Record<string, unknown>, input: NormalizedInput): ReleaseLaneShadowResult {
    if (row.projectId !== input.projectId || row.environmentName !== input.environmentName
      || row.proposedLane !== input.proposedLane || row.operationClass !== input.operationClass
      || row.insertionSource !== input.insertionSource) {
      return { enabled: true, disposition: "idempotency_conflict" };
    }
    return { enabled: true, disposition: "already_observed", observation: this.observation(row) };
  }

  private async readEvidence(manager: EntityManager, projectId: string, environmentName: string) {
    const project = await manager.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
    const ownershipRows = await manager.query(
        `SELECT owner_lane AS "ownerLane", fencing_token::text AS "fencingToken", status,
                expires_at <= clock_timestamp() AS expired,
                (deployment_intent_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM deployment_intents i WHERE i.id = deployment_intent_id
                    AND i.project_id = project_id AND i.environment_name = environment_name
                )) AS "intentMismatched",
                (operation_lease_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM project_operation_leases l WHERE l.id = operation_lease_id
                    AND l.project_id = project_id AND l.environment_name = environment_name
                )) AS "leaseMismatched"
         FROM project_release_lane_ownerships
         WHERE project_id = $1 AND environment_name = $2`,
      [projectId, environmentName],
    );
    const legacyRows = environmentName === "dev"
      ? await manager.query(`SELECT 1 FROM project_pipeline_runs WHERE project_id = $1 AND status::text = ANY($2::varchar[]) LIMIT 1`, [projectId, ACTIVE_LEGACY_STATUSES])
      : [];
    const intentRows = await manager.query(`SELECT 1 FROM deployment_intents WHERE project_id = $1 AND environment_name = $2 AND status = ANY($3::varchar[]) LIMIT 1`, [projectId, environmentName, ACTIVE_V1_INTENT_STATUSES]);
    const operationRows = await manager.query(`SELECT 1 FROM project_operation_leases WHERE project_id = $1 AND environment_name = $2 AND status = ANY($3::varchar[]) AND expires_at > clock_timestamp() LIMIT 1`, [projectId, environmentName, ACTIVE_OPERATION_STATUSES]);
    const correlationRows = environmentName === "dev"
      ? await manager.query(
          `SELECT 1 FROM project_pipeline_runs r
           WHERE r.project_id = $1 AND r.cross_lane_owner_lane = 'legacy'
             AND r.cross_lane_owner_environment_name = $2 AND r.cross_lane_ownership_id IS NOT NULL
             AND r.status::text = ANY($3::varchar[]) LIMIT 1`,
        [projectId, environmentName, ACTIVE_LEGACY_STATUSES],
      )
      : [];
    return {
      projectExists: project.length === 1,
      ownership: (ownershipRows[0] as OwnershipEvidence | undefined) ?? null,
      activeLegacy: legacyRows.length > 0,
      activeV1Intent: intentRows.length > 0,
      activeV1Operation: operationRows.length > 0,
      activeLegacyCorrelation: correlationRows.length > 0,
    };
  }

  private decide(input: NormalizedInput, evidence: Awaited<ReturnType<InactiveReleaseLaneShadowObserverService["readEvidence"]>>): ReleaseLaneShadowDecision {
    if (!evidence.projectExists) return "insufficient_evidence";
    if (evidence.ownership?.intentMismatched || evidence.ownership?.leaseMismatched || evidence.ownership?.expired) return "unsafe_stale";
    if (evidence.ownership) return evidence.ownership.ownerLane === "legacy" ? "would_block_legacy" : "would_block_v1";
    if (evidence.activeLegacy || evidence.activeLegacyCorrelation) return "would_block_legacy";
    if (evidence.activeV1Intent || evidence.activeV1Operation) return "would_block_v1";
    return "acquirable";
  }

  private validate(input: ReleaseLaneShadowObservationInput): NormalizedInput {
    const environmentName = normalizeReleaseLaneEnvironment(input.environmentName);
    if (!UUID.test(input.projectId) || (input.proposedLane !== "legacy" && input.proposedLane !== "v1")
      || !OPERATION_CLASSES.includes(input.operationClass) || !INSERTION_SOURCES.includes(input.insertionSource)
      || !IDENTITY.test(input.logicalOperationIdentity) || (input.proposedLane === "legacy" && environmentName !== "dev")) {
      throw new ReleaseLaneShadowObservationError("SHADOW_OBSERVATION_INPUT_INVALID");
    }
    return { ...input, environmentName };
  }

  private observation(row: Record<string, unknown>): ReleaseLaneShadowObservation {
    return {
      projectId: String(row.projectId), environmentName: String(row.environmentName),
      proposedLane: row.proposedLane as "legacy" | "v1",
      operationClass: row.operationClass as ReleaseLaneShadowOperationClass,
      insertionSource: row.insertionSource as ReleaseLaneShadowInsertionSource,
      decision: row.decision as ReleaseLaneShadowDecision,
      currentOwnerLane: (row.currentOwnerLane as "legacy" | "v1" | null) ?? null,
      currentFencingToken: row.currentFencingToken === null ? null : String(row.currentFencingToken),
      evidenceHash: String(row.evidenceHash), observedAt: new Date(String(row.observedAt)),
    };
  }
}

type NormalizedInput = Omit<ReleaseLaneShadowObservationInput, "environmentName"> & { environmentName: string };

export function isReleaseLaneShadowModeEnabled(value = process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE): boolean {
  return value === "true";
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "40001";
}
