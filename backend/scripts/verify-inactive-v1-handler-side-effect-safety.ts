import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryRunner } from "typeorm";
import { CreateDeploymentSideEffectJournal1760000039000 } from "../src/migrations/1760000039000-CreateDeploymentSideEffectJournal";
import {
  canonicalizeV1HandlerSideEffectIdentity,
  validateV1HandlerSideEffectOutcome,
  v1HandlerSideEffectRequestFingerprint,
} from "../src/orchestration-contracts/worker-runtime/v1-handler-side-effect.pure";

const identity = {
  intentId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  environmentName: "production",
  operationId: "33333333-3333-4333-8333-333333333333",
  idempotencyKey: createHash("sha256").update("effect-key").digest("hex"),
  effectType: "release.task_definition.register",
  inputFingerprint: createHash("sha256").update("input-v1").digest("hex"),
  leaseId: "44444444-4444-4444-8444-444444444444",
  workerId: "session6.6-release-worker",
  fencingToken: "19",
};

assert.deepEqual(
  canonicalizeV1HandlerSideEffectIdentity(identity),
  identity,
);
assert.equal(
  v1HandlerSideEffectRequestFingerprint(identity),
  v1HandlerSideEffectRequestFingerprint({ ...identity }),
);
assert.notEqual(
  v1HandlerSideEffectRequestFingerprint(identity),
  v1HandlerSideEffectRequestFingerprint({
    ...identity,
    inputFingerprint: createHash("sha256").update("input-v2").digest("hex"),
  }),
);
for (const invalid of [
  { ...identity, operationId: "not-a-uuid" },
  { ...identity, idempotencyKey: "not-a-hash" },
  { ...identity, effectType: "AWS SECRET" },
  { ...identity, fencingToken: "0" },
]) {
  assert.throws(
    () => canonicalizeV1HandlerSideEffectIdentity(invalid),
    /SIDE_EFFECT_CONTRACT_INVALID/,
  );
}

const success = {
  outcome: "succeeded" as const,
  safeResultCode: "TASK_DEFINITION_REGISTERED",
  resultFingerprint: createHash("sha256").update("result").digest("hex"),
  externalReferenceHash: createHash("sha256").update("reference").digest("hex"),
};
assert.deepEqual(validateV1HandlerSideEffectOutcome(success), success);
for (const invalid of [
  { ...success, rawPayload: { password: "must-not-be-accepted" } },
  { ...success, externalReferenceHash: "arn:raw:resource" },
  { outcome: "failed", safeFailureCode: "raw sdk error!" },
  { outcome: "unknown" },
]) {
  assert.throws(
    () => validateV1HandlerSideEffectOutcome(invalid),
    /SIDE_EFFECT_CONTRACT_INVALID|Ownership failure code is invalid/,
  );
}

const statements: string[] = [];
const runner = {
  query: async (sql: string) => {
    statements.push(sql);
    return undefined;
  },
} as unknown as QueryRunner;
const migration = new CreateDeploymentSideEffectJournal1760000039000();

async function run() {
  await migration.up(runner);
  const sql = statements.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "deployment_side_effects"/);
  assert.match(sql, /UQ_deployment_side_effect_idempotency/);
  assert.match(sql, /IDX_deployment_side_effect_reconciliation/);
  assert.doesNotMatch(sql, /\bCREATE\s+TYPE\b/i);
  assert.doesNotMatch(
    sql,
    /terraform\s+(apply|destroy)|aws-sdk|queue\.add|BullMQ/i,
  );

  const root = join(__dirname, "..");
  const service = readFileSync(
    join(
      root,
      "src/orchestration-contracts/worker-runtime/"
        + "inactive-v1-handler-side-effect-safety.service.ts",
    ),
    "utf8",
  );
  const invocation = readFileSync(
    join(
      root,
      "src/orchestration-contracts/worker-runtime/"
        + "inactive-v1-fenced-invocation.service.ts",
    ),
    "utf8",
  );
  const placeholders = readFileSync(
    join(
      root,
      "src/orchestration-contracts/worker-runtime/"
        + "v1-placeholder-handlers.ts",
    ),
    "utf8",
  );
  assert.match(service, /fence\.signal\.aborted[\s\S]*isLeaseTrusted/);
  assert.match(service, /lease\.fencing_token = \$3::bigint/);
  assert.match(service, /status = 'uncertain'/);
  assert.match(invocation, /sideEffects: this\.sideEffectSafety\.forExecution/);
  assert.match(invocation, /sideEffects\.finalizationStatus\(\)/);
  assert.doesNotMatch(
    service,
    /@aws-sdk|Terraform|ECS|Docker|child_process|createRedisConnection/,
  );
  assert.doesNotMatch(placeholders, /\.sideEffects\.execute\(/);
  console.log(
    "Inactive v1 handler side-effect safety contract verification passed",
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
