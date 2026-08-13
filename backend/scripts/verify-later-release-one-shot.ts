import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { ConfigService } from "@nestjs/config";
import {
  hasCompatibleStableServiceIdentity,
  LaterReleaseOneShotRunnerService,
} from "../src/orchestration-contracts/release-lane/later-release-one-shot-runner.service";

const noDatabase = { query: () => { throw new Error("DATABASE_MUST_NOT_BE_READ_WHEN_DISABLED"); } } as any;
const noComposition = { getInactiveComposition: () => { throw new Error("COMPOSITION_MUST_NOT_BE_READ_WHEN_DISABLED"); } } as any;
const noOwnership = {} as any;
const noCapabilities = { startHeartbeatSession: () => { throw new Error("CAPABILITY_MUST_NOT_REGISTER_WHEN_DISABLED"); } } as any;

void (async () => {
  const runner = new LaterReleaseOneShotRunnerService(
    new ConfigService({}), noDatabase, noComposition, noOwnership, noCapabilities,
  );
  assert.deepEqual(await runner.readiness("00000000-0000-4000-8000-000000000001"), {
    state: "blocked", safeCodes: ["LATER_RELEASE_ONE_SHOT_DISABLED"],
  });
  assert.equal(hasCompatibleStableServiceIdentity({
    stableServiceArn: "arn:aws:ecs:us-east-1:123456789012:service/project/service",
    infrastructureServiceArn: null,
    clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/project",
  }), true, "first-release foundations may rely on the stable release service identity");
  assert.equal(hasCompatibleStableServiceIdentity({
    stableServiceArn: "arn:aws:ecs:us-east-1:123456789012:service/project/service-a",
    infrastructureServiceArn: "arn:aws:ecs:us-east-1:123456789012:service/project/service-b",
    clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/project",
  }), false, "infrastructure-owned services must still match exactly");
  const source = readFileSync(
    "src/orchestration-contracts/release-lane/later-release-one-shot-runner.service.ts",
    "utf8",
  );
  for (const forbidden of ["CreateServiceCommand", "UpdateServiceCommand", "RegisterTaskDefinitionCommand", "terraform apply", "terraform destroy"]) {
    assert.equal(source.includes(forbidden), false, `runner directly contains ${forbidden}`);
  }
  assert.match(source, /acquireV1/);
  assert.match(source, /startHeartbeatSession/);
  assert.match(source, /SET status = 'enqueued'/);
  assert.match(source, /resume_for_outcome_reconciliation/);
  assert.match(source, /effect\.status <> 'succeeded'/);
  assert.match(source, /invokeRelease/);
  assert.match(source, /releaseV1/);
  console.log("Later-release one-shot default-off verification passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
