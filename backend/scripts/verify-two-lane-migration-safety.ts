import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryRunner } from "typeorm";
import { CreateTwoLaneManifestsAndStateRevisions1760000034000 } from "../src/migrations/1760000034000-CreateTwoLaneManifestsAndStateRevisions";
import { CreateDeploymentIntentsOutboxAndOperationLeases1760000035000 } from "../src/migrations/1760000035000-CreateDeploymentIntentsOutboxAndOperationLeases";
import { LinkLegacyExecutionToTwoLaneContracts1760000036000 } from "../src/migrations/1760000036000-LinkLegacyExecutionToTwoLaneContracts";
import { CreateWorkerCapabilityRegistry1760000037000 } from "../src/migrations/1760000037000-CreateWorkerCapabilityRegistry";
import { CreateReleaseLaneOwnerships1760000043000 } from "../src/migrations/1760000043000-CreateReleaseLaneOwnerships";
import { AddReleaseLaneOwnershipCorrelation1760000044000 } from "../src/migrations/1760000044000-AddReleaseLaneOwnershipCorrelation";
import { CreateReleaseLaneShadowObservations1760000045000 } from "../src/migrations/1760000045000-CreateReleaseLaneShadowObservations";

const migrationFiles = [
  "1760000034000-CreateTwoLaneManifestsAndStateRevisions.ts",
  "1760000035000-CreateDeploymentIntentsOutboxAndOperationLeases.ts",
  "1760000036000-LinkLegacyExecutionToTwoLaneContracts.ts",
  "1760000037000-CreateWorkerCapabilityRegistry.ts",
  "1760000043000-CreateReleaseLaneOwnerships.ts",
  "1760000044000-AddReleaseLaneOwnershipCorrelation.ts",
  "1760000045000-CreateReleaseLaneShadowObservations.ts",
];
const sources = migrationFiles.map((file) =>
  readFileSync(resolve(__dirname, "../src/migrations", file), "utf8")
);
const combined = sources.join("\n");

assert.equal(/\bCREATE\s+TYPE\b/i.test(combined), false, "migrations must not create PostgreSQL enum types");
assert.equal(/\bUPDATE\b/i.test(combined), false, "migrations must not backfill legacy rows");
assert.equal(/\bINSERT\b/i.test(combined), false, "migrations must not seed orchestration rows");
assert.equal(/\bDELETE\s+FROM\b/i.test(combined), false, "migrations must not delete data");
assert.equal(/queue\.add|BullMQ|terraform\s+(apply|destroy)|aws-sdk/i.test(combined), false);
assert.match(combined, /canonical_idempotency_key/);
assert.match(combined, /request_fingerprint/);
assert.match(combined, /UQ_deployment_intent_idempotency/);
assert.match(combined, /IDX_release_manifest_fingerprints/);
assert.match(combined, /ADD COLUMN IF NOT EXISTS "release_manifest_id" uuid/);
assert.match(combined, /"infrastructure_manifest_id" uuid NOT NULL/);

const migrations = [
  new CreateTwoLaneManifestsAndStateRevisions1760000034000(),
  new CreateDeploymentIntentsOutboxAndOperationLeases1760000035000(),
  new LinkLegacyExecutionToTwoLaneContracts1760000036000(),
  new CreateWorkerCapabilityRegistry1760000037000(),
  new CreateReleaseLaneOwnerships1760000043000(),
  new AddReleaseLaneOwnershipCorrelation1760000044000(),
  new CreateReleaseLaneShadowObservations1760000045000(),
];
const upStatements: string[] = [];
const downStatements: string[] = [];
const upRunner = {
  query: async (sql: string) => {
    upStatements.push(sql);
    return undefined;
  },
} as unknown as QueryRunner;
const downRunner = {
  query: async (sql: string) => {
    downStatements.push(sql);
    return undefined;
  },
} as unknown as QueryRunner;

async function verify() {
  for (const migration of migrations) await migration.up(upRunner);
  for (const migration of [...migrations].reverse()) await migration.down(downRunner);

  const upSql = upStatements.join("\n");
  const downSql = downStatements.join("\n");
  for (const table of [
    "infrastructure_manifests",
    "release_manifests",
    "project_state_revisions",
    "deployment_intents",
    "orchestration_outbox",
    "project_operation_leases",
    "worker_capabilities",
    "project_release_lane_ownerships",
    "project_release_lane_shadow_observations",
  ]) {
    assert.match(upSql, new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`));
  }
  assert.match(upSql, /project_pipeline_runs" ADD COLUMN IF NOT EXISTS "deployment_intent_id" uuid/);
  assert.match(upSql, /project_deployments" ADD COLUMN IF NOT EXISTS "release_manifest_id" uuid/);
  assert.match(upSql, /project_pipeline_runs"\n        ADD COLUMN IF NOT EXISTS "cross_lane_ownership_id" uuid/);
  assert.match(upSql, /project_rollback_records"\n        ADD COLUMN IF NOT EXISTS "cross_lane_ownership_id" uuid/);
  assert.match(upSql, /project_stable_releases" ADD COLUMN IF NOT EXISTS "release_manifest_id" uuid/);
  assert.match(downSql, /Refusing to roll back/);
  assert.match(downSql, /DROP TABLE IF EXISTS "worker_capabilities"/);
  assert.equal(upStatements.some((sql) => /\bUPDATE\b|\bINSERT\b|\bDELETE\s+FROM\b/i.test(sql)), false);
  console.log("Two-lane migration static safety verification passed");
}

void verify();
