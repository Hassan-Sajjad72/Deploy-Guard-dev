import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { NormalReleaseLaneStatusService } from "../src/orchestration-contracts/release-lane/normal-release-lane-status.service";

const projectId = "11111111-1111-4111-8111-111111111111";
const intentId = "22222222-2222-4222-8222-222222222222";
const infrastructureId = "33333333-3333-4333-8333-333333333333";
const releaseId = "44444444-4444-4444-8444-444444444444";
const user: any = { id: 7, role: "developer" };

function service(status = "planned", options: {
  enabled?: boolean;
  malformed?: boolean;
  missing?: boolean;
  conflict?: boolean;
  autoConvergence?: boolean;
  failureCode?: string | null;
  preflight?: "passed" | "blocked" | "stale" | "unavailable";
  security?: "passed" | "blocked" | "unavailable" | "deferred";
} = {}) {
  let reads = 0;
  const enqueued = ["enqueued", "running", "completed", "failed", "cancelled"].includes(status);
  const started = ["running", "completed", "failed", "cancelled"].includes(status);
  const terminal = ["completed", "failed", "cancelled", "rejected"].includes(status);
  const intent = options.missing ? null : {
    id: intentId, projectId, environmentName: "dev", classification: "release_only", status,
    releaseManifestId: releaseId, infrastructureManifestId: infrastructureId,
    failureCode: options.failureCode ?? null,
    receivedAt: new Date("2026-07-27T00:00:00.000Z"),
    plannedAt: new Date("2026-07-27T00:01:00.000Z"),
    enqueuedAt: enqueued ? new Date("2026-07-27T00:02:00.000Z") : null,
    startedAt: started ? new Date("2026-07-27T00:03:00.000Z") : null,
    completedAt: terminal ? new Date("2026-07-27T00:04:00.000Z") : null,
    updatedAt: new Date("2026-07-27T00:04:00.000Z"),
  };
  const instance = new NormalReleaseLaneStatusService(
    new ConfigService({
      TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: options.enabled === false ? "false" : "true",
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
      TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_ENABLED: options.autoConvergence ? "true" : "false",
      TWO_LANE_NORMAL_RELEASE_OUTCOME_RECONCILE_APPROVED: options.autoConvergence ? "true" : "false",
      TRIVY_SCAN_ENABLED: options.security === "deferred" ? "false" : "true",
    }),
    { findOne: async () => { reads += 1; return { id: projectId, ownerUserId: user.id, environmentName: "dev", visibility: "private" }; } } as any,
    { findOne: async () => { reads += 1; return intent; } } as any,
    { findOne: async (input: any) => {
      reads += 1;
      if (options.malformed) return null;
      if (input?.where?.status === "stable") return {
        id: releaseId, projectId, environmentName: "dev", revision: "3", infrastructureManifestId: infrastructureId,
        commitSha: "1234567890abcdef1234567890abcdef12345678", taskDefinitionArn: "task:3",
        promotedAt: new Date("2026-07-27T00:04:00.000Z"), previousStableManifestId: null,
      };
      return {
        id: releaseId,
        projectId,
        environmentName: "dev",
        revision: "3",
        infrastructureManifestId: infrastructureId,
        commitSha: "1234567890abcdef1234567890abcdef12345678",
        deploymentContractHash: "a".repeat(64),
        imageUri: started ? `fixture.invalid/app@sha256:${"b".repeat(64)}` : null,
        buildStartedAt: started ? new Date("2026-07-27T00:03:00.000Z") : null,
        builtAt: started ? new Date("2026-07-27T00:03:30.000Z") : null,
        taskDefinitionArn: status === "completed" ? "task:3" : null,
        deploymentStartedAt: status === "completed" ? new Date("2026-07-27T00:03:40.000Z") : null,
        healthVerifiedAt: status === "completed" ? new Date("2026-07-27T00:03:50.000Z") : null,
        healthEvidence: status === "completed"
          ? { safeCode: "ECS_ROLLOUT_AND_TARGETS_HEALTHY", private: "hidden" }
          : null,
        promotedAt: status === "completed" ? new Date("2026-07-27T00:04:00.000Z") : null,
        updatedAt: new Date("2026-07-27T00:01:00.000Z"),
      };
    } } as any,
    { findOne: async () => { reads += 1; return options.malformed ? null : { id: infrastructureId, projectId, environmentName: "dev", revision: "4", status: "applied" }; } } as any,
    { findOne: async () => {
      reads += 1;
      if (status === "planned") return { status: "pending", createdAt: new Date("2026-07-27T00:01:00.000Z"), updatedAt: new Date("2026-07-27T00:02:00.000Z") };
      if (status === "completed") return { status: "published", createdAt: new Date("2026-07-27T00:01:00.000Z"), publishedAt: new Date("2026-07-27T00:02:00.000Z"), updatedAt: new Date("2026-07-27T00:02:00.000Z") };
      return null;
    } } as any,
    { findOne: async () => options.conflict ? { releaseManifestId: "99999999-9999-4999-8999-999999999999", taskDefinitionArn: "task:other", ecsServiceArn: null, albDnsName: "safe.example.test" } : null } as any,
    undefined,
    { findOne: async () => options.preflight === "unavailable" ? null : ({
      inputFingerprint: options.preflight === "stale" ? "c".repeat(64) : "a".repeat(64),
      validationStatus: options.preflight === "blocked" ? "failed" : "passed",
      updatedAt: new Date("2026-07-27T00:01:00.000Z"),
    }) } as any,
    { findOne: async () => options.security === "unavailable" ? null : ({
      scanStatus: "completed",
      policyDecision: options.security === "blocked" ? "blocked" : "allowed",
      policyReason: "must-not-be-projected",
      rawSummary: { private: "must-not-be-projected" },
      completedAt: new Date("2026-07-27T00:03:35.000Z"),
      updatedAt: new Date("2026-07-27T00:03:35.000Z"),
    }) } as any,
    { find: async () => status === "completed" ? [
      {
        effectType: "ecr.build_push_immutable_image",
        status: "succeeded",
        completedAt: new Date("2026-07-27T00:03:20.000Z"),
        updatedAt: new Date("2026-07-27T00:03:20.000Z"),
        ownerWorkerId: "worker-secret",
        externalReferenceHash: "1".repeat(64),
      },
      {
        effectType: "ecs.register_task_definition_revision",
        status: "succeeded",
        completedAt: new Date("2026-07-27T00:03:30.000Z"),
        updatedAt: new Date("2026-07-27T00:03:30.000Z"),
      },
      {
        effectType: "ecs.update_existing_service",
        status: "succeeded",
        completedAt: new Date("2026-07-27T00:03:40.000Z"),
        updatedAt: new Date("2026-07-27T00:03:40.000Z"),
      },
    ] : [] } as any,
  );
  return { instance, reads: () => reads };
}

void (async () => {
  const disabled = service("planned", { enabled: false });
  assert.deepEqual(await disabled.instance.get(user, projectId), { state: "disabled", safeCodes: ["NORMAL_RELEASE_LANE_STATUS_DISABLED"] });
  assert.equal(disabled.reads(), 1);

  const outOfScope = new NormalReleaseLaneStatusService(
    new ConfigService({
      TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: "true",
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST: "99999999-9999-4999-8999-999999999999",
      TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    }),
    { findOne: async () => ({ id: projectId, ownerUserId: user.id, environmentName: "dev", visibility: "private" }) } as any,
    {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  assert.deepEqual(await outOfScope.get(user, projectId), { state: "disabled", safeCodes: ["NORMAL_RELEASE_LANE_STATUS_DISABLED"] });

  const prepared = service();
  const result = await prepared.instance.get(user, projectId);
  assert.equal(result.state, "prepared");
  assert.equal(result.intent?.outboxStatus, "pending");
  assert.equal(result.intent?.safeId, intentId.slice(0, 8));
  assert.equal(result.intent?.releaseManifestRevision, "3");
  assert.equal(result.intent?.appliedInfrastructureRevision, "4");
  assert.equal(result.intent?.sourceCommitShortSha, "1234567890ab");
  assert.equal(result.intent?.lifecycleCode, "RELEASE_LANE_INTENT_PREPARED");
  assert.equal(result.intent?.lastMeaningfulAt, "2026-07-27T00:04:00.000Z");
  assert.equal(result.intent?.infrastructurePlanning, null);
  assert.deepEqual(result.intent?.history, [{ kind: "prepared", code: "RELEASE_LANE_INTENT_PREPARED", occurredAt: "2026-07-27T00:01:00.000Z" }]);
  assert.deepEqual(result.intent?.operation?.phases.map((phase) => [phase.label, phase.status]), [
    ["Analyze", "passed"],
    ["Build", "not_started"],
    ["Prepare", "not_started"],
    ["Deploy", "not_started"],
    ["Verify", "not_started"],
  ]);
  assert.deepEqual(result.intent?.operation?.evidence, {
    preflight: {
      state: "passed",
      safeCode: "NORMAL_RELEASE_PREFLIGHT_PASSED",
      observedAt: "2026-07-27T00:01:00.000Z",
    },
    security: {
      state: "not_started",
      safeCode: "NORMAL_RELEASE_SECURITY_NOT_STARTED",
      observedAt: null,
    },
  });
  assert.equal(result.intent?.operation?.terminalResult, null);
  assert.deepEqual(result.intent?.operation?.observability.metrics, {
    completedPhases: 1,
    totalPhases: 5,
    succeededEffects: 0,
    totalEffects: 0,
    durationMs: null,
  });
  assert.deepEqual(result.intent?.operation?.observability.events, [{
    phase: "analyze",
    state: "passed",
    safeCode: "NORMAL_RELEASE_ANALYZE_PASSED",
    occurredAt: "2026-07-27T00:01:00.000Z",
  }]);
  assert.deepEqual(result.stableRelease, {
    revision: "3", sourceCommitShortSha: "1234567890ab", status: "stable",
    promotedAt: "2026-07-27T00:04:00.000Z", url: null, rollbackLineage: null,
  });

  assert.equal((await service("cancelled").instance.get(user, projectId)).state, "cancelled");
  assert.equal((await service("enqueued").instance.get(user, projectId)).state, "queued");
  assert.equal((await service("running").instance.get(user, projectId)).state, "running");
  const completed = await service("completed").instance.get(user, projectId);
  assert.equal(completed.state, "completed");
  assert.deepEqual(completed.intent?.history.map((event) => event.kind), ["prepared", "queued", "running", "completed"]);
  assert.deepEqual(
    completed.intent?.operation?.phases.map((phase) => phase.status),
    ["passed", "passed", "passed", "passed", "passed"],
  );
  assert.equal(completed.intent?.operation?.terminalResult, "live");
  assert.equal(completed.intent?.operation?.evidence.security.state, "passed");
  assert.deepEqual(completed.intent?.operation?.observability.serviceHealth, {
    state: "healthy",
    safeCode: "NORMAL_RELEASE_SERVICE_HEALTHY",
    observedAt: "2026-07-27T00:03:50.000Z",
  });
  assert.deepEqual(completed.intent?.operation?.observability.metrics, {
    completedPhases: 5,
    totalPhases: 5,
    succeededEffects: 3,
    totalEffects: 3,
    durationMs: 60_000,
  });
  assert.equal(completed.intent?.operation?.observability.events.length, 5);
  assert.deepEqual(
    completed.intent?.operation?.observability.logs.map((entry) => entry.label),
    [
      "Immutable image prepared",
      "Runtime definition prepared",
      "Service update requested",
    ],
  );
  assert.equal(JSON.stringify(completed).includes("worker-secret"), false);
  assert.equal(JSON.stringify(completed).includes("externalReferenceHash"), false);
  assert.equal(JSON.stringify(completed).includes("private"), false);
  assert.equal(completed.intent?.history.length <= 4, true);
  const completedEvents = (completed as any).intent.history;
  assert.deepEqual(completedEvents.map((event: any) => event.occurredAt), completedEvents.map((event: any) => event.occurredAt).sort());
  assert.equal((await service("planned", { malformed: true }).instance.get(user, projectId)).state, "blocked");
  const blocked = await service("failed").instance.get(user, projectId);
  assert.equal(blocked.state, "blocked");
  assert.equal((blocked as any).intent.history.at(-1).kind, "blocked");
  assert.equal((blocked as any).intent.history.at(-1).code, "NORMAL_RELEASE_LANE_STATUS_BLOCKED");
  assert.equal((blocked as any).intent.operation.terminalResult, "failed");
  assert.equal(
    (blocked as any).intent.operation.phases.some((phase: any) => phase.status === "failed"),
    true,
  );
  const scannerUnavailable = await service("completed", {
    security: "unavailable",
  }).instance.get(user, projectId);
  assert.equal((scannerUnavailable as any).intent.operation.terminalResult, "failed");
  assert.equal((scannerUnavailable as any).intent.operation.phases[1].status, "failed");
  assert.deepEqual((scannerUnavailable as any).intent.operation.evidence.security, {
    state: "unavailable",
    safeCode: "NORMAL_RELEASE_SECURITY_SCANNER_UNAVAILABLE",
    observedAt: null,
  });
  const scannerDeferred = await service("completed", {
    security: "deferred",
  }).instance.get(user, projectId);
  assert.equal((scannerDeferred as any).intent.operation.terminalResult, "live");
  assert.equal((scannerDeferred as any).intent.operation.phases[1].status, "passed");
  assert.deepEqual((scannerDeferred as any).intent.operation.evidence.security, {
    state: "deferred",
    safeCode: "NORMAL_RELEASE_SECURITY_DEFERRED",
    observedAt: null,
  });
  const policyBlocked = await service("completed", {
    security: "blocked",
  }).instance.get(user, projectId);
  assert.equal((policyBlocked as any).intent.operation.terminalResult, "failed");
  assert.deepEqual((policyBlocked as any).intent.operation.evidence.security, {
    state: "blocked",
    safeCode: "NORMAL_RELEASE_SECURITY_POLICY_BLOCKED",
    observedAt: "2026-07-27T00:03:35.000Z",
  });
  assert.equal(JSON.stringify(policyBlocked).includes("must-not-be-projected"), false);
  const stalePreflight = await service("completed", {
    preflight: "stale",
  }).instance.get(user, projectId);
  assert.equal((stalePreflight as any).intent.operation.phases[0].status, "failed");
  assert.equal(
    (stalePreflight as any).intent.operation.evidence.preflight.safeCode,
    "NORMAL_RELEASE_PREFLIGHT_EVIDENCE_STALE",
  );
  const reconciling = await service("failed", {
    autoConvergence: true,
    failureCode: "RELEASE_EVIDENCE_AMBIGUOUS",
  }).instance.get(user, projectId);
  assert.equal(reconciling.state, "reconciling");
  assert.deepEqual(reconciling.safeCodes, ["NORMAL_RELEASE_CONVERGENCE_RECONCILING"]);
  const exhausted = await service("failed", {
    failureCode: "NORMAL_RELEASE_CONVERGENCE_BOUND_EXHAUSTED",
  }).instance.get(user, projectId);
  assert.equal(exhausted.state, "blocked");
  assert.deepEqual(exhausted.safeCodes, ["NORMAL_RELEASE_CONVERGENCE_BOUND_EXHAUSTED"]);
  assert.equal((await service("planned", { missing: true }).instance.get(user, projectId)).state, "missing");
  const conflict = await service("completed", { conflict: true }).instance.get(user, projectId);
  assert.equal(conflict.state, "blocked");
  assert.deepEqual(conflict.safeCodes, ["NORMAL_RELEASE_LANE_STABLE_IDENTITY_CONFLICT"]);
  assert.equal(conflict.stableRelease, null);

  const recoveredInfrastructureId = "66666666-6666-4666-8666-666666666666";
  const recoveredCommit = "abcdef0123456789abcdef0123456789abcdef01";
  const recoveredIntent = {
    id: intentId,
    projectId,
    environmentName: "dev",
    classification: "release_only",
    status: "completed",
    releaseManifestId: releaseId,
    infrastructureManifestId: infrastructureId,
    failureCode: null,
    receivedAt: new Date("2026-07-27T00:00:00.000Z"),
    plannedAt: new Date("2026-07-27T00:01:00.000Z"),
    enqueuedAt: new Date("2026-07-27T00:02:00.000Z"),
    startedAt: new Date("2026-07-27T00:03:00.000Z"),
    completedAt: new Date("2026-07-27T00:04:00.000Z"),
    updatedAt: new Date("2026-07-27T00:04:00.000Z"),
  };
  const recoveredRelease = {
    id: releaseId,
    projectId,
    environmentName: "dev",
    revision: "1",
    status: "stable",
    infrastructureManifestId: recoveredInfrastructureId,
    commitSha: recoveredCommit,
    deploymentContractHash: "a".repeat(64),
    imageUri: `fixture.invalid/app@sha256:${"b".repeat(64)}`,
    builtAt: new Date("2026-07-27T00:03:30.000Z"),
    taskDefinitionArn: "task:1",
    deploymentStartedAt: new Date("2026-07-27T00:03:40.000Z"),
    healthVerifiedAt: new Date("2026-07-27T00:03:50.000Z"),
    healthEvidence: { safeCode: "ECS_ROLLOUT_AND_TARGETS_HEALTHY" },
    promotedAt: new Date("2026-07-27T00:04:00.000Z"),
    previousStableManifestId: null,
    updatedAt: new Date("2026-07-27T00:04:00.000Z"),
  };
  const recoveredStatus = (validParent: boolean) => new NormalReleaseLaneStatusService(
    new ConfigService({
      TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: "true",
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
      TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
      TRIVY_SCAN_ENABLED: "false",
    }),
    { findOne: async () => ({ id: projectId, ownerUserId: user.id, environmentName: "dev", visibility: "private" }) } as any,
    { findOne: async () => recoveredIntent } as any,
    { findOne: async () => recoveredRelease } as any,
    { findOne: async (input: any) => input.where.id === recoveredInfrastructureId
      ? {
        id: recoveredInfrastructureId,
        projectId,
        environmentName: "dev",
        revision: "2",
        status: "applied",
        parentManifestId: validParent ? infrastructureId : null,
      }
      : {
        id: infrastructureId,
        projectId,
        environmentName: "dev",
        revision: "1",
        status: "superseded",
      } } as any,
    { findOne: async () => ({
      eventType: "intent.release.execute",
      status: "published",
      createdAt: new Date("2026-07-27T00:01:00.000Z"),
      publishedAt: new Date("2026-07-27T00:02:00.000Z"),
      updatedAt: new Date("2026-07-27T00:02:00.000Z"),
    }) } as any,
    { findOne: async () => null } as any,
    { findOne: async () => ({
      intentId,
      projectId,
      environmentName: "dev",
      infrastructureManifestId: infrastructureId,
      createdAt: new Date("2026-07-27T00:01:00.000Z"),
      releaseDraft: { commitSha: recoveredCommit },
    }) } as any,
    { findOne: async () => ({
      inputFingerprint: "a".repeat(64),
      validationStatus: "passed",
      updatedAt: new Date("2026-07-27T00:01:00.000Z"),
    }) } as any,
    { findOne: async () => null } as any,
    { find: async () => [] } as any,
  );
  const recovered = await recoveredStatus(true).get(user, projectId);
  assert.equal(recovered.state, "completed");
  assert.deepEqual(recovered.safeCodes, ["FIRST_RELEASE_INTENT_COMPLETED"]);
  assert.equal(recovered.intent.appliedInfrastructureRevision, "2");
  assert.deepEqual(recovered.intent.infrastructurePlanning, {
    planState: "completed",
    applyState: "applied",
    planOutboxStatus: "published",
    applyOutboxStatus: null,
    review: null,
  });
  assert.equal(recovered.intent.operation?.terminalResult, "live");
  assert.equal(recovered.intent.operation?.evidence.security.state, "deferred");
  const recoveredConflict = await recoveredStatus(false).get(user, projectId);
  assert.equal(recoveredConflict.state, "blocked");
  assert.deepEqual(recoveredConflict.safeCodes, [
    "NORMAL_FIRST_RELEASE_STABLE_LINEAGE_CONFLICT",
  ]);
  assert.equal(recoveredConflict.intent.appliedInfrastructureRevision, "1");

  const firstReleaseIntent = {
    id: intentId, projectId, environmentName: "dev", classification: "infrastructure_change", status: "planned",
    releaseManifestId: null, infrastructureManifestId: infrastructureId, failureCode: null,
    receivedAt: new Date("2026-07-27T00:00:00.000Z"), plannedAt: new Date("2026-07-27T00:01:00.000Z"),
    enqueuedAt: null, startedAt: null, completedAt: null, updatedAt: new Date("2026-07-27T00:01:00.000Z"),
  };
  let firstIntentReads = 0;
  const firstRelease = new NormalReleaseLaneStatusService(
    new ConfigService({
      TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED: "true",
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
      TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    }),
    { findOne: async () => ({ id: projectId, ownerUserId: user.id, environmentName: "dev", visibility: "private" }) } as any,
    { findOne: async () => ++firstIntentReads === 1 ? null : firstReleaseIntent } as any,
    { findOne: async () => null } as any,
    { findOne: async () => ({ id: infrastructureId, projectId, environmentName: "dev", revision: "1", status: "desired" }) } as any,
    { findOne: async () => ({
      eventType: "intent.infrastructure.plan",
      status: "pending",
      createdAt: new Date("2026-07-27T00:01:00.000Z"),
      updatedAt: new Date("2026-07-27T00:01:00.000Z"),
    }) } as any,
    { findOne: async () => null } as any,
    { findOne: async () => ({ intentId, projectId, environmentName: "dev", createdAt: new Date("2026-07-27T00:01:00.000Z"), releaseDraft: { commitSha: "abcdef0123456789abcdef0123456789abcdef01" } }) } as any,
  );
  const first = await firstRelease.get(user, projectId);
  assert.equal(first.state, "prepared");
  assert.deepEqual(first.safeCodes, ["FIRST_RELEASE_INTENT_PREPARED"]);
  assert.equal(first.intent.firstRelease, true);
  assert.equal(first.intent.releaseManifestRevision, null);
  assert.equal(first.intent.appliedInfrastructureRevision, "1");
  assert.equal(first.intent.sourceCommitShortSha, "abcdef012345");
  assert.equal(first.intent.operation, null);
  assert.deepEqual(first.intent.infrastructurePlanning, {
    planState: "prepared",
    applyState: "not_ready",
    planOutboxStatus: "pending",
    applyOutboxStatus: null,
    review: null,
  });
  assert.deepEqual(first.intent.history, [{ kind: "prepared", code: "FIRST_RELEASE_INTENT_PREPARED", occurredAt: "2026-07-27T00:01:00.000Z" }]);

  const applyIntentId = "55555555-5555-4555-8555-555555555555";
  const planCompletedIntent = {
    ...firstReleaseIntent,
    status: "plan_completed",
    updatedAt: new Date("2026-07-27T00:04:00.000Z"),
  };
  const applyContinuation = {
    id: applyIntentId,
    projectId,
    environmentName: "dev",
    kind: "apply",
    classification: "infrastructure_change",
    status: "planned",
    infrastructureManifestId: infrastructureId,
    releaseManifestId: null,
    requestPayload: {
      operation: "infrastructure_apply_continuation",
      parentPlanIntentId: intentId,
    },
    decision: {
      approvalRequired: true,
      executionLane: "infrastructure",
      desiredInfrastructureManifestId: infrastructureId,
    },
    createdAt: new Date("2026-07-27T00:03:00.000Z"),
    updatedAt: new Date("2026-07-27T00:03:00.000Z"),
  };
  let completedIntentReads = 0;
  const completedFirstRelease = new NormalReleaseLaneStatusService(
    new ConfigService({
      TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED: "true",
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
      TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    }),
    { findOne: async () => ({
      id: projectId,
      ownerUserId: user.id,
      environmentName: "dev",
      visibility: "private",
    }) } as any,
    {
      findOne: async () =>
        ++completedIntentReads === 1 ? null : planCompletedIntent,
      find: async () => [applyContinuation],
    } as any,
    { findOne: async () => null } as any,
    { findOne: async () => ({
      id: infrastructureId,
      projectId,
      environmentName: "dev",
      revision: "1",
      status: "planned",
    }) } as any,
    { findOne: async (input: any) =>
      input.where.intentId === applyIntentId
        ? {
          eventType: "intent.infrastructure.apply",
          status: "pending",
          attemptCount: 0,
          claimedBy: null,
          claimExpiresAt: null,
          publishedJobId: null,
          publishedAt: null,
          createdAt: new Date("2026-07-27T00:03:00.000Z"),
          updatedAt: new Date("2026-07-27T00:03:00.000Z"),
        }
        : {
          eventType: "intent.infrastructure.plan",
          status: "published",
          attemptCount: 1,
          createdAt: new Date("2026-07-27T00:01:00.000Z"),
          publishedAt: new Date("2026-07-27T00:02:00.000Z"),
          updatedAt: new Date("2026-07-27T00:02:00.000Z"),
        } } as any,
    { findOne: async () => null } as any,
    { findOne: async () => ({
      intentId,
      projectId,
      environmentName: "dev",
      createdAt: new Date("2026-07-27T00:01:00.000Z"),
      releaseDraft: {
        commitSha: "abcdef0123456789abcdef0123456789abcdef01",
      },
    }) } as any,
  );
  const applyAwaiting = await completedFirstRelease.get(user, projectId);
  assert.equal(applyAwaiting.state, "prepared");
  assert.deepEqual(applyAwaiting.safeCodes, [
    "FIRST_RELEASE_INFRASTRUCTURE_APPLY_AWAITING_APPROVAL",
  ]);
  assert.equal(applyAwaiting.intent.status, "plan_completed");
  assert.equal(applyAwaiting.intent.outboxStatus, "pending");
  assert.deepEqual(applyAwaiting.intent.infrastructurePlanning, {
    planState: "completed",
    applyState: "awaiting_approval",
    planOutboxStatus: "published",
    applyOutboxStatus: "pending",
    review: null,
  });
  assert.deepEqual(applyAwaiting.intent.history, [{
    kind: "prepared",
    code: "FIRST_RELEASE_INFRASTRUCTURE_APPLY_AWAITING_APPROVAL",
    occurredAt: "2026-07-27T00:01:00.000Z",
  }]);

  const forbidden = new NormalReleaseLaneStatusService(
    new ConfigService({
      TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: "true",
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
      TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    }),
    { findOne: async () => ({ id: projectId, ownerUserId: 99, environmentName: "dev", visibility: "private" }) } as any,
    {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  await assert.rejects(() => forbidden.get(user, projectId), /Insufficient permissions/);

  const source = readFileSync(join(__dirname, "../src/orchestration-contracts/release-lane/normal-release-lane-status.service.ts"), "utf8");
  assert.doesNotMatch(source, /DurableOutboxDispatcherService|InactiveV1BullMqConsumerService|PipelineService|TerraformRunnerService|ECSClient/);
  assert.doesNotMatch(source, /\bid:\s*intent\.id/);
  assert.match(source, /RELEASE_LANE_EVENT_LIMIT = 4/);
  assert.match(source, /FIRST_RELEASE_INTENT_PREPARED/);
  assert.match(source, /history = this\.events\(intent, visibleOutbox, state\.value, state\.safeCode\)/);
  assert.doesNotMatch(source, /events\([\s\S]*release\?\.createdAt/);
  assert.doesNotMatch(source, /ProjectOperationLease|SideEffectJournal|fencing/i);
  console.log("Normal release-lane status verification passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
