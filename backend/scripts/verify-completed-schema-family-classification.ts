import { strict as assert } from "node:assert";
import { classifyRow } from "./classify-completed-schema-families";
import { OPERATIONAL_OWNERSHIP_FOREIGN_KEYS } from "../src/migrations/1760000057000-ReconcileOperationalOwnershipForeignKeys";
import {
  VERIFIED_LIFECYCLE_FOREIGN_KEYS,
  VERIFIED_PROJECT_IDENTITY_INDEXES,
} from "../src/migrations/1760000058000-ReconcileVerifiedLifecycleIntegrity";
import { TERRAFORM_LOCK_PIPELINE_HISTORY_FOREIGN_KEY } from "../src/migrations/1760000059000-PreserveReleasedTerraformLockHistory";

assert.equal(OPERATIONAL_OWNERSHIP_FOREIGN_KEYS.length, 20);
assert.equal(
  new Set(OPERATIONAL_OWNERSHIP_FOREIGN_KEYS.map((spec) => spec.constraintName)).size,
  OPERATIONAL_OWNERSHIP_FOREIGN_KEYS.length,
);
assert.equal(VERIFIED_LIFECYCLE_FOREIGN_KEYS.length, 6);
assert.equal(VERIFIED_PROJECT_IDENTITY_INDEXES.length, 2);
assert.equal(
  new Set(VERIFIED_LIFECYCLE_FOREIGN_KEYS.map((spec) => spec.constraintName)).size,
  VERIFIED_LIFECYCLE_FOREIGN_KEYS.length,
);
assert.equal(
  new Set(VERIFIED_PROJECT_IDENTITY_INDEXES.map((spec) => spec.indexName)).size,
  VERIFIED_PROJECT_IDENTITY_INDEXES.length,
);
assert.equal(
  OPERATIONAL_OWNERSHIP_FOREIGN_KEYS.some((spec) =>
    spec.tableName === "project_terraform_locks"
    && spec.columnName === "pipeline_run_id"),
  false,
  "released orphan lock history must remain outside the guarded migration",
);
assert.equal(TERRAFORM_LOCK_PIPELINE_HISTORY_FOREIGN_KEY.onDelete, "SET NULL");

function row(overrides: Record<string, any>) {
  return {
    semanticId: JSON.stringify({
      kind: overrides.kind ?? "foreign_key",
      table: overrides.table,
      sourceColumns: overrides.sourceColumns ?? ["project_id"],
      keyItems: overrides.keyItems,
      predicate: overrides.predicate,
      unique: overrides.unique,
    }),
    kind: overrides.kind ?? "foreign_key",
    classification: overrides.generated ?? "database_only",
    metadata: overrides.metadata ?? [],
    fresh: overrides.fresh ?? [],
    clone: overrides.clone ?? [],
  };
}

const sharedFk = classifyRow(row({
  table: "deployment_intents",
  fresh: [{ name: "FK_deployment_intents_project" }],
  clone: [{ name: "FK_deployment_intents_project" }],
}));
assert.equal(sharedFk.finalClassification, "migration_authoritative_database_only");
assert.equal(sharedFk.requiresSchemaChange, false);

const driftedFk = classifyRow(row({
  table: "project_infrastructure_environments",
  sourceColumns: ["desired_manifest_id"],
  fresh: [{ name: "FK_infrastructure_environments_desired_manifest" }],
}));
assert.equal(driftedFk.finalClassification, "genuinely_missing_guarded_migration");
assert.equal(driftedFk.requiresSchemaChange, true);

const predicateEquivalent = classifyRow(row({
  table: "orchestration_outbox",
  kind: "index",
  metadata: [{ name: "IDX_orchestration_outbox_dispatch" }],
}));
assert.equal(
  predicateEquivalent.finalClassification,
  "equivalent_predicate_representation",
);

const predicateConflict = classifyRow(row({
  table: "project_release_lane_ownerships",
  kind: "index",
  fresh: [{ name: "IDX_release_lane_ownership_deployment_intent" }],
  clone: [{ name: "IDX_release_lane_ownership_deployment_intent" }],
}));
assert.equal(predicateConflict.finalClassification, "equivalent_access_path");

const outside = classifyRow(row({
  table: "not_yet_audited_table",
  kind: "index",
  clone: [{ name: "IDX_export_artifacts_project" }],
}));
assert.equal(outside.finalClassification, "pending_family_audit");

const storageFk = classifyRow(row({
  table: "project_storage_restore_requests",
  sourceColumns: ["project_id"],
  fresh: [{ name: "FK_restore_requests_project" }],
}));
assert.equal(
  storageFk.finalClassification,
  "genuinely_missing_guarded_migration",
);
assert.equal(storageFk.requiresSchemaChange, true);

const retainedLockHistory = classifyRow(row({
  table: "project_terraform_locks",
  sourceColumns: ["pipeline_run_id"],
  fresh: [{ name: "FK_project_terraform_locks_pipeline_run" }],
}));
assert.equal(
  retainedLockHistory.finalClassification,
  "genuinely_missing_guarded_migration",
);
assert.equal(retainedLockHistory.requiresSchemaChange, true);

const rollbackIndex = classifyRow(row({
  table: "project_rollback_records",
  kind: "index",
  fresh: [{ name: "IDX_rollback_records_cross_lane_ownership" }],
}));
assert.equal(
  rollbackIndex.finalClassification,
  "equivalent_access_path",
);

const cloudStateUnique = classifyRow(row({
  table: "project_cloud_states",
  kind: "unique",
  generated: "ambiguous",
  metadata: [{ name: "IDX_project_cloud_state" }, { name: "REL_project_cloud_state" }],
  fresh: [{ name: "UQ_project_cloud_states_project" }],
  clone: [{ name: "IDX_project_cloud_state" }, { name: "REL_project_cloud_state" }],
}));
assert.equal(
  cloudStateUnique.finalClassification,
  "equivalent_duplicate_unique_enforcement",
);

const destroyLineageFk = classifyRow(row({
  table: "infrastructure_destroy_operations",
  sourceColumns: ["deployment_intent_id"],
  fresh: [{ name: "FK_destroy_operations_deployment_intent" }],
}));
assert.equal(
  destroyLineageFk.finalClassification,
  "genuinely_missing_guarded_migration",
);
assert.equal(destroyLineageFk.requiresSchemaChange, true);

const activeProjectIdentity = classifyRow(row({
  table: "projects",
  kind: "unique",
  sourceColumns: undefined,
  keyItems: ["owner_user_id", "github_repository_id", "target_branch", "environment_name"],
  predicate: "github_repository_id IS NOT NULL AND archived_at IS NULL",
  unique: true,
  fresh: [{ name: "UQ_active_project_github_branch_environment" }],
}));
assert.equal(
  activeProjectIdentity.finalClassification,
  "genuinely_missing_guarded_migration",
);
assert.equal(activeProjectIdentity.requiresSchemaChange, true);

const orderedDestroyLookup = classifyRow(row({
  table: "infrastructure_destroy_operations",
  kind: "index",
  keyItems: ["project_id", "created_at"],
  fresh: [{ name: "idx_destroy_operations_project" }],
}));
assert.equal(orderedDestroyLookup.finalClassification, "intentionally_database_only");

const redundantDestroyProjectLookup = classifyRow(row({
  table: "infrastructure_destroy_operations",
  kind: "index",
  keyItems: ["project_id"],
  metadata: [{ name: "IDX_2498aa384e716e58d2265ae174" }],
  clone: [{ name: "IDX_2498aa384e716e58d2265ae174" }],
}));
assert.equal(redundantDestroyProjectLookup.finalClassification, "equivalent_access_path");

const challengeCompatibilityLookup = classifyRow(row({
  table: "infrastructure_destroy_challenges",
  kind: "index",
  keyItems: ["user_id"],
  metadata: [{ name: "IDX_c8210915d3f66654ed97c99ac0" }],
  clone: [{ name: "IDX_c8210915d3f66654ed97c99ac0" }],
}));
assert.equal(
  challengeCompatibilityLookup.finalClassification,
  "intentionally_metadata_only_compatibility",
);

const orderedAiMessages = classifyRow(row({
  table: "ai_analysis_messages",
  kind: "index",
  keyItems: ["session_id", "created_at"],
  fresh: [{ name: "idx_ai_messages_session" }],
}));
assert.equal(orderedAiMessages.finalClassification, "intentionally_database_only");

const redundantAiResultsSession = classifyRow(row({
  table: "ai_analysis_results",
  kind: "index",
  keyItems: ["session_id"],
  metadata: [{ name: "IDX_836061cffc69b212c8ea7cf459" }],
  clone: [{ name: "IDX_836061cffc69b212c8ea7cf459" }],
}));
assert.equal(redundantAiResultsSession.finalClassification, "equivalent_access_path");

const aiUserRateCompatibility = classifyRow(row({
  table: "ai_analysis_sessions",
  kind: "index",
  keyItems: ["user_id"],
  metadata: [{ name: "IDX_5d0e4233ad8cf272b135096d39" }],
  clone: [{ name: "IDX_5d0e4233ad8cf272b135096d39" }],
}));
assert.equal(
  aiUserRateCompatibility.finalClassification,
  "intentionally_metadata_only_compatibility",
);

const aiPipelineCompatibility = classifyRow(row({
  table: "ai_analysis_sessions",
  kind: "index",
  keyItems: ["pipeline_run_id"],
  metadata: [{ name: "IDX_7211c9396b88899759e445380f" }],
  clone: [{ name: "IDX_7211c9396b88899759e445380f" }],
}));
assert.equal(
  aiPipelineCompatibility.finalClassification,
  "intentionally_metadata_only_compatibility",
);

const orderedNotificationHistory = classifyRow(row({
  table: "notification_deliveries",
  kind: "index",
  keyItems: ["project_id", "created_at"],
  fresh: [{ name: "idx_notification_deliveries_project" }],
}));
assert.equal(
  orderedNotificationHistory.finalClassification,
  "intentionally_database_only",
);

const redundantNotificationProject = classifyRow(row({
  table: "notification_deliveries",
  kind: "index",
  keyItems: ["project_id"],
  metadata: [{ name: "IDX_a9c405b7139586ccc14de763f4" }],
  clone: [{ name: "IDX_a9c405b7139586ccc14de763f4" }],
}));
assert.equal(redundantNotificationProject.finalClassification, "equivalent_access_path");

const preferenceUniqueSupport = classifyRow(row({
  table: "notification_preferences",
  kind: "index",
  keyItems: ["user_id"],
  metadata: [{ name: "IDX_64c90edc7310c6be7c10c96f67" }],
  clone: [{ name: "IDX_64c90edc7310c6be7c10c96f67" }],
}));
assert.equal(preferenceUniqueSupport.finalClassification, "equivalent_access_path");

const deliveryUserCompatibility = classifyRow(row({
  table: "notification_deliveries",
  kind: "index",
  keyItems: ["user_id"],
  metadata: [{ name: "IDX_9fcd0b72070848cc484af6bc1e" }],
  clone: [{ name: "IDX_9fcd0b72070848cc484af6bc1e" }],
}));
assert.equal(
  deliveryUserCompatibility.finalClassification,
  "intentionally_metadata_only_compatibility",
);

const finopsReviewerLineage = classifyRow(row({
  table: "project_cost_estimates",
  sourceColumns: ["approved_by_user_id"],
  fresh: [{ name: "FK_project_cost_estimates_approved_by_user" }],
}));
assert.equal(
  finopsReviewerLineage.finalClassification,
  "genuinely_missing_guarded_migration",
);
assert.equal(finopsReviewerLineage.requiresSchemaChange, true);

const orderedUsageLedger = classifyRow(row({
  table: "billing_usage_events",
  kind: "index",
  keyItems: ["user_id", "created_at"],
  fresh: [{ name: "idx_usage_events_user" }],
}));
assert.equal(orderedUsageLedger.finalClassification, "intentionally_database_only");

const usageCounterUniqueSupport = classifyRow(row({
  table: "billing_usage_counters",
  kind: "index",
  keyItems: ["user_id"],
  metadata: [{ name: "IDX_00611824e5cc16755e8e25c3ed" }],
  clone: [{ name: "IDX_00611824e5cc16755e8e25c3ed" }],
}));
assert.equal(usageCounterUniqueSupport.finalClassification, "equivalent_access_path");

const invoiceHistoryCompatibility = classifyRow(row({
  table: "billing_invoices",
  kind: "index",
  keyItems: ["user_id"],
  metadata: [{ name: "IDX_29e10ff04337ef730f2b7af58b" }],
  clone: [{ name: "IDX_29e10ff04337ef730f2b7af58b" }],
}));
assert.equal(
  invoiceHistoryCompatibility.finalClassification,
  "intentionally_metadata_only_compatibility",
);

const orderedMeaningfulActivity = classifyRow(row({
  table: "project_user_activity",
  kind: "index",
  keyItems: ["user_id", "last_meaningful_activity_at"],
  fresh: [{ name: "IDX_project_user_activity_user_meaningful" }],
}));
assert.equal(orderedMeaningfulActivity.finalClassification, "intentionally_database_only");

const redundantActivityUser = classifyRow(row({
  table: "project_user_activity",
  kind: "index",
  keyItems: ["user_id"],
  metadata: [{ name: "IDX_9dbc35b2f889ce2f191b3729b0" }],
  clone: [{ name: "IDX_9dbc35b2f889ce2f191b3729b0" }],
}));
assert.equal(redundantActivityUser.finalClassification, "equivalent_access_path");

const activityProjectCompatibility = classifyRow(row({
  table: "project_user_activity",
  kind: "index",
  keyItems: ["project_id"],
  metadata: [{ name: "IDX_d74bd0ba4ab17420cc76194ba8" }],
  clone: [{ name: "IDX_d74bd0ba4ab17420cc76194ba8" }],
}));
assert.equal(
  activityProjectCompatibility.finalClassification,
  "intentionally_metadata_only_compatibility",
);

const duplicateSnapshotRunLookup = classifyRow(row({
  table: "project_configuration_snapshots",
  kind: "index",
  keyItems: ["pipeline_run_id"],
  metadata: [{ name: "IDX_ef73ffbc215041567e229b1d2d" }],
  clone: [{ name: "IDX_ef73ffbc215041567e229b1d2d" }],
}));
assert.equal(duplicateSnapshotRunLookup.finalClassification, "equivalent_access_path");

const normalizedEnvironmentLookup = classifyRow(row({
  table: "project_environment_variables",
  kind: "index",
  keyItems: ["project_id", "normalized_key"],
  fresh: [{ name: "IDX_project_env_normalized_key" }],
}));
assert.equal(normalizedEnvironmentLookup.finalClassification, "intentionally_database_only");

const databaseTierUniqueness = classifyRow(row({
  table: "project_database_tiers",
  kind: "unique",
  keyItems: ["project_id"],
  metadata: [{ name: "IDX_84453f3b22eb36c14f6c6fd999" }, { name: "REL_84453f3b22eb36c14f6c6fd999" }],
  fresh: [{ name: "UQ_project_database_tiers_project" }],
  clone: [{ name: "IDX_84453f3b22eb36c14f6c6fd999" }, { name: "REL_84453f3b22eb36c14f6c6fd999" }, { name: "UQ_project_database_tiers_project" }],
}));
assert.equal(
  databaseTierUniqueness.finalClassification,
  "equivalent_duplicate_unique_enforcement",
);

const orchestrationProjectLineage = classifyRow(row({
  table: "project_orchestration_events",
  sourceColumns: ["project_id"],
  fresh: [{ name: "FK_orchestration_events_project" }],
}));
assert.equal(
  orchestrationProjectLineage.finalClassification,
  "genuinely_missing_guarded_migration",
);
assert.equal(orchestrationProjectLineage.requiresSchemaChange, true);

const orchestrationCanonicalOrder = classifyRow(row({
  table: "project_orchestration_events",
  kind: "index",
  keyItems: ["project_id", "pipeline_run_id", "occurred_at", "sequence_number"],
  fresh: [{ name: "IDX_project_orchestration_events_canonical_order" }],
}));
assert.equal(
  orchestrationCanonicalOrder.finalClassification,
  "intentionally_database_only",
);

const exportExpiry = classifyRow(row({
  table: "terraform_export_artifacts",
  kind: "index",
  keyItems: ["expires_at"],
  fresh: [{ name: "idx_export_artifacts_expiry" }],
}));
assert.equal(exportExpiry.finalClassification, "intentionally_database_only");

const exportProjectCompatibility = classifyRow(row({
  table: "terraform_export_artifacts",
  kind: "index",
  keyItems: ["project_id"],
  metadata: [{ name: "IDX_175ff7ff1248f7e7742c419755" }],
  clone: [{ name: "IDX_175ff7ff1248f7e7742c419755" }],
}));
assert.equal(
  exportProjectCompatibility.finalClassification,
  "intentionally_metadata_only_compatibility",
);

const exportUserCompatibility = classifyRow(row({
  table: "terraform_export_artifacts",
  kind: "index",
  keyItems: ["user_id"],
  metadata: [{ name: "IDX_613ee16571e92aa271d293466a" }],
  clone: [{ name: "IDX_613ee16571e92aa271d293466a" }],
}));
assert.equal(
  exportUserCompatibility.finalClassification,
  "intentionally_metadata_only_compatibility",
);

process.stdout.write("Completed schema-family classification verification passed.\n");
