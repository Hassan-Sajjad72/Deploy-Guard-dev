import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InactiveLegacyShadowInsertionAdapter, LegacyWorkerShadowRoute } from "../src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter";
import { ReleaseLaneShadowObservationInput } from "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.types";

const projectId = "11111111-1111-4111-8111-111111111111";
const observed: ReleaseLaneShadowObservationInput[] = [];
const settle = () => new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
const routes: readonly LegacyWorkerShadowRoute[] = [
  "full_deploy", "stage_selective_resume", "cost_approval_resume", "apply_approval_resume",
  "state_lock_resume", "infrastructure_plan", "infrastructure_apply", "storage_provision",
];

async function main() {
  const adapter = new InactiveLegacyShadowInsertionAdapter({
    observe: async (input) => {
      observed.push(input);
      return { enabled: false };
    },
  } as never);
  for (const route of routes) {
    const input = { projectId, logicalOperationId: `job-${route}`, route };
    adapter.observeWorkerPickup(input);
    adapter.observeWorkerPreMutation(input);
  }
  adapter.observeWorkerPickup({ projectId, logicalOperationId: "job-redelivery", route: "full_deploy" });
  adapter.observeWorkerPickup({ projectId, logicalOperationId: "job-redelivery", route: "full_deploy" });
  adapter.observeWorkerPreMutation({ projectId, logicalOperationId: "job-redelivery", route: "full_deploy" });
  adapter.observeWorkerPreMutation({ projectId, logicalOperationId: "job-redelivery", route: "full_deploy" });
  await settle();

  assert.equal(observed.length, 20);
  assert.deepEqual(observed.slice(0, 16).map((item) => [item.operationClass, item.insertionSource]), [
    ["legacy_full_deployment_run", "pipeline_worker.full_deploy_pickup"], ["legacy_full_deployment_run", "pipeline_worker.full_deploy_pre_mutation"],
    ["legacy_stage_selective_resume", "pipeline_worker.stage_selective_resume_pickup"], ["legacy_stage_selective_resume", "pipeline_worker.stage_selective_resume_pre_mutation"],
    ["legacy_cost_approval_resume", "pipeline_worker.cost_approval_resume_pickup"], ["legacy_cost_approval_resume", "pipeline_worker.cost_approval_resume_pre_mutation"],
    ["legacy_apply_approval_resume", "pipeline_worker.apply_approval_resume_pickup"], ["legacy_apply_approval_resume", "pipeline_worker.apply_approval_resume_pre_mutation"],
    ["legacy_state_lock_resume", "pipeline_worker.state_lock_resume_pickup"], ["legacy_state_lock_resume", "pipeline_worker.state_lock_resume_pre_mutation"],
    ["legacy_infrastructure_plan", "pipeline_worker.infrastructure_plan_pickup"], ["legacy_infrastructure_plan", "pipeline_worker.infrastructure_plan_pre_mutation"],
    ["legacy_infrastructure_apply", "pipeline_worker.infrastructure_apply_pickup"], ["legacy_infrastructure_apply", "pipeline_worker.infrastructure_apply_pre_mutation"],
    ["legacy_storage_provision", "pipeline_worker.storage_provision_pickup"], ["legacy_storage_provision", "pipeline_worker.storage_provision_pre_mutation"],
  ]);
  assert.equal(observed.every((item) => item.projectId === projectId && item.environmentName === "dev" && item.proposedLane === "legacy"), true);
  assert.notEqual(observed[16].logicalOperationIdentity, observed[18].logicalOperationIdentity);
  assert.equal(observed[16].logicalOperationIdentity, observed[17].logicalOperationIdentity);
  assert.equal(observed[18].logicalOperationIdentity, observed[19].logicalOperationIdentity);
  assert.equal(observed.every((item) => !/secret|credential|actor|repository|payload|cloud/i.test(item.logicalOperationIdentity)), true);

  new InactiveLegacyShadowInsertionAdapter({ observe: async () => { throw new Error("disabled or unavailable"); } } as never)
    .observeWorkerPickup({ projectId, logicalOperationId: "failure-isolated", route: "full_deploy" });
  new InactiveLegacyShadowInsertionAdapter({ observe: () => { throw new Error("sync failure"); } } as never)
    .observeWorkerPreMutation({ projectId, logicalOperationId: "sync-failure-isolated", route: "full_deploy" });
  new InactiveLegacyShadowInsertionAdapter({ observe: () => new Promise(() => undefined) } as never)
    .observeWorkerPickup({ projectId, logicalOperationId: "timeout-isolated", route: "full_deploy" });
  await settle();

  const adapterSource = readFileSync(resolve(__dirname, "../src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter.ts"), "utf8");
  const workerSource = readFileSync(resolve(__dirname, "../src/projects/pipeline/pipeline-worker.service.ts"), "utf8");
  assert.equal(/InactiveReleaseLaneOwnershipService|InactiveReleaseLaneCorrelationService|\.acquire\(|\.renew\(|\.release\(/.test(adapterSource), false);
  assert.equal(/queue\.add|from ["']@aws-sdk|from ["']bullmq|terraform-runner|docker-build/i.test(adapterSource), false);
  assert.equal(/InactiveReleaseLaneShadowObserverService/.test(workerSource), false);
  assert.match(workerSource, /this\.observeWorkerPickup\(run, job, jobType\)/);
  assert.match(workerSource, /this\.observeWorkerPreMutation\(run, job, jobType\)/);
  assert.match(workerSource, /this\.observeWorkerPreMutation\(run, job, "stage_selective_resume"\)/);
  assert.match(workerSource, /this\.observeWorkerPreMutation\(run, job, "cost_approval_resume"\)/);
  assert.match(workerSource, /this\.observeWorkerPreMutation\(run, job, "apply_approval_resume"\)/);
  assert.match(workerSource, /this\.observeWorkerPreMutation\(run, job, "state_lock_resume"\)/);
  assert.match(workerSource, /this\.observeWorkerPreMutation\(run, job, "storage_provision"\)/);
  assert.equal(workerSource.indexOf("this.observeWorkerPickup(run, job, jobType)") > workerSource.indexOf("if (run.status === PipelineRunStatus.CANCELLED)"), true);
  assert.equal(workerSource.indexOf("this.observeWorkerPreMutation(run, job, jobType)") < workerSource.indexOf("await this.runExternalCiValidation"), true);
  assert.equal(workerSource.includes("this.legacyShadow?.observe"), true);
  console.log("Inactive legacy worker shadow insertion verification passed");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
