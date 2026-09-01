import "reflect-metadata";
import { strict as assert } from "node:assert";
import fc from "fast-check";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { assertRailpackRuntimeConfiguration, RailpackRuntimeConfiguration } from "../src/projects/railpack-workflow-contract";

type Action =
  | "deploy_success" | "deploy_failure" | "retry_success" | "redeploy_failure"
  | "rollback_failure_before_dispatch" | "rollback_failure_after_dispatch" | "rollback_success"
  | "destroy_failure_before_aws" | "destroy_failure_after_aws" | "destroy_cleanup_retry"
  | "refresh" | "change_configuration" | "reorder_services" | "attempt_while_active";

type Model = {
  projectId: string;
  environment: "dev";
  stable: string | null;
  live: string | null;
  active: string | null;
  candidate: string | null;
  rollbackTarget: string | null;
  destroyed: boolean;
  generationCounter: number;
  configurationRevision: number;
  serviceOrder: readonly ["web", "worker"] | readonly ["worker", "web"];
  retryProjectId: string | null;
};

const initial = (): Model => ({
  projectId: "11111111-1111-4111-8111-111111111111", environment: "dev",
  stable: null, live: null, active: null, candidate: null, rollbackTarget: null,
  destroyed: false, generationCounter: 0, configurationRevision: 1,
  serviceOrder: ["web", "worker"], retryProjectId: null,
});

function nextGeneration(state: Model) {
  state.generationCounter += 1;
  return `generation-${state.generationCounter}`;
}

function transition(previous: Model, action: Action): Model {
  const state: Model = { ...previous, serviceOrder: [...previous.serviceOrder] as Model["serviceOrder"] };
  if (action === "refresh") return state;
  if (action === "change_configuration") { state.configurationRevision += 1; return state; }
  if (action === "reorder_services") { state.serviceOrder = state.serviceOrder[0] === "web" ? ["worker", "web"] : ["web", "worker"]; return state; }
  if (action === "attempt_while_active") {
    if (!state.active) state.active = "admission-probe";
    return state;
  }
  if (state.active && state.active !== "admission-probe") return state;
  if (state.active === "admission-probe") state.active = null;

  if (action === "deploy_success") {
    const candidate = nextGeneration(state);
    state.rollbackTarget = state.stable;
    state.stable = candidate; state.live = candidate; state.candidate = null; state.destroyed = false;
  } else if (action === "deploy_failure" || action === "redeploy_failure") {
    state.candidate = nextGeneration(state);
    state.retryProjectId = state.projectId;
  } else if (action === "retry_success") {
    if (state.candidate && state.retryProjectId === state.projectId) {
      state.rollbackTarget = state.stable;
      state.stable = state.candidate; state.live = state.candidate; state.candidate = null; state.destroyed = false;
    }
  } else if (action === "rollback_failure_before_dispatch" || action === "rollback_failure_after_dispatch") {
    state.candidate = state.rollbackTarget;
  } else if (action === "rollback_success") {
    if (state.rollbackTarget) {
      const previousStable = state.stable;
      state.stable = state.rollbackTarget; state.live = state.rollbackTarget;
      state.rollbackTarget = previousStable; state.candidate = null; state.destroyed = false;
    }
  } else if (action === "destroy_failure_before_aws") {
    state.candidate = state.live;
  } else if (action === "destroy_failure_after_aws") {
    state.live = null; state.candidate = null; state.destroyed = true;
  } else if (action === "destroy_cleanup_retry" && state.destroyed) {
    state.live = null; state.stable = null; state.rollbackTarget = null; state.candidate = null;
  }
  return state;
}

function invariant(before: Model, after: Model, action: Action) {
  assert.equal(after.environment, "dev");
  assert.ok(!after.live || after.live === after.stable, "the LIVE route must identify the verified stable generation");
  if (action.includes("failure") && before.live) assert.equal(after.live, action === "destroy_failure_after_aws" ? null : before.live, "failed candidates cannot replace the verified stable runtime");
  if (after.destroyed) assert.equal(after.live, null, "historical releases cannot resurrect a destroyed LIVE route");
  if (action === "refresh" || action === "change_configuration" || action === "reorder_services") assert.equal(after.live, before.live, `${action} cannot select executable authority`);
  if (after.retryProjectId) assert.equal(after.retryProjectId, after.projectId, "retry ancestry cannot cross the project boundary");
}

const seed = Number(process.env.FC_SEED || 20260831);
const actions = fc.array(fc.constantFrom<Action>(
  "deploy_success", "deploy_failure", "retry_success", "redeploy_failure",
  "rollback_failure_before_dispatch", "rollback_failure_after_dispatch", "rollback_success",
  "destroy_failure_before_aws", "destroy_failure_after_aws", "destroy_cleanup_retry",
  "refresh", "change_configuration", "reorder_services", "attempt_while_active",
), { minLength: 4, maxLength: 80 });

async function verifyGeneratedStateMachine() {
  fc.assert(fc.property(actions, (sequence) => {
    let state = initial();
    for (const action of sequence) {
      const before = state;
      state = transition(state, action);
      invariant(before, state, action);
    }
  }), { seed, numRuns: 1_000, endOnFailure: true });
}

async function verifyActualRuntimeAndRollbackAuthority() {
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.uuid({ version: 4 }), { minLength: 1, maxLength: 8 }),
    fc.boolean(),
    async (serviceIds, reverse) => {
      const revisions = serviceIds.map((serviceId, index) => ({
        serviceId, serviceName: `Service ${index + 1}`, serviceDirectory: index ? `service-${index + 1}` : ".",
        imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/service-${index + 1}`, imageDigest: `sha256:${String((index % 9) + 1).repeat(64)}`,
        runtimeConfigRevisionId: serviceId, runtimeConfigRevision: {
          id: serviceId, projectId: "11111111-1111-4111-8111-111111111111", serviceId,
          isRollbackSafe: true, sealedAt: new Date(), nonSecretEnvironment: { PORT: "8080", HOST: "0.0.0.0" },
          secretReferences: {}, databaseConfiguration: { attached: false, engine: null, aliases: [] },
        },
      }));
      const deployment = Object.create(RailpackDeploymentService.prototype) as any;
      deployment.serviceRevisions = { find: async () => reverse ? [...revisions].reverse() : revisions };
      const release = { id: "77777777-7777-4777-8777-777777777777", generationId: "22222222-2222-4222-8222-222222222222", deployedByPipelineRunId: "33333333-3333-4333-8333-333333333333", commitSha: "a".repeat(40), metadata: { releaseEvidenceVerified: true } };
      const target = await deployment.rollbackTarget(release);
      assert.deepEqual(target.services.map((item: any) => item.serviceId), [...serviceIds].sort(), "rollback service authority must be independent of storage order");
      const runtime: RailpackRuntimeConfiguration = {
        schemaVersion: 2, projectId: "11111111-1111-4111-8111-111111111111", environmentName: "dev",
        operationId: "33333333-3333-4333-8333-333333333333", sourceSha: "a".repeat(40),
        services: target.services.map((item: any) => ({
          serviceId: item.serviceId, serviceName: item.serviceName, serviceDirectory: item.serviceDirectory,
          runtimeConfigRevisionId: item.runtimeConfigRevisionId, buildEnvironment: {}, buildSecretReferences: {}, environment: item.runtimeConfiguration.environment,
          secretReferences: item.runtimeConfiguration.secretReferences, databaseAttached: false,
          managedDatabase: { engine: null, aliases: [] }, rollbackImage: item.immutableImage,
        })),
      };
      assertRailpackRuntimeConfiguration(runtime);
    },
  ), { seed, numRuns: 250, endOnFailure: true });
}

void (async () => {
  try {
    await verifyGeneratedStateMachine();
    await verifyActualRuntimeAndRollbackAuthority();
    console.log(`LIFECYCLE_PROPERTY_TESTS=PASS SEED=${seed} RUNS=1000 RUNTIME_RUNS=250`);
  } catch (error) {
    console.error(`LIFECYCLE_PROPERTY_TESTS=FAIL SEED=${seed}`);
    throw error;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
