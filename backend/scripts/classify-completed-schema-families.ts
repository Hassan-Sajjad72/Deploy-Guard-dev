import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPERATIONAL_OWNERSHIP_FOREIGN_KEYS } from "../src/migrations/1760000057000-ReconcileOperationalOwnershipForeignKeys";
import {
  VERIFIED_LIFECYCLE_FOREIGN_KEYS,
  VERIFIED_PROJECT_IDENTITY_INDEXES,
} from "../src/migrations/1760000058000-ReconcileVerifiedLifecycleIntegrity";
import { TERRAFORM_LOCK_PIPELINE_HISTORY_FOREIGN_KEY } from "../src/migrations/1760000059000-PreserveReleasedTerraformLockHistory";

type Raw = Record<string, any>;
type FinalClassification =
  | "migration_authoritative_database_only"
  | "intentionally_database_only"
  | "equivalent_access_path"
  | "equivalent_predicate_representation"
  | "equivalent_duplicate_unique_enforcement"
  | "genuinely_missing_guarded_migration"
  | "unresolved_retained_history_orphans"
  | "unresolved_requires_clone_verification"
  | "intentionally_metadata_only_compatibility"
  | "unresolved_catalog_contradiction"
  | "pending_family_audit";

type ClassifiedRow = {
  semanticId: string;
  table: string;
  kind: string;
  generatedClassification: string;
  family: string | null;
  finalClassification: FinalClassification;
  requiresSchemaChange: boolean;
  decisionGroup: string | null;
  evidence: string;
  rationale: string;
  sourcePresence: { metadata: boolean; fresh: boolean; clone: boolean };
};

const repositoryRoot = resolve(__dirname, "../..");
const evidenceRoot = resolve(
  repositoryRoot,
  "docs/architecture/two-lane-migration/evidence",
);
const inputPath = resolve(evidenceRoot, "schema-reconciliation.json");
const jsonPath = resolve(evidenceRoot, "completed-family-classifications.json");
const csvPath = resolve(evidenceRoot, "completed-family-classifications.csv");

const families: Record<string, { section: string; tables: string[] }> = {
  intent_dispatch_ownership: {
    section: "Bounded family: intent dispatch and ownership",
    tables: [
      "deployment_intents",
      "orchestration_outbox",
      "project_operation_leases",
      "project_release_lane_ownerships",
      "deployment_side_effects",
      "deployment_side_effect_reconciliations",
      "deployment_side_effect_reconciliation_leases",
    ],
  },
  manifest_release_lineage: {
    section: "Bounded family: manifest and release lineage",
    tables: [
      "infrastructure_manifests",
      "release_manifests",
      "initial_release_drafts",
      "project_state_revisions",
    ],
  },
  release_provenance_stable_projection: {
    section: "Bounded family: release provenance and stable projection",
    tables: ["release_image_provenances", "project_stable_releases"],
  },
  preparation_evidence_snapshots: {
    section: "Bounded family: preparation evidence snapshots",
    tables: [
      "project_detection_profiles",
      "project_deployment_contracts",
      "project_preflight_reports",
    ],
  },
  pipeline_deployment_history: {
    section: "Pipeline/deployment status-history audit",
    tables: [
      "project_pipeline_runs",
      "project_deployments",
      "project_pipeline_events",
      "project_pipeline_job_finalities",
    ],
  },
  infrastructure_observability: {
    section: "Infrastructure and observability support-index audit",
    tables: [
      "project_infrastructure_environments",
      "project_infrastructure_events",
      "project_observability_events",
      "project_runtime_metric_snapshots",
    ],
  },
  state_storage_recovery: {
    section: "State, storage, rollback and recovery residual audit",
    tables: [
      "project_backup_records",
      "project_cloud_states",
      "project_deployment_queue_items",
      "project_rollback_records",
      "project_state_recovery_requests",
      "project_state_validation_results",
      "project_storage_events",
      "project_storage_restore_requests",
      "project_terraform_locks",
    ],
  },
  project_identity_destruction: {
    section: "Project identity and destruction lifecycle residual audit",
    tables: [
      "infrastructure_destroy_operations",
      "infrastructure_destroy_challenges",
      "projects",
    ],
  },
  ai_troubleshooting_history: {
    section: "AI troubleshooting history support-index audit",
    tables: [
      "ai_analysis_sessions",
      "ai_analysis_messages",
      "ai_analysis_results",
    ],
  },
  notification_delivery_preferences: {
    section: "Notification preference, subscription and delivery support-index audit",
    tables: [
      "notification_deliveries",
      "notification_preferences",
      "notification_subscriptions",
    ],
  },
  billing_finops_support: {
    section: "Billing and FinOps support-index and reviewer-lineage audit",
    tables: [
      "billing_checkout_sessions",
      "billing_invoices",
      "billing_usage_counters",
      "billing_usage_events",
      "project_cost_estimates",
    ],
  },
  project_activity_configuration: {
    section: "Project activity and configuration support-index audit",
    tables: [
      "project_user_activity",
      "project_configuration_snapshots",
      "project_environment_variables",
      "project_database_tiers",
    ],
  },
  terraform_export_orchestration: {
    section: "Terraform export and orchestration event support-index audit",
    tables: [
      "terraform_export_artifacts",
      "project_orchestration_events",
    ],
  },
};

const predicateRepresentationGroups = new Set([
  "IDX_orchestration_outbox_dispatch",
  "UQ_side_effect_reconciliation_lease_active",
  "UQ_project_operation_lease_active_scope",
  "UQ_infrastructure_manifest_current_applied",
  "UQ_release_manifest_current_stable",
  "UQ_project_stable_release_scope",
]);

const contradictoryIndexGroups = new Set([
  "IDX_release_lane_ownership_deployment_intent",
  "IDX_release_lane_ownership_operation_lease",
  "IDX_pipeline_runs_cross_lane_ownership",
  "IDX_rollback_records_cross_lane_ownership",
]);

const databaseOnlyLookupGroups = new Set([
  "IDX_project_deployment_contracts_commit",
  "IDX_detection_input_fingerprint",
  "IDX_preflight_input_fingerprint",
  "IDX_pipeline_events_canonical_order",
  "IDX_project_infrastructure_events_canonical_order",
]);

const redundantPreparationProjectIndexes = new Set([
  "IDX_34e94812d10dbe5bdce7eccf12",
  "IDX_f181b71587fcabe56f68aede31",
]);

const guardedForeignKeys = new Set(
  [
    ...OPERATIONAL_OWNERSHIP_FOREIGN_KEYS,
    ...VERIFIED_LIFECYCLE_FOREIGN_KEYS,
    TERRAFORM_LOCK_PIPELINE_HISTORY_FOREIGN_KEY,
  ].map((spec) =>
    `${spec.tableName}.${spec.columnName}`),
);
const verifiedLifecycleForeignKeys = new Set(
  VERIFIED_LIFECYCLE_FOREIGN_KEYS.map((spec) =>
    `${spec.tableName}.${spec.columnName}`),
);
const verifiedProjectIdentityIndexes = new Set(
  VERIFIED_PROJECT_IDENTITY_INDEXES.map((spec) => spec.indexName),
);
const terraformLockHistoryRelationship =
  `${TERRAFORM_LOCK_PIPELINE_HISTORY_FOREIGN_KEY.tableName}.${TERRAFORM_LOCK_PIPELINE_HISTORY_FOREIGN_KEY.columnName}`;

function guardedMigrationFor(relationship: string): string {
  if (relationship === terraformLockHistoryRelationship) return "1760000059000";
  if (verifiedLifecycleForeignKeys.has(relationship)) return "1760000058000";
  return "1760000057000";
}

function rawNames(row: Raw): string[] {
  return [...row.metadata, ...row.fresh, ...row.clone]
    .map((object) => String(object.name))
    .sort();
}

function familyFor(table: string) {
  return Object.entries(families)
    .find(([, family]) => family.tables.includes(table)) ?? null;
}

export function classifyRow(row: Raw): ClassifiedRow {
  const semantic = JSON.parse(row.semanticId);
  const table = String(semantic.table);
  const familyEntry = familyFor(table);
  const names = rawNames(row);
  const knownName = names.find((name) => predicateRepresentationGroups.has(name))
    ?? names.find((name) => contradictoryIndexGroups.has(name))
    ?? names.find((name) => databaseOnlyLookupGroups.has(name))
    ?? names.find((name) => redundantPreparationProjectIndexes.has(name))
    ?? null;
  const sourcePresence = {
    metadata: row.metadata.length > 0,
    fresh: row.fresh.length > 0,
    clone: row.clone.length > 0,
  };
  const base = {
    semanticId: row.semanticId,
    table,
    kind: String(row.kind),
    generatedClassification: String(row.classification),
    family: familyEntry?.[0] ?? null,
    requiresSchemaChange: false as const,
    decisionGroup: knownName,
    sourcePresence,
  };
  if (!familyEntry) {
    return {
      ...base,
      finalClassification: "pending_family_audit",
      evidence: "No completed-family decision applies.",
      rationale: "Ownership, retention and workload evidence has not yet been audited for this table family.",
    };
  }
  const section = `TYPEORM_SCHEMA_CONTRACT_AUDIT.md#${familyEntry[1].section}`;
  if (familyEntry[0] === "project_identity_destruction") {
    const keyItems = Array.isArray(semantic.keyItems)
      ? semantic.keyItems.map(String)
      : [];
    if (row.kind === "foreign_key"
      && sourcePresence.fresh && !sourcePresence.clone && !sourcePresence.metadata) {
      const relationship = `${table}.${String(semantic.sourceColumns?.[0] ?? "")}`;
      if (verifiedLifecycleForeignKeys.has(relationship)) {
        return {
          ...base,
          finalClassification: "genuinely_missing_guarded_migration",
          requiresSchemaChange: true,
          decisionGroup: relationship,
          evidence: section,
          rationale: "A newly recreated data-bearing clone confirms this migration-authoritative lifecycle key is operationally absent while source/target types match, the target key is unique and orphan count is zero. Guarded additive migration 1760000058000 restores it with bounded locking, NOT VALID and atomic validation.",
        };
      }
      return {
        ...base,
        finalClassification: "unresolved_requires_clone_verification",
        decisionGroup: `${table}.${String(semantic.sourceColumns?.[0] ?? "")}`,
        evidence: section,
        rationale: "Historical migrations define this nullable SET NULL relationship and the runtime preserves the linked history, but the persisted operational catalog inventory does not contain it. A new data-bearing clone must prove matching key types and zero orphans before any guarded additive migration is authorized.",
      };
    }
    if (table === "projects" && row.kind === "unique"
      && sourcePresence.fresh && !sourcePresence.clone && !sourcePresence.metadata) {
      const indexName = names[0] ?? "projects.active_identity";
      if (verifiedProjectIdentityIndexes.has(indexName)) {
        return {
          ...base,
          finalClassification: "genuinely_missing_guarded_migration",
          requiresSchemaChange: true,
          decisionGroup: indexName,
          evidence: section,
          rationale: "The serialized project-creation contract requires this active repository/branch/environment identity guard. A new data-bearing clone proves the exact column types and zero duplicate groups; guarded additive migration 1760000058000 restores the exact partial unique index after semantic-equivalence checks.",
        };
      }
      return {
        ...base,
        finalClassification: "unresolved_requires_clone_verification",
        decisionGroup: names[0] ?? "projects.active_identity",
        evidence: section,
        rationale: "The fresh migration contract and serialized project-creation query require this active repository/branch/environment identity guard. The operational catalog inventory lacks it, so duplicate checks on a new data-bearing clone are required before an additive unique index can be authorized.",
      };
    }
    if (table === "infrastructure_destroy_operations" && row.kind === "index"
      && keyItems.join(",") === "project_id,created_at") {
      return {
        ...base,
        finalClassification: "intentionally_database_only",
        decisionGroup: names[0] ?? "infrastructure_destroy_operations.project_created",
        evidence: section,
        rationale: "The migration-defined ordered project/created-at index directly serves latest destroy-status and cleanup-history reads. It remains database-only because modeling it is unnecessary for bounded TypeORM compositions.",
      };
    }
    if (table === "infrastructure_destroy_operations" && row.kind === "index"
      && keyItems.join(",") === "project_id") {
      return {
        ...base,
        finalClassification: "equivalent_access_path",
        decisionGroup: names[0] ?? "infrastructure_destroy_operations.project",
        evidence: section,
        rationale: "The fresh composite project/created-at index supplies the leading project lookup and latest ordering used by the lifecycle service. The clone/metadata single-column index is retained compatibility, not a missing fresh access path.",
      };
    }
    if (row.kind === "index" && sourcePresence.metadata
      && sourcePresence.clone && !sourcePresence.fresh) {
      return {
        ...base,
        finalClassification: "intentionally_metadata_only_compatibility",
        decisionGroup: names[0] ?? `${table}.${keyItems.join("_")}`,
        evidence: section,
        rationale: "The operational clone and entity metadata agree on this compatibility index, but committed lifecycle queries use the primary operation/challenge identity plus project/user guards and do not prove a missing fresh workload path. It is retained operationally and is not added to fresh schema without measured need.",
      };
    }
  }
  if (familyEntry[0] === "ai_troubleshooting_history" && row.kind === "index") {
    const keyItems = Array.isArray(semantic.keyItems)
      ? semantic.keyItems.map(String)
      : [];
    if (keyItems.length === 2 && sourcePresence.fresh
      && !sourcePresence.clone && !sourcePresence.metadata) {
      return {
        ...base,
        finalClassification: "intentionally_database_only",
        decisionGroup: names[0] ?? `${table}.${keyItems.join("_")}`,
        evidence: section,
        rationale: "The historical migration defines this ordered composite index and the committed AI history service uses the same leading equality key plus timestamp or revision ordering. It is an intentional database-only workload index and does not require TypeORM metadata.",
      };
    }
    if (keyItems.length === 1 && ["project_id", "session_id"].includes(keyItems[0])
      && sourcePresence.metadata && sourcePresence.clone && !sourcePresence.fresh) {
      return {
        ...base,
        finalClassification: "equivalent_access_path",
        decisionGroup: names[0] ?? `${table}.${keyItems[0]}`,
        evidence: section,
        rationale: "The migration composite begins with this equality key and serves the same committed lookup while also satisfying its ordering. The clone/metadata single-column index is retained compatibility rather than a missing fresh access path.",
      };
    }
    if (table === "ai_analysis_sessions" && keyItems.length === 1
      && ["pipeline_run_id", "user_id"].includes(keyItems[0])
      && sourcePresence.metadata && sourcePresence.clone && !sourcePresence.fresh) {
      return {
        ...base,
        finalClassification: "intentionally_metadata_only_compatibility",
        decisionGroup: names[0] ?? `${table}.${keyItems[0]}`,
        evidence: section,
        rationale: keyItems[0] === "user_id"
          ? "Metadata and the operational clone retain this per-user access path, and the rate-limit query filters by user and recent creation time. No fresh query-plan or workload evidence proves that another index must be added, so it remains compatibility-only."
          : "Metadata and the operational clone retain this pipeline correlation index, but committed AI session reads resolve by primary session identity or project history and do not use a standalone pipeline-run predicate. No fresh addition is authorized.",
      };
    }
  }
  if (familyEntry[0] === "notification_delivery_preferences"
    && row.kind === "index") {
    const keyItems = Array.isArray(semantic.keyItems)
      ? semantic.keyItems.map(String)
      : [];
    if (table === "notification_deliveries"
      && keyItems.join(",") === "project_id,created_at"
      && sourcePresence.fresh && !sourcePresence.clone && !sourcePresence.metadata) {
      return {
        ...base,
        finalClassification: "intentionally_database_only",
        decisionGroup: names[0] ?? "notification_deliveries.project_created",
        evidence: section,
        rationale: "The migration-defined project/created-at index directly serves the bounded recent-delivery settings read. It is an intentional ordered database access path and does not require duplicate TypeORM metadata.",
      };
    }
    if (keyItems.length === 1 && sourcePresence.metadata
      && sourcePresence.clone && !sourcePresence.fresh
      && !(table === "notification_deliveries" && keyItems[0] === "user_id")) {
      return {
        ...base,
        finalClassification: "equivalent_access_path",
        decisionGroup: names[0] ?? `${table}.${keyItems[0]}`,
        evidence: section,
        rationale: table === "notification_deliveries"
          ? "The ordered project/created-at migration index supplies the project lookup and result ordering used by recent delivery history. The clone/metadata project index is retained compatibility, not a missing fresh path."
          : "The migration-defined user/project uniqueness contract serves every committed preference or subscription lookup, including destination where required. The clone/metadata single-column index is retained compatibility and no duplicate fresh index is authorized.",
      };
    }
    if (table === "notification_deliveries"
      && keyItems.join(",") === "user_id"
      && sourcePresence.metadata && sourcePresence.clone && !sourcePresence.fresh) {
      return {
        ...base,
        finalClassification: "intentionally_metadata_only_compatibility",
        decisionGroup: names[0] ?? "notification_deliveries.user_id",
        evidence: section,
        rationale: "Metadata and the operational clone retain this user index, but delivery deduplication uses its unique key and settings history also filters by project with ordered project/created-at support. No independent user-only workload or measured fresh gap authorizes another index.",
      };
    }
  }
  if (familyEntry[0] === "billing_finops_support") {
    const keyItems = Array.isArray(semantic.keyItems)
      ? semantic.keyItems.map(String)
      : [];
    if (row.kind === "foreign_key"
      && table === "project_cost_estimates"
      && ["approved_by_user_id", "rejected_by_user_id"]
        .includes(String(semantic.sourceColumns?.[0] ?? ""))
      && sourcePresence.fresh && !sourcePresence.clone && !sourcePresence.metadata) {
      const relationship = `${table}.${String(semantic.sourceColumns?.[0] ?? "")}`;
      if (verifiedLifecycleForeignKeys.has(relationship)) {
        return {
          ...base,
          finalClassification: "genuinely_missing_guarded_migration",
          requiresSchemaChange: true,
          decisionGroup: relationship,
          evidence: section,
          rationale: "A new data-bearing clone proves integer key compatibility and zero reviewer-history orphans. Guarded additive migration 1760000058000 restores this nullable SET NULL relationship with bounded locking, NOT VALID and atomic validation.",
        };
      }
      return {
        ...base,
        finalClassification: "unresolved_requires_clone_verification",
        decisionGroup: `${table}.${String(semantic.sourceColumns?.[0] ?? "")}`,
        evidence: section,
        rationale: "Historical FinOps DDL defines this nullable SET NULL reviewer-history relationship, but the persisted operational catalog inventory lacks it. A new data-bearing clone must prove integer key compatibility and zero orphans before any guarded additive migration is authorized.",
      };
    }
    if (row.kind === "index" && table === "billing_usage_events"
      && keyItems.join(",") === "user_id,created_at"
      && sourcePresence.fresh && !sourcePresence.clone && !sourcePresence.metadata) {
      return {
        ...base,
        finalClassification: "intentionally_database_only",
        decisionGroup: names[0] ?? "billing_usage_events.user_created",
        evidence: section,
        rationale: "The migration-defined user/created-at index is the ordered access path for the retained immutable usage ledger. Runtime consumption uses a separate unique idempotency key, so no duplicate metadata representation is required.",
      };
    }
    if (row.kind === "index"
      && ((table === "billing_usage_events" && keyItems.join(",") === "user_id")
        || (table === "billing_usage_counters" && keyItems.join(",") === "user_id"))
      && sourcePresence.metadata && sourcePresence.clone && !sourcePresence.fresh) {
      return {
        ...base,
        finalClassification: "equivalent_access_path",
        decisionGroup: names[0] ?? `${table}.user_id`,
        evidence: section,
        rationale: table === "billing_usage_events"
          ? "The ordered migration index begins with user_id and supplies the same ledger lookup. The metadata/clone single-column index is retained compatibility, not a missing fresh path."
          : "The migration-defined unique (user_id, metric, period_start) counter contract serves both exact consumption and current-period usage queries. The metadata/clone user index is an equivalent retained path.",
      };
    }
    if (row.kind === "index"
      && ["billing_checkout_sessions", "billing_invoices"].includes(table)
      && keyItems.join(",") === "user_id"
      && sourcePresence.metadata && sourcePresence.clone && !sourcePresence.fresh) {
      return {
        ...base,
        finalClassification: "intentionally_metadata_only_compatibility",
        decisionGroup: names[0] ?? `${table}.user_id`,
        evidence: section,
        rationale: table === "billing_invoices"
          ? "Metadata and the operational clone retain this user invoice-history index. The summary query is bounded to 25 rows, and no fresh query-plan evidence proves an additive index requirement, so it remains compatibility-only."
          : "Metadata and the operational clone retain this checkout owner index, but committed checkout processing writes by provider identity and has no user-history read. No fresh addition is authorized.",
      };
    }
  }
  if (familyEntry[0] === "project_activity_configuration") {
    const keyItems = Array.isArray(semantic.keyItems)
      ? semantic.keyItems.map(String)
      : [];
    if (table === "project_user_activity" && row.kind === "index"
      && ["user_id,last_meaningful_activity_at", "user_id,last_viewed_at"]
        .includes(keyItems.join(","))
      && sourcePresence.fresh && !sourcePresence.clone && !sourcePresence.metadata) {
      return {
        ...base,
        finalClassification: "intentionally_database_only",
        decisionGroup: names[0] ?? `${table}.${keyItems.join("_")}`,
        evidence: section,
        rationale: "The canonical recency migration defines this user-scoped ordered path. Workspace activity loads by user and ranks the matching timestamp fields, so the leading equality key and recency order are intentional database support without duplicate TypeORM metadata.",
      };
    }
    if (table === "project_user_activity" && row.kind === "index"
      && keyItems.join(",") === "user_id"
      && sourcePresence.metadata && sourcePresence.clone && !sourcePresence.fresh) {
      return {
        ...base,
        finalClassification: "equivalent_access_path",
        decisionGroup: names[0] ?? `${table}.user_id`,
        evidence: section,
        rationale: "Both fresh recency indexes begin with user_id and serve the committed per-user activity load. The metadata/clone single-column index is a retained equivalent path rather than a missing fresh object.",
      };
    }
    if (table === "project_user_activity" && row.kind === "index"
      && keyItems.join(",") === "project_id"
      && sourcePresence.metadata && sourcePresence.clone && !sourcePresence.fresh) {
      return {
        ...base,
        finalClassification: "intentionally_metadata_only_compatibility",
        decisionGroup: names[0] ?? `${table}.project_id`,
        evidence: section,
        rationale: "Metadata and the operational clone retain this project index for relation and cascade compatibility. Committed activity reads load by user and exact writes use the unique (user_id, project_id) key; no project-only workload proves a missing fresh index.",
      };
    }
    if (table === "project_configuration_snapshots" && row.kind === "index"
      && keyItems.join(",") === "pipeline_run_id"
      && sourcePresence.metadata && sourcePresence.clone && !sourcePresence.fresh) {
      return {
        ...base,
        finalClassification: "equivalent_access_path",
        decisionGroup: names[0] ?? `${table}.pipeline_run_id`,
        evidence: section,
        rationale: "The migration-defined unique pipeline_run_id index already enforces one immutable snapshot per run and serves every exact snapshot lookup. The metadata/clone non-unique index is duplicate retained compatibility, not a missing fresh path.",
      };
    }
    if (table === "project_environment_variables" && row.kind === "index"
      && keyItems.join(",") === "project_id,normalized_key"
      && sourcePresence.fresh && !sourcePresence.clone && !sourcePresence.metadata) {
      return {
        ...base,
        finalClassification: "intentionally_database_only",
        decisionGroup: names[0] ?? `${table}.project_normalized_key`,
        evidence: section,
        rationale: "The canonical configuration migration creates this exact project/normalized-key path before its managed-database ownership rewrite. Runtime configuration also resolves project rows and canonical normalized keys while secret values remain non-selectable by default. It is retained as migration-authoritative database support without metadata duplication.",
      };
    }
    if (table === "project_database_tiers" && row.kind === "unique"
      && keyItems.join(",") === "project_id"
      && sourcePresence.metadata && sourcePresence.fresh && sourcePresence.clone) {
      return {
        ...base,
        finalClassification: "equivalent_duplicate_unique_enforcement",
        decisionGroup: `${table}.project_id.unique`,
        evidence: section,
        rationale: "Every source enforces exactly one database tier per project. Fresh has one named unique constraint; the one-to-one metadata and operational clone contain redundant unique-index/relation representations. No enforcement is missing and no existing object is changed in this audit.",
      };
    }
  }
  if (familyEntry[0] === "terraform_export_orchestration") {
    const keyItems = Array.isArray(semantic.keyItems)
      ? semantic.keyItems.map(String)
      : [];
    if (table === "project_orchestration_events" && row.kind === "foreign_key"
      && String(semantic.sourceColumns?.[0] ?? "") === "project_id"
      && sourcePresence.fresh && !sourcePresence.clone && !sourcePresence.metadata) {
      const relationship = `${table}.project_id`;
      if (verifiedLifecycleForeignKeys.has(relationship)) {
        return {
          ...base,
          finalClassification: "genuinely_missing_guarded_migration",
          requiresSchemaChange: true,
          decisionGroup: relationship,
          evidence: section,
          rationale: "A new data-bearing clone proves UUID compatibility and zero orphan event rows. Guarded additive migration 1760000058000 restores the historical CASCADE ownership key with bounded locking, NOT VALID and atomic validation.",
        };
      }
      return {
        ...base,
        finalClassification: "unresolved_requires_clone_verification",
        decisionGroup: `${table}.project_id`,
        evidence: section,
        rationale: "Historical orchestration DDL defines project ownership with ON DELETE CASCADE, but the persisted operational catalog lacks the key while retaining event history. A new data-bearing clone must prove UUID compatibility and zero orphan event rows before a guarded additive migration is authorized.",
      };
    }
    if (table === "project_orchestration_events" && row.kind === "index"
      && keyItems.join(",") === "project_id,pipeline_run_id,occurred_at,sequence_number"
      && sourcePresence.fresh && !sourcePresence.clone && !sourcePresence.metadata) {
      return {
        ...base,
        finalClassification: "intentionally_database_only",
        decisionGroup: names[0] ?? `${table}.canonical_order`,
        evidence: section,
        rationale: "The canonical event-time migration defines this ordered project/run timeline index. AI evidence collection uses the same project and pipeline predicates with occurred-at and sequence ordering, so it remains an intentional database-only workload path.",
      };
    }
    if (table === "terraform_export_artifacts" && row.kind === "index"
      && keyItems.join(",") === "expires_at"
      && sourcePresence.fresh && !sourcePresence.clone && !sourcePresence.metadata) {
      return {
        ...base,
        finalClassification: "intentionally_database_only",
        decisionGroup: names[0] ?? `${table}.expires_at`,
        evidence: section,
        rationale: "The migration-defined expiry index directly serves bounded deletion of expired, short-lived export archives after artifact creation. It is an intentional database-only retention path and requires no TypeORM metadata duplicate.",
      };
    }
    if (table === "terraform_export_artifacts" && row.kind === "index"
      && ["project_id", "user_id"].includes(keyItems.join(","))
      && sourcePresence.metadata && sourcePresence.clone && !sourcePresence.fresh) {
      return {
        ...base,
        finalClassification: "intentionally_metadata_only_compatibility",
        decisionGroup: names[0] ?? `${table}.${keyItems[0]}`,
        evidence: section,
        rationale: keyItems[0] === "project_id"
          ? "Metadata and the operational clone retain this project index, but download resolves by artifact primary key plus project guard and no project-history list exists. No measured fresh workload authorizes another index."
          : "Metadata and the operational clone retain this user index, but user authorization is checked after the artifact primary-key/project lookup and no user-history list exists. No measured fresh workload authorizes another index.",
      };
    }
  }
  if (familyEntry[0] === "state_storage_recovery"
    && table === "project_cloud_states" && row.kind === "unique") {
    return {
      ...base,
      finalClassification: "equivalent_duplicate_unique_enforcement",
      decisionGroup: "project_cloud_states.project_id.unique",
      evidence: section,
      rationale: "The one-cloud-state-per-project contract is enforced in every source; metadata/clone contain redundant explicit-index and one-to-one relation representations while fresh uses one named unique constraint. No additional enforcement is missing and no duplicate may be dropped without clone mutation proof.",
    };
  }
  if (knownName && predicateRepresentationGroups.has(knownName)) {
    return {
      ...base,
      finalClassification: "equivalent_predicate_representation",
      evidence: section,
      rationale: "The completed family audit proves one partial predicate contract; TypeORM IN/equality syntax and PostgreSQL cast/ANY syntax are representation differences for that frozen named object.",
    };
  }
  if (knownName && contradictoryIndexGroups.has(knownName)) {
    return {
      ...base,
      finalClassification: "equivalent_access_path",
      evidence: section,
      rationale: "The recreated data-bearing clone confirms one operational unpredicated btree on the same ordered nullable key. It is a sufficient superset for the committed non-null equality lookup served by the fresh/metadata partial form, so neither representation is missing and no duplicate index is authorized.",
    };
  }
  if (row.kind === "foreign_key") {
    if (sourcePresence.fresh && sourcePresence.clone) {
      return {
        ...base,
        finalClassification: "migration_authoritative_database_only",
        evidence: section,
        rationale: "Fresh and clone catalogs agree on ordered columns, target key, update/delete actions, match type and deferral; the completed audit intentionally keeps this relationship database-only for bounded DataSource compatibility.",
      };
    }
    const relationship = `${table}.${String(semantic.sourceColumns?.[0] ?? "")}`;
    if (guardedForeignKeys.has(relationship)
      && sourcePresence.fresh && !sourcePresence.clone && !sourcePresence.metadata) {
      return {
        ...base,
        finalClassification: "genuinely_missing_guarded_migration",
        requiresSchemaChange: true,
        evidence: section,
        rationale: relationship === terraformLockHistoryRelationship
          ? "The explicit retention decision preserves released Terraform-lock rows, clears only orphaned pipeline references, makes the historical reference nullable and restores it as ON DELETE SET NULL. Guarded additive migration 1760000059000 validates exact types, released status, target-key identity and zero remaining orphans before atomic FK validation."
          : `A newly recreated data-bearing clone confirms this migration-authoritative key is operationally absent while source/target types match, the target key is unique and orphan count is zero. Guarded additive migration ${guardedMigrationFor(relationship)} restores it with bounded locking, NOT VALID and atomic validation.`,
      };
    }
    if (table === "project_terraform_locks"
      && semantic.sourceColumns?.[0] === "pipeline_run_id"
      && sourcePresence.fresh && !sourcePresence.clone && !sourcePresence.metadata) {
      return {
        ...base,
        finalClassification: "unresolved_retained_history_orphans",
        evidence: section,
        rationale: "The recreated clone has two released historical Terraform-lock rows whose pipeline runs no longer exist. Adding the historical CASCADE key would require an explicit retention/data-repair decision, so this relationship remains fail-closed and is excluded from migration 1760000057000.",
      };
    }
    return {
      ...base,
      finalClassification: "unresolved_catalog_contradiction",
      evidence: section,
      rationale: "The relationship appears in only one PostgreSQL catalog despite a completed-family ownership decision; fresh/clone drift must be explained before any additive migration or metadata change.",
    };
  }
  if (knownName && databaseOnlyLookupGroups.has(knownName)) {
    return {
      ...base,
      finalClassification: "intentionally_database_only",
      evidence: section,
      rationale: "The completed family audit ties this exact ordered lookup to immutable replay, event ordering or current-state workload and preserves it without forcing metadata normalization.",
    };
  }
  if (knownName && redundantPreparationProjectIndexes.has(knownName)) {
    return {
      ...base,
      finalClassification: "equivalent_access_path",
      evidence: section,
      rationale: "The completed preparation audit proves the one-project unique key already supplies this leading-key lookup; the clone/metadata index is retained compatibility, not a missing fresh access path.",
    };
  }
  return {
    ...base,
    finalClassification: "unresolved_catalog_contradiction",
    evidence: section,
    rationale: "This corrected residual row was not represented by a sufficiently exact object-level decision in the completed family audit.",
  };
}

function csv(rows: ClassifiedRow[]): string {
  const columns = [
    "semantic_id", "table", "kind", "generated_classification", "family",
    "final_classification", "decision_group", "metadata", "fresh", "clone",
    "requires_schema_change", "evidence", "rationale",
  ];
  const lines = rows.map((row) => [
    row.semanticId,
    row.table,
    row.kind,
    row.generatedClassification,
    row.family,
    row.finalClassification,
    row.decisionGroup,
    row.sourcePresence.metadata,
    row.sourcePresence.fresh,
    row.sourcePresence.clone,
    row.requiresSchemaChange,
    row.evidence,
    row.rationale,
  ].map((value) => JSON.stringify(value)).join(","));
  return `${columns.join(",")}\n${lines.join("\n")}\n`;
}

function main() {
  const reconciliation = JSON.parse(readFileSync(inputPath, "utf8"));
  const residual: Raw[] = reconciliation.rows
    .filter((row: Raw) => row.classification !== "equivalent");
  const rows: ClassifiedRow[] = residual.map(classifyRow)
    .sort((a: ClassifiedRow, b: ClassifiedRow) => a.semanticId.localeCompare(b.semanticId));
  if (rows.length !== residual.length
    || new Set(rows.map((row: ClassifiedRow) => row.semanticId)).size !== rows.length) {
    throw new Error("COMPLETED_SCHEMA_FAMILY_CLASSIFICATION_COVERAGE_INVALID");
  }
  const classifications = rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.finalClassification] = (counts[row.finalClassification] ?? 0) + 1;
    return counts;
  }, {});
  const summary = {
    inputResidualRows: residual.length,
    classifiedFromAuditedFamilies: rows.filter((row: ClassifiedRow) =>
      row.family
      && row.finalClassification !== "unresolved_catalog_contradiction"
      && row.finalClassification !== "unresolved_retained_history_orphans"
      && row.finalClassification !== "unresolved_requires_clone_verification").length,
    auditedFamilyContradictions: rows.filter((row: ClassifiedRow) =>
      row.finalClassification === "unresolved_catalog_contradiction").length,
    unresolvedEvidenceBlockers: rows.filter((row: ClassifiedRow) =>
      row.finalClassification === "unresolved_retained_history_orphans"
      || row.finalClassification === "unresolved_requires_clone_verification").length,
    pendingFamilyAudit: rows.filter((row: ClassifiedRow) =>
      row.finalClassification === "pending_family_audit").length,
    schemaChangesAuthorized: rows.filter((row: ClassifiedRow) =>
      row.requiresSchemaChange).length,
    classifications,
  };
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
  writeFileSync(csvPath, csv(rows));
  process.stdout.write(`COMPLETED_SCHEMA_FAMILY_CLASSIFICATION_OK ${JSON.stringify(summary)}\n`);
}

if (require.main === module) main();
