import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InactiveLegacyShadowInsertionAdapter } from "../src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter";
import { ReleaseLaneShadowObservationInput } from "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.types";

const projectId = "11111111-1111-4111-8111-111111111111";
const observed: ReleaseLaneShadowObservationInput[] = [];
const settle = () => new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

async function main() {
  const adapter = new InactiveLegacyShadowInsertionAdapter({
    observe: async (input) => {
      observed.push(input);
      return { enabled: false };
    },
  } as never);
  const run = (logicalOperationId: string) => ({ projectId, logicalOperationId });

  adapter.observeFullDeploymentRun(run("run-full"));
  adapter.observeRetryCreatedRun(run("run-retry"));
  adapter.observeFullRecoveryResume(run("run-recovery"));
  adapter.observeStageSelectiveResume(run("run-selective"));
  adapter.observeCostApprovalResume(run("run-cost"));
  adapter.observeApplyApprovalResume(run("run-apply"));
  adapter.observeStateLockResume(run("run-lock"));
  adapter.observeInfrastructureDeploy(run("run-infra-deploy"));
  adapter.observeInfrastructurePlan(run("run-plan"));
  adapter.observeInfrastructureApply(run("run-infra-apply"));
  adapter.observeStorageProvision(run("run-storage"));
  await settle();

  assert.deepEqual(observed.map((item) => [item.operationClass, item.insertionSource]), [
    ["legacy_full_deployment_run", "pipeline_service.start_run"],
    ["legacy_retry", "pipeline_service.start_run"],
    ["legacy_full_recovery_resume", "stage_selective_resume.execute"],
    ["legacy_stage_selective_resume", "stage_selective_resume.execute"],
    ["legacy_cost_approval_resume", "finops_service.resume_after_cost_approval"],
    ["legacy_apply_approval_resume", "pipeline_service.approve_terraform_apply"],
    ["legacy_state_lock_resume", "infrastructure_service.release_state_lock"],
    ["legacy_infrastructure_deploy", "infrastructure_service.deploy"],
    ["legacy_infrastructure_plan", "infrastructure_service.queue_plan"],
    ["legacy_infrastructure_apply", "infrastructure_service.queue_apply"],
    ["legacy_storage_provision", "storage_service.provision"],
  ]);
  assert.equal(observed.every((item) => item.proposedLane === "legacy" && item.environmentName === "dev" && item.projectId === projectId), true);
  assert.equal(observed.every((item) => Object.keys(item).sort().join(",") === "environmentName,insertionSource,logicalOperationIdentity,operationClass,projectId,proposedLane"), true);
  assert.equal(observed.every((item) => !/secret|credential|actor|repository|queue/i.test(item.logicalOperationIdentity)), true);

  new InactiveLegacyShadowInsertionAdapter({ observe: async () => { throw new Error("disabled or unavailable"); } } as never)
    .observeFullDeploymentRun(run("failure-isolated"));
  new InactiveLegacyShadowInsertionAdapter({ observe: () => { throw new Error("sync failure"); } } as never)
    .observeFullDeploymentRun(run("sync-failure-isolated"));
  new InactiveLegacyShadowInsertionAdapter({ observe: () => new Promise(() => undefined) } as never)
    .observeFullDeploymentRun(run("timeout-isolated"));
  await settle();

  const adapterSource = readFileSync(resolve(__dirname, "../src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter.ts"), "utf8");
  const pipelineSource = readFileSync(resolve(__dirname, "../src/projects/pipeline/pipeline.service.ts"), "utf8");
  const recoverySource = readFileSync(resolve(__dirname, "../src/projects/recovery/stage-selective-resume.service.ts"), "utf8");
  const finopsSource = readFileSync(resolve(__dirname, "../src/finops/finops.service.ts"), "utf8");
  const infrastructureSource = readFileSync(resolve(__dirname, "../src/infrastructure/infrastructure.service.ts"), "utf8");
  const storageSource = readFileSync(resolve(__dirname, "../src/storage/storage.service.ts"), "utf8");
  assert.equal(/InactiveReleaseLaneOwnershipService|InactiveReleaseLaneCorrelationService|\.acquire\(|\.renew\(|\.release\(/.test(adapterSource), false);
  assert.equal(
    /from\s+["']bullmq["']|require\(\s*["']bullmq["']\s*\)|\b(?:new\s+)?(?:Queue|Worker)\s*[<(]|\.(?:add|addBulk|run|start)\s*\(/.test(
      adapterSource,
    ),
    false,
  );
  assert.match(pipelineSource, /this\.observeStartRun\(project\.id, pipelineRun\.id, shadowOrigin\)/);
  assert.match(pipelineSource, /this\.legacyShadow\?\.observeApplyApprovalResume/);
  assert.match(recoverySource, /this\.legacyShadow\?\.observeStageSelectiveResume/);
  assert.match(recoverySource, /"cleanup_inventory", "cleanup_safe_leftovers"/);
  assert.match(finopsSource, /this\.legacyShadow\?\.observeCostApprovalResume/);
  assert.match(infrastructureSource, /this\.legacyShadow\?\.observeStateLockResume/);
  assert.match(infrastructureSource, /this\.legacyShadow\?\.observeInfrastructureDeploy/);
  assert.match(infrastructureSource, /this\.legacyShadow\?\.observeInfrastructurePlan/);
  assert.match(infrastructureSource, /this\.legacyShadow\?\.observeInfrastructureApply/);
  assert.match(storageSource, /this\.legacyShadow\?\.observeStorageProvision/);
  assert.ok(pipelineSource.indexOf("this.observeStartRun") < pipelineSource.indexOf("await this.pipelineQueue.add"));
  assert.ok(finopsSource.indexOf("this.legacyShadow?.observeCostApprovalResume") < finopsSource.indexOf("await this.pipelineQueue.add"));
  assert.ok(storageSource.indexOf("this.legacyShadow?.observeStorageProvision") < storageSource.indexOf("await this.pipelineQueue.add"));
  console.log("Inactive legacy shadow insertion verification passed");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
