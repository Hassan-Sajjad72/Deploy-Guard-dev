import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InactiveV1ShadowInsertionAdapter } from "../src/orchestration-contracts/release-lane/inactive-v1-shadow-insertion.adapter";
import { ReleaseLaneShadowObservationInput } from "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.types";

const projectId = "11111111-1111-4111-8111-111111111111";
const intentId = "22222222-2222-4222-8222-222222222222";
const observed: ReleaseLaneShadowObservationInput[] = [];
const adapter = new InactiveV1ShadowInsertionAdapter({
  observe: async (input) => {
    observed.push(input);
    return { enabled: false };
  },
} as never);
const settle = () => new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

async function main() {
  adapter.observePlanner({ projectId, environmentName: "qa", intentId, classification: "release_only" });
  adapter.observePlanner({ projectId, environmentName: "qa", intentId: "33333333-3333-4333-8333-333333333333", classification: "infrastructure_change" });
  adapter.observePlanner({ projectId, environmentName: "qa", intentId: "44444444-4444-4444-8444-444444444444", classification: "unsafe_or_unknown" });
  adapter.observePlanner({ projectId, environmentName: "qa", intentId: "55555555-5555-4555-8555-555555555555", classification: "no_op" });
  adapter.observeDispatch({ projectId, environmentName: "qa", intentId, deterministicJobId: "dg:v1:release:22222222-2222-4222-8222-222222222222:execute:1", lane: "release" });
  adapter.observeConsumerClaim({ projectId, environmentName: "qa", intentId, deterministicJobId: "dg:v1:infrastructure:22222222-2222-4222-8222-222222222222:apply:1", lane: "infrastructure" });
  await settle();
  assert.deepEqual(observed.map((item) => [item.operationClass, item.insertionSource]), [
    ["v1_plan_release", "transactional_deployment_planner.plan"],
    ["v1_plan_infrastructure", "transactional_deployment_planner.plan"],
    ["v1_plan_unsafe_or_unknown", "transactional_deployment_planner.plan"],
    ["v1_plan_no_op", "transactional_deployment_planner.plan"],
    ["v1_dispatch_release", "durable_outbox_dispatcher.dispatch_one"],
    ["v1_consumer_claim_infrastructure", "inactive_v1_bullmq_consumer.process_job"],
  ]);
  assert.equal(observed.every((item) => item.proposedLane === "v1" && item.projectId === projectId && item.environmentName === "qa"), true);

  const isolated = new InactiveV1ShadowInsertionAdapter({ observe: async () => { throw new Error("observer unavailable"); } } as never);
  isolated.observePlanner({ projectId, environmentName: "qa", intentId, classification: "release_only" });
  const synchronouslyFailing = new InactiveV1ShadowInsertionAdapter({ observe: () => { throw new Error("observer unavailable synchronously"); } } as never);
  synchronouslyFailing.observePlanner({ projectId, environmentName: "qa", intentId, classification: "release_only" });
  const timingOut = new InactiveV1ShadowInsertionAdapter({ observe: () => new Promise(() => undefined) } as never);
  timingOut.observePlanner({ projectId, environmentName: "qa", intentId, classification: "release_only" });
  await settle();

  const adapterSource = readFileSync(resolve(__dirname,
    "../src/orchestration-contracts/release-lane/inactive-v1-shadow-insertion.adapter.ts"), "utf8");
  const plannerSource = readFileSync(resolve(__dirname,
    "../src/orchestration-contracts/planner/transactional-deployment-planner.service.ts"), "utf8");
  const dispatcherSource = readFileSync(resolve(__dirname,
    "../src/orchestration-contracts/outbox/durable-outbox-dispatcher.service.ts"), "utf8");
  const consumerSource = readFileSync(resolve(__dirname,
    "../src/orchestration-contracts/worker-runtime/inactive-v1-bullmq-consumer.service.ts"), "utf8");
  assert.equal(/InactiveReleaseLaneOwnershipService|InactiveReleaseLaneCorrelationService|\.acquire\(|\.renew\(|\.release\(/.test(adapterSource), false);
  assert.equal(/queue\.add|from ["']@aws-sdk|terraform|docker/i.test(adapterSource), false);
  assert.match(plannerSource, /this\.shadowInsertion\?\.observePlanner/);
  assert.match(dispatcherSource, /this\.shadowInsertion\?\.observeDispatch/);
  assert.match(consumerSource, /this\.shadowInsertion\?\.observeConsumerClaim/);
  assert.ok(plannerSource.indexOf("this.shadowInsertion?.observePlanner") > plannerSource.indexOf("this.dataSource.transaction"));
  assert.ok(dispatcherSource.indexOf("this.shadowInsertion?.observeDispatch") < dispatcherSource.indexOf("this.publisher.publish"));
  assert.ok(consumerSource.indexOf("this.shadowInsertion?.observeConsumerClaim") < consumerSource.indexOf("this.invocation.invoke"));
  console.log("Inactive v1 shadow insertion verification passed");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
