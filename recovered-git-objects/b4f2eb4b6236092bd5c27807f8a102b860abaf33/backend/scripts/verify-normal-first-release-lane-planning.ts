import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { NormalFirstReleaseLanePlanningService } from "../src/orchestration-contracts/release-lane/normal-first-release-lane-planning.service";
import { PlannerClassificationNotAllowedError, PlannerIdempotencyConflictError } from "../src/orchestration-contracts/planner/transactional-deployment-planner.types";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";

const projectId = "11111111-1111-4111-8111-111111111111";
const user: any = { id: 7, role: "developer" };
const commit = "a".repeat(40);
const contract = {
  projectId, deployable: true, invalidatedAt: null, invalidatedReason: null,
  commitSha: commit, detectionSourceCommit: commit, contractHash: "b".repeat(64),
};
const preflight = { projectId, validationStatus: "passed", inputFingerprint: contract.contractHash };
const initialIntent = {
  id: "22222222-2222-4222-8222-222222222222", status: "planned",
  classification: "infrastructure_change", infrastructureManifestId: "33333333-3333-4333-8333-333333333333",
  releaseManifestId: null,
};
const draft = {
  intentId: initialIntent.id, projectId, environmentName: "dev",
  releaseDraft: { commitSha: commit, deploymentContractHash: contract.contractHash },
};

function configuration(overrides: Record<string, unknown> = {}) {
  return new ConfigService({
    TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED: "true",
    TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    ...overrides,
  });
}

function service(options: {
  config?: ConfigService;
  applied?: unknown;
  stable?: unknown;
  existing?: unknown;
  existingDraft?: unknown;
  contract?: unknown;
  plannerError?: Error;
  managed?: boolean;
  projectEnvironment?: string;
  recovery?: boolean;
} = {}) {
  let plans = 0;
  const planner = { plan: async (input: any) => {
    plans += 1;
    assert.equal(input.requiredClassification, options.managed ? "release_only" : "infrastructure_change");
    assert.equal(input.requestedCommitSha, commit);
    if (options.managed) {
      assert.equal(input.initialReleaseDraftId, "55555555-5555-4555-8555-555555555555");
      assert.match(input.idempotencyKey, /^normal-managed-first-release:v1:/);
    } else if (options.recovery) {
      assert.equal(input.kind, "retry");
      assert.match(input.idempotencyKey, /^normal-first-release-pre-execution-retry:v1:/);
    } else {
      assert.equal(input.kind, "deploy");
      assert.equal(input.idempotencyKey, `normal-first-release-plan:v1:${projectId}:dev:${commit}:${contract.contractHash}`);
    }
    if (options.plannerError) throw options.plannerError;
    return { replayed: false, intent: options.managed ? { ...initialIntent, classification: "release_only", infrastructureManifestId: applied.id, releaseManifestId: "44444444-4444-4444-8444-444444444444" } : initialIntent };
  } };
  const applied = { id: "33333333-3333-4333-8333-333333333333", status: "applied", terraformOutputsHash: "d".repeat(64) };
  const managedDraft = { ...draft, id: "55555555-5555-4555-8555-555555555555", infrastructureManifestId: applied.id, infrastructureRevision: "1", draftHash: "e".repeat(64) };
  const recoveryIntent = {
    ...initialIntent,
    id: "66666666-6666-4666-8666-666666666666",
    projectId,
    environmentName: "dev",
    status: "failed",
    kind: "deploy",
    failureCode: "REMOTE_CANARY_PLAN_NOT_ALLOWED",
  };
  const recoveryManifest = {
    id: initialIntent.infrastructureManifestId, projectId, environmentName: "dev", revision: "1",
    status: "failed", failureCode: "REMOTE_CANARY_PLAN_NOT_ALLOWED",
    planArtifactReference: null, planArtifactSha256: null, planInputFingerprint: null,
    stateVersionId: null, terraformOutputs: null, terraformOutputsHash: null,
    resourceCount: null, plannedAt: null, applyStartedAt: null, appliedAt: null,
  };
  const recoveryDraft = {
    ...draft, intentId: recoveryIntent.id, infrastructureManifestId: recoveryManifest.id,
    infrastructureRevision: "1", draftHash: canonicalSha256(draft.releaseDraft),
  };
  const instance = new NormalFirstReleaseLanePlanningService(
    options.config || configuration(), planner as any,
    { findOne: async () => ({ id: projectId, ownerUserId: user.id, environmentName: options.projectEnvironment || "dev" }) } as any,
    { findOne: async () => options.contract === undefined ? contract : options.contract } as any,
    { findOne: async () => preflight } as any,
    { findOne: async () => null } as any,
    { findOne: async (query: any) => query.where.status === "applied" ? (options.managed ? applied : (options.applied || null)) : options.recovery ? recoveryManifest : (options.stable || null) } as any,
    { findOne: async () => options.stable || null } as any,
    {
      find: async () => options.existing ? [options.existing] : [],
      findOne: async (query: any) => typeof query.where.status === "string" && query.where.status === "failed"
        ? (options.recovery ? recoveryIntent : null)
        : null,
    } as any,
    { findOne: async (query: any) => options.recovery && query.where.intentId === recoveryIntent.id ? recoveryDraft : options.managed ? managedDraft : (options.existingDraft === undefined ? draft : options.existingDraft) } as any,
    options.recovery ? { findOne: async () => ({ intentId: recoveryIntent.id, eventType: "intent.infrastructure.plan", status: "published", attemptCount: 1, publishedAt: new Date(), publishedJobId: "job", claimedBy: null, claimExpiresAt: null }) } as any : undefined,
    options.recovery ? { find: async () => [{ intentId: recoveryIntent.id, projectId, environmentName: "dev", effectType: "infrastructure_terraform_plan", status: "failed", failureCode: "REMOTE_CANARY_PLAN_NOT_ALLOWED", reconciliationRequired: false, safeResultCode: null, resultFingerprint: null, externalReferenceHash: null }] } as any : undefined,
  );
  return { instance, plans: () => plans };
}

void (async () => {
  const disabled = service({ config: configuration({ TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED: "false" }) });
  assert.deepEqual(await disabled.instance.prepare(user, projectId), {
    state: "disabled", safeCodes: ["NORMAL_FIRST_RELEASE_PLANNING_DISABLED"], fallbackToLegacy: false,
  });
  assert.equal(disabled.plans(), 0);

  const ready = service();
  const prepared = await ready.instance.prepare(user, projectId);
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.firstRelease, true);
  assert.equal(prepared.intent.replayed, false);
  assert.equal(ready.plans(), 1);

  const sharedReady = service({
    config: configuration({
      TWO_LANE_NORMAL_V1_OPERATING_MODE: "shared",
      TWO_LANE_RELEASE_COMPOSITION_MODE: "production_shared",
      // Retained canary configuration is ignored by shared activation.
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST:
        "99999999-9999-4999-8999-999999999999",
    }),
  });
  assert.equal(
    (await sharedReady.instance.prepare(user, projectId)).state,
    "prepared",
  );
  assert.equal(sharedReady.plans(), 1);

  const replay = service({ existing: initialIntent, existingDraft: draft });
  const replayed = await replay.instance.prepare(user, projectId);
  assert.equal(replayed.state, "prepared");
  assert.equal(replayed.intent.replayed, true);
  assert.equal(replay.plans(), 0);

  const retry = service({ recovery: true });
  const retried = await retry.instance.prepare(user, projectId);
  assert.equal(retried.state, "prepared");
  assert.equal(retried.intent.replayed, false);
  assert.equal(retry.plans(), 1);

  const conflicting = service({ existing: initialIntent, existingDraft: { ...draft, releaseDraft: { ...draft.releaseDraft, commitSha: "c".repeat(40) } } });
  assert.deepEqual(await conflicting.instance.prepare(user, projectId), {
    state: "blocked", safeCodes: ["NORMAL_FIRST_RELEASE_IMMUTABLE_EVIDENCE_CONFLICT"], fallbackToLegacy: false,
  });
  assert.equal(conflicting.plans(), 0);

  const foundation = service({ applied: { id: "foundation", status: "applied" } });
  assert.deepEqual(await foundation.instance.prepare(user, projectId), { state: "not_applicable" });
  assert.equal(foundation.plans(), 0);

  const managed = service({ managed: true, config: configuration({ TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_PLANNING_ENABLED: "true" }) });
  const managedPrepared = await managed.instance.prepare(user, projectId);
  assert.equal(managedPrepared.state, "prepared");
  assert.equal(managedPrepared.intent.safeId, initialIntent.id.slice(0, 8));
  assert.equal(JSON.stringify(managedPrepared).includes("44444444-4444-4444-8444-444444444444"), false);
  assert.equal(managed.plans(), 1);

  const readonly = service();
  assert.deepEqual(await readonly.instance.prepare({ id: 8, role: "readonly" } as any, projectId), {
    state: "blocked",
    safeCodes: ["NORMAL_FIRST_RELEASE_ACTOR_NOT_ALLOWED"],
    fallbackToLegacy: false,
  });
  await assert.rejects(
    () => service().instance.prepare({ id: 8, role: "developer" } as any, projectId),
    /permission/,
  );
  assert.deepEqual(
    await service({ projectEnvironment: "production" }).instance.prepare(user, projectId),
    {
      state: "blocked",
      safeCodes: ["NORMAL_FIRST_RELEASE_PROJECT_INELIGIBLE"],
      fallbackToLegacy: false,
    },
  );

  const idempotency = service({ plannerError: new PlannerIdempotencyConflictError() });
  assert.deepEqual(await idempotency.instance.prepare(user, projectId), {
    state: "blocked", safeCodes: ["NORMAL_FIRST_RELEASE_IDEMPOTENCY_CONFLICT"], fallbackToLegacy: false,
  });
  const classification = service({ plannerError: new PlannerClassificationNotAllowedError("release_only") });
  assert.deepEqual(await classification.instance.prepare(user, projectId), {
    state: "blocked", safeCodes: ["NORMAL_FIRST_RELEASE_NOT_NEW_PROJECT"], fallbackToLegacy: false,
  });

  const controller = readFileSync(join(__dirname, "../src/projects/projects.controller.ts"), "utf8");
  const source = readFileSync(join(__dirname, "../src/orchestration-contracts/release-lane/normal-first-release-lane-planning.service.ts"), "utf8");
  assert.match(controller, /@Post\(":projectId\/release-lane\/prepare"\)\s+@UseGuards\(requireRole\(\[UserRole\.ADMIN\]\)\)/);
  assert.match(controller, /normalFirstReleaseLanePlanning\.prepare/);
  assert.match(controller, /LEGACY_DEPLOYMENT_EXECUTION_RETIRED/);
  assert.doesNotMatch(source, /fallbackToLegacy:\s*(?:true|boolean)/);
  assert.doesNotMatch(source, /DurableOutboxDispatcherService|InactiveV1BullMqConsumerService|PipelineService|TerraformRunnerService|FirstReleaseOneShot/);
  console.log("Normal first-release planning verification passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
