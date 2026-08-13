import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";
import {
  assertPreExecutionLeaseTtl,
  assertSafeOwnershipFailureCode,
  preExecutionOperationForEnvelope,
  preExecutionOperationsConflict,
} from "../src/orchestration-contracts/worker-runtime/v1-pre-execution-ownership.pure";

function envelope(
  messageType: DeployGuardWorkerEnvelopeV1["protocol"]["messageType"],
  lane: DeployGuardWorkerEnvelopeV1["routing"]["lane"],
  operation: DeployGuardWorkerEnvelopeV1["routing"]["operation"],
) {
  return {
    protocol: { messageType },
    routing: { lane, operation },
  } as DeployGuardWorkerEnvelopeV1;
}

assert.deepEqual(
  preExecutionOperationForEnvelope(
    envelope("intent.release.execute", "release", "execute"),
  ),
  { lane: "release", scope: "execute" },
);
assert.deepEqual(
  preExecutionOperationForEnvelope(
    envelope("intent.infrastructure.plan", "infrastructure", "plan"),
  ),
  { lane: "infrastructure", scope: "plan" },
);
assert.deepEqual(
  preExecutionOperationForEnvelope(
    envelope("intent.infrastructure.apply", "infrastructure", "apply"),
  ),
  { lane: "infrastructure", scope: "apply" },
);
assert.deepEqual(
  preExecutionOperationForEnvelope(
    envelope("intent.deletion.execute", "deletion", "destroy"),
  ),
  { lane: "deletion", scope: "destroy" },
);
assert.throws(
  () => preExecutionOperationForEnvelope(
    envelope("intent.release.execute", "release", "apply"),
  ),
  /no frozen pre-execution operation/,
);
assert.throws(
  () => preExecutionOperationForEnvelope(
    envelope("outbox.reconcile", "release", "execute"),
  ),
  /no frozen pre-execution operation/,
);

const release = { lane: "release", scope: "execute" } as const;
const plan = { lane: "infrastructure", scope: "plan" } as const;
const apply = { lane: "infrastructure", scope: "apply" } as const;
const deletion = { lane: "deletion", scope: "destroy" } as const;
assert.equal(preExecutionOperationsConflict(release, release), true);
assert.equal(preExecutionOperationsConflict(plan, plan), true);
assert.equal(preExecutionOperationsConflict(apply, apply), true);
assert.equal(preExecutionOperationsConflict(deletion, deletion), true);
assert.equal(preExecutionOperationsConflict(release, plan), false);
assert.equal(preExecutionOperationsConflict(plan, release), false);
assert.equal(preExecutionOperationsConflict(release, apply), true);
assert.equal(preExecutionOperationsConflict(apply, release), true);
assert.equal(preExecutionOperationsConflict(plan, apply), true);
assert.equal(preExecutionOperationsConflict(apply, plan), true);
for (const operation of [release, plan, apply]) {
  assert.equal(preExecutionOperationsConflict(deletion, operation), true);
  assert.equal(preExecutionOperationsConflict(operation, deletion), true);
}

assert.equal(assertPreExecutionLeaseTtl(1_000), 1_000);
assert.equal(assertPreExecutionLeaseTtl(900_000), 900_000);
assert.throws(() => assertPreExecutionLeaseTtl(999), /TTL is invalid/);
assert.throws(() => assertPreExecutionLeaseTtl(900_001), /TTL is invalid/);
assert.throws(() => assertPreExecutionLeaseTtl(1_000.5), /TTL is invalid/);
assert.equal(
  assertSafeOwnershipFailureCode("EXECUTION_FAILED"),
  "EXECUTION_FAILED",
);
for (const code of ["raw error", "aws:key", "x", "PASSWORD=secret"]) {
  assert.throws(
    () => assertSafeOwnershipFailureCode(code),
    /failure code is invalid/,
  );
}

const runtimeRoot = join(
  process.cwd(),
  "src",
  "orchestration-contracts",
  "worker-runtime",
);
const ownershipSource = readFileSync(
  join(runtimeRoot, "inactive-v1-pre-execution-ownership.service.ts"),
  "utf8",
);
const moduleSource = readFileSync(
  join(
    process.cwd(),
    "src",
    "orchestration-contracts",
    "orchestration-contracts.module.ts",
  ),
  "utf8",
);
for (const source of [ownershipSource, moduleSource]) {
  assert.doesNotMatch(source, /\bnew\s+Worker\s*\(/);
  assert.doesNotMatch(
    source,
    /OnModuleInit|OnApplicationBootstrap|@Cron|ScheduleModule/,
  );
}
assert.doesNotMatch(
  ownershipSource,
  /from ["'][^"']*(terraform|ecs|aws|docker|pipeline-worker|pipeline\.worker)/i,
);

console.log("Inactive v1 pre-execution ownership pure verification passed");
