import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";
import {
  workerEnvelopeJobId,
  workerEnvelopePayloadForHash,
} from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import {
  InfrastructurePlanCompletionContinuationError,
  InfrastructurePlanCompletionContinuationInput,
  InfrastructurePlanCompletionContinuationService,
} from "../src/orchestration-contracts/infrastructure/infrastructure-plan-completion-continuation.service";
import { TerminalOutboxPolicyService } from "../src/orchestration-contracts/outbox/terminal-outbox-policy.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `infrastructure_plan_continuation_${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe schema identifier");
const baseOptions = AppDataSource.options as DataSourceOptions & {
  extra?: Record<string, unknown>;
};
const admin = new DataSource({
  ...baseOptions,
  entities: [],
  migrations: [],
  synchronize: false,
  logging: false,
} as DataSourceOptions);
const dataSource = new DataSource({
  ...baseOptions,
  schema,
  entities: [],
  migrations: [],
  synchronize: false,
  logging: false,
  extra: {
    ...(baseOptions.extra || {}),
    options: `-c search_path=${schema},public`,
  },
} as DataSourceOptions);
const service = new InfrastructurePlanCompletionContinuationService(
  dataSource,
  new ConfigService({ DEPLOYGUARD_VERSION: "test", GIT_SHA: "test-sha" }),
);

type Fixture = {
  projectId: string;
  parentIntentId: string;
  infrastructureManifestId: string;
  initialReleaseDraftId: string;
  planOutboxId: string;
  operationLeaseId: string;
  ownershipId: string;
  ownershipLeaseId: string;
  canonicalKey: string;
  requestFingerprint: string;
  planHash: string;
  planInputFingerprint: string;
  draftHash: string;
  originalDraft: Record<string, unknown>;
  input: InfrastructurePlanCompletionContinuationInput;
};

async function setup() {
  await dataSource.query(`
    CREATE TABLE deployment_intents (
      id uuid PRIMARY KEY,
      schema_version integer NOT NULL DEFAULT 1,
      project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL,
      requested_by_user_id integer NULL,
      kind varchar(32) NOT NULL,
      classification varchar(32) NULL,
      status varchar(32) NOT NULL,
      client_idempotency_key varchar(255) NOT NULL,
      canonical_idempotency_key char(64) NOT NULL,
      request_fingerprint char(64) NOT NULL,
      request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      decision jsonb NULL,
      infrastructure_manifest_id uuid NULL,
      release_manifest_id uuid NULL,
      source_pipeline_run_id uuid NULL,
      pipeline_run_id uuid NULL,
      destroy_operation_id uuid NULL,
      failure_code varchar(128) NULL,
      failure_message text NULL,
      received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      planned_at timestamptz NULL,
      enqueued_at timestamptz NULL,
      started_at timestamptz NULL,
      completed_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT UQ_deployment_intent_idempotency
        UNIQUE (project_id, environment_name, canonical_idempotency_key),
      CONSTRAINT CHK_deployment_intent_status CHECK (
        status IN (
          'received','planned','enqueued','running','plan_completed',
          'completed','failed','cancelled','no_op','rejected'
        )
      )
    );
    CREATE TABLE infrastructure_manifests (
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL,
      revision bigint NOT NULL,
      status varchar(32) NOT NULL,
      spec_hash char(64) NOT NULL,
      state_key varchar(512) NOT NULL,
      plan_artifact_reference jsonb NULL,
      plan_artifact_sha256 char(64) NULL,
      plan_input_fingerprint char(64) NULL,
      applied_at timestamptz NULL
    );
    CREATE TABLE initial_release_drafts (
      id uuid PRIMARY KEY,
      intent_id uuid NOT NULL UNIQUE,
      project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL,
      infrastructure_manifest_id uuid NOT NULL,
      infrastructure_revision bigint NOT NULL,
      draft_hash char(64) NOT NULL,
      release_draft jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE orchestration_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      intent_id uuid NOT NULL,
      aggregate_type varchar(32) NOT NULL,
      aggregate_id uuid NOT NULL,
      event_type varchar(64) NOT NULL,
      worker_envelope jsonb NOT NULL,
      payload_sha256 char(64) NOT NULL,
      status varchar(24) NOT NULL,
      attempt_count integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      claimed_by varchar NULL,
      claim_expires_at timestamptz NULL,
      claim_fencing_token bigint NOT NULL DEFAULT 0,
      published_job_id varchar NULL,
      last_error text NULL,
      published_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT UQ_orchestration_outbox_payload
        UNIQUE (intent_id, event_type, payload_sha256)
    );
    CREATE TABLE project_operation_leases (
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL,
      lane varchar(24) NOT NULL,
      scope varchar(32) NOT NULL,
      intent_id uuid NOT NULL,
      owner_worker_id varchar(160) NOT NULL,
      fencing_token bigint NOT NULL,
      status varchar(24) NOT NULL,
      acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL,
      released_at timestamptz NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE project_release_lane_ownerships (
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL,
      owner_lane varchar(16) NOT NULL,
      lease_id uuid NOT NULL,
      actor_id varchar(160) NOT NULL,
      idempotency_key char(64) NOT NULL,
      request_fingerprint char(64) NOT NULL,
      fencing_token bigint NOT NULL,
      deployment_intent_id uuid NULL,
      operation_lease_id uuid NULL,
      status varchar(24) NOT NULL,
      acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL,
      released_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (project_id, environment_name)
    );
  `);
}

async function seedFixture(label: string): Promise<Fixture> {
  const projectId = randomUUID();
  const parentIntentId = randomUUID();
  const infrastructureManifestId = randomUUID();
  const initialReleaseDraftId = randomUUID();
  const planOutboxId = randomUUID();
  const operationLeaseId = randomUUID();
  const ownershipId = randomUUID();
  const ownershipLeaseId = randomUUID();
  const canonicalKey = canonicalSha256({ label, operation: "initial-plan" });
  const requestPayload = { schemaVersion: 1, label, immutable: true };
  const requestFingerprint = canonicalSha256(requestPayload);
  const planHash = canonicalSha256({ label, artifact: "terraform-plan" });
  const planInputFingerprint = canonicalSha256({ label, inputs: "frozen" });
  const originalDraft = {
    schemaVersion: 1,
    projectId,
    environmentName: "dev",
    infrastructureManifestId,
    repositoryFullName: "safe/example",
    branch: "main",
    commitSha: "a".repeat(40),
  };
  const draftHash = canonicalSha256(originalDraft);
  const decision = {
    schemaVersion: 1,
    intentId: parentIntentId,
    classification: "infrastructure_change",
    reasonCodes: ["INFRASTRUCTURE_CHANGE_REQUIRED"],
    currentAppliedInfrastructureManifestId: null,
    desiredInfrastructureManifestId: infrastructureManifestId,
    currentStableReleaseManifestId: null,
    desiredReleaseManifestId: null,
    infrastructureChangedPaths: ["foundation"],
    releaseChangedPaths: [],
    approvalRequired: true,
    executionLane: "infrastructure",
    blockedReasons: [],
  };
  await dataSource.query(
    `INSERT INTO deployment_intents (
       id, project_id, environment_name, requested_by_user_id,
       kind, classification, status, client_idempotency_key,
       canonical_idempotency_key, request_fingerprint, request_payload,
       decision, infrastructure_manifest_id, received_at, planned_at,
       enqueued_at, started_at
     ) VALUES (
       $1,$2,'dev',7,'deploy','infrastructure_change','running',$3,
       $4,$5,$6::jsonb,$7::jsonb,$8,
       clock_timestamp()-interval '3 minutes',
       clock_timestamp()-interval '2 minutes',
       clock_timestamp()-interval '1 minute',
       clock_timestamp()-interval '30 seconds'
     )`,
    [
      parentIntentId,
      projectId,
      `initial-plan:${label}`,
      canonicalKey,
      requestFingerprint,
      JSON.stringify(requestPayload),
      JSON.stringify(decision),
      infrastructureManifestId,
    ],
  );
  await dataSource.query(
    `INSERT INTO infrastructure_manifests (
       id, project_id, environment_name, revision, status, spec_hash,
       state_key, plan_artifact_reference, plan_artifact_sha256,
       plan_input_fingerprint, applied_at
     ) VALUES (
       $1,$2,'dev',1,'planned',$3,$4,$5::jsonb,$6,$7,NULL
     )`,
    [
      infrastructureManifestId,
      projectId,
      canonicalSha256({ label, spec: "foundation" }),
      `projects/${projectId}/dev/infrastructure/1.tfstate`,
      JSON.stringify({
        schemaVersion: 1,
        phase: "planned",
        workspaceRef: `project-${projectId.slice(0, 8)}-dev`,
        stateKey: `projects/${projectId}/dev/infrastructure/1.tfstate`,
        inputFingerprint: planInputFingerprint,
        artifactSha256: planHash,
        planSummary: {
          create: 5,
          update: 0,
          replace: 0,
          delete: 0,
          resourceTypes: ["aws_ecr_repository"],
        },
      }),
      planHash,
      planInputFingerprint,
    ],
  );
  await dataSource.query(
    `INSERT INTO initial_release_drafts (
       id, intent_id, project_id, environment_name,
       infrastructure_manifest_id, infrastructure_revision,
       draft_hash, release_draft
     ) VALUES ($1,$2,$3,'dev',$4,1,$5,$6::jsonb)`,
    [
      initialReleaseDraftId,
      parentIntentId,
      projectId,
      infrastructureManifestId,
      draftHash,
      JSON.stringify(originalDraft),
    ],
  );
  const producedAt = new Date(Date.now() - 30_000);
  const planEnvelope = {
    protocol: {
      name: "deployguard.worker",
      schemaVersion: 1,
      messageType: "intent.infrastructure.plan",
      minimumWorkerProtocol: 1,
      maximumWorkerProtocol: 1,
    },
    producer: {
      service: "deployguard-api",
      serviceVersion: "test",
      gitSha: "test-sha",
      producedAt: producedAt.toISOString(),
    },
    identity: {
      intentId: parentIntentId,
      projectId,
      environmentName: "dev",
      pipelineRunId: null,
      destroyOperationId: null,
      infrastructureManifestId,
      releaseManifestId: null,
    },
    routing: {
      lane: "infrastructure",
      operation: "plan",
      queue: "deployguard-infrastructure-v1",
    },
    idempotency: {
      canonicalKey,
      payloadSha256: "0".repeat(64),
      attempt: 1,
      replayOfJobId: null,
    },
    execution: {
      mode: "full",
      resumeFromStage: null,
      reusableCheckpointIds: [],
      invalidatedCheckpointIds: [],
      reasonCodes: ["INFRASTRUCTURE_CHANGE_REQUIRED"],
      fencingTokenRequired: true,
    },
    trace: {
      correlationId: parentIntentId,
      causationId: null,
      actorUserId: 7,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as DeployGuardWorkerEnvelopeV1;
  planEnvelope.idempotency.payloadSha256 = canonicalSha256(
    workerEnvelopePayloadForHash(planEnvelope),
  );
  await dataSource.query(
    `INSERT INTO orchestration_outbox (
       id, intent_id, aggregate_type, aggregate_id, event_type,
       worker_envelope, payload_sha256, status, attempt_count,
       claimed_by, claim_expires_at, claim_fencing_token,
       published_job_id, published_at
     ) VALUES (
       $1,$2,'deployment_intent',$2,'intent.infrastructure.plan',
       $3::jsonb,$4,'published',1,NULL,NULL,1,$5,clock_timestamp()
     )`,
    [
      planOutboxId,
      parentIntentId,
      JSON.stringify(planEnvelope),
      planEnvelope.idempotency.payloadSha256,
      workerEnvelopeJobId(planEnvelope),
    ],
  );
  await dataSource.query(
    `INSERT INTO project_operation_leases (
       id, project_id, environment_name, lane, scope, intent_id,
       owner_worker_id, fencing_token, status, expires_at, metadata
     ) VALUES (
       $1,$2,'dev','infrastructure','plan',$3,
       'infrastructure:test-worker',11,'heartbeat_active',
       clock_timestamp()+interval '5 minutes',$4::jsonb
     )`,
    [
      operationLeaseId,
      projectId,
      parentIntentId,
      JSON.stringify({
        logicalJobId: workerEnvelopeJobId(planEnvelope),
        messageType: "intent.infrastructure.plan",
      }),
    ],
  );
  await dataSource.query(
    `INSERT INTO project_release_lane_ownerships (
       id, project_id, environment_name, owner_lane, lease_id, actor_id,
       idempotency_key, request_fingerprint, fencing_token,
       deployment_intent_id, operation_lease_id, status, expires_at
     ) VALUES (
       $1,$2,'dev','v1',$3,'infrastructure:test-worker',
       $4,$5,17,$6,$7,'heartbeat_active',
       clock_timestamp()+interval '5 minutes'
     )`,
    [
      ownershipId,
      projectId,
      ownershipLeaseId,
      canonicalSha256({ label, ownership: true }),
      canonicalSha256({ label, ownershipRequest: true }),
      parentIntentId,
      operationLeaseId,
    ],
  );
  const input = {
    parentIntentId,
    parentCanonicalIdempotencyKey: canonicalKey,
    parentRequestFingerprint: requestFingerprint,
    infrastructureManifestId,
    initialReleaseDraftId,
    planOutboxId,
    planArtifactSha256: planHash,
    planInputFingerprint,
    operationLeaseId,
    operationWorkerId: "infrastructure:test-worker",
    operationFencingToken: "11",
    ownershipId,
    ownershipLeaseId,
    ownershipActorId: "infrastructure:test-worker",
    ownershipFencingToken: "17",
  };
  return {
    projectId,
    parentIntentId,
    infrastructureManifestId,
    initialReleaseDraftId,
    planOutboxId,
    operationLeaseId,
    ownershipId,
    ownershipLeaseId,
    canonicalKey,
    requestFingerprint,
    planHash,
    planInputFingerprint,
    draftHash,
    originalDraft,
    input,
  };
}

async function main() {
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.initialize();
  try {
    await setup();
    const fixture = await seedFixture("success");
    const results = await Promise.all([
      service.complete(fixture.input),
      service.complete(fixture.input),
    ]);
    assert.equal(results[0].applyIntentId, results[1].applyIntentId);
    assert.equal(results[0].applyOutboxId, results[1].applyOutboxId);
    assert.deepEqual(
      results.map((result) => result.replayed).sort(),
      [false, true],
    );

    const [parent] = await dataSource.query(
      `SELECT status, completed_at FROM deployment_intents WHERE id = $1`,
      [fixture.parentIntentId],
    );
    assert.equal(parent.status, "plan_completed");
    assert.equal(parent.completed_at, null);
    const children = await dataSource.query(
      `SELECT id, kind, classification, status, decision,
              infrastructure_manifest_id, release_manifest_id, request_payload
       FROM deployment_intents
       WHERE request_payload->>'parentPlanIntentId' = $1`,
      [fixture.parentIntentId],
    );
    assert.equal(children.length, 1);
    assert.equal(children[0].kind, "apply");
    assert.equal(children[0].status, "planned");
    assert.equal(children[0].decision.approvalRequired, true);
    assert.equal(
      children[0].infrastructure_manifest_id,
      fixture.infrastructureManifestId,
    );
    assert.equal(children[0].release_manifest_id, null);
    const terminalOutbox = new TerminalOutboxPolicyService();
    await dataSource.transaction("SERIALIZABLE", async (manager) => {
      assert.deepEqual(
        await terminalOutbox.dispatchState(manager, fixture.parentIntentId),
        { state: "not_dispatchable", intentStatus: "plan_completed" },
      );
      assert.deepEqual(
        await terminalOutbox.dispatchState(manager, children[0].id),
        { state: "dispatchable", intentStatus: "planned" },
      );
    });
    const applyOutboxes = await dataSource.query(
      `SELECT status, attempt_count, claimed_by, claim_expires_at,
              published_job_id, published_at, event_type
       FROM orchestration_outbox
       WHERE intent_id = $1`,
      [children[0].id],
    );
    assert.deepEqual(applyOutboxes.map((row) => ({
      status: row.status,
      attempts: row.attempt_count,
      claimedBy: row.claimed_by,
      claimExpiresAt: row.claim_expires_at,
      publishedJobId: row.published_job_id,
      publishedAt: row.published_at,
      eventType: row.event_type,
    })), [{
      status: "pending",
      attempts: 0,
      claimedBy: null,
      claimExpiresAt: null,
      publishedJobId: null,
      publishedAt: null,
      eventType: "intent.infrastructure.apply",
    }]);
    const [originalOutbox] = await dataSource.query(
      `SELECT status, attempt_count, published_job_id, published_at
       FROM orchestration_outbox WHERE id = $1`,
      [fixture.planOutboxId],
    );
    assert.equal(originalOutbox.status, "published");
    assert.equal(originalOutbox.attempt_count, 1);
    assert.ok(originalOutbox.published_job_id);
    assert.ok(originalOutbox.published_at);
    const [manifest] = await dataSource.query(
      `SELECT status, plan_artifact_sha256, applied_at
       FROM infrastructure_manifests WHERE id = $1`,
      [fixture.infrastructureManifestId],
    );
    assert.equal(manifest.status, "planned");
    assert.equal(manifest.plan_artifact_sha256, fixture.planHash);
    assert.equal(manifest.applied_at, null);
    const [draft] = await dataSource.query(
      `SELECT draft_hash, release_draft FROM initial_release_drafts
       WHERE id = $1`,
      [fixture.initialReleaseDraftId],
    );
    assert.equal(draft.draft_hash, fixture.draftHash);
    assert.deepEqual(draft.release_draft, fixture.originalDraft);
    const [lease] = await dataSource.query(
      `SELECT status, released_at FROM project_operation_leases WHERE id = $1`,
      [fixture.operationLeaseId],
    );
    const [ownership] = await dataSource.query(
      `SELECT status, released_at, deployment_intent_id, operation_lease_id
       FROM project_release_lane_ownerships WHERE id = $1`,
      [fixture.ownershipId],
    );
    assert.equal(lease.status, "released");
    assert.ok(lease.released_at);
    assert.equal(ownership.status, "released");
    assert.ok(ownership.released_at);
    assert.equal(ownership.deployment_intent_id, fixture.parentIntentId);
    assert.equal(ownership.operation_lease_id, fixture.operationLeaseId);

    await assert.rejects(
      () => service.complete({
        ...fixture.input,
        planArtifactSha256: "f".repeat(64),
      }),
      (error: unknown) =>
        error instanceof InfrastructurePlanCompletionContinuationError
        && error.code
          === "INFRASTRUCTURE_PLAN_CONTINUATION_IMMUTABLE_EVIDENCE_CONFLICT",
    );
    assert.equal(
      Number((await dataSource.query(
        `SELECT COUNT(*)::int AS count
         FROM deployment_intents
         WHERE request_payload->>'parentPlanIntentId' = $1`,
        [fixture.parentIntentId],
      ))[0].count),
      1,
    );

    const stale = await seedFixture("stale");
    await assert.rejects(
      () => service.complete({
        ...stale.input,
        operationFencingToken: "12",
      }),
      (error: unknown) =>
        error instanceof InfrastructurePlanCompletionContinuationError
        && error.code === "INFRASTRUCTURE_PLAN_CONTINUATION_FENCE_LOST",
    );
    const [staleParent] = await dataSource.query(
      `SELECT status FROM deployment_intents WHERE id = $1`,
      [stale.parentIntentId],
    );
    assert.equal(staleParent.status, "running");
    assert.equal(
      Number((await dataSource.query(
        `SELECT COUNT(*)::int AS count
         FROM deployment_intents
         WHERE request_payload->>'parentPlanIntentId' = $1`,
        [stale.parentIntentId],
      ))[0].count),
      0,
    );

    assert.equal(
      Number((await dataSource.query(
        `SELECT COUNT(*)::int AS count
         FROM project_operation_leases
         WHERE intent_id = $1 AND status IN ('acquired','heartbeat_active')`,
        [fixture.parentIntentId],
      ))[0].count),
      0,
    );
    assert.equal(
      Number((await dataSource.query(
        `SELECT COUNT(*)::int AS count
         FROM project_release_lane_ownerships
         WHERE project_id = $1 AND status IN ('acquired','heartbeat_active')`,
        [fixture.projectId],
      ))[0].count),
      0,
    );

    const immutableConflict = await seedFixture("immutable-conflict");
    await dataSource.query(
      `UPDATE initial_release_drafts
       SET release_draft = release_draft || '{"unexpected":"change"}'::jsonb
       WHERE id = $1`,
      [immutableConflict.initialReleaseDraftId],
    );
    await assert.rejects(
      () => service.complete(immutableConflict.input),
      (error: unknown) =>
        error instanceof InfrastructurePlanCompletionContinuationError
        && error.code
          === "INFRASTRUCTURE_PLAN_CONTINUATION_IMMUTABLE_EVIDENCE_CONFLICT",
    );
    assert.equal(
      Number((await dataSource.query(
        `SELECT COUNT(*)::int AS count
         FROM deployment_intents
         WHERE request_payload->>'parentPlanIntentId' = $1`,
        [immutableConflict.parentIntentId],
      ))[0].count),
      0,
    );

    const terminal = await seedFixture("terminal");
    await dataSource.query(
      `UPDATE deployment_intents
       SET status = 'failed', completed_at = clock_timestamp()
       WHERE id = $1`,
      [terminal.parentIntentId],
    );
    await assert.rejects(
      () => service.complete(terminal.input),
      (error: unknown) =>
        error instanceof InfrastructurePlanCompletionContinuationError
        && error.code === "INFRASTRUCTURE_PLAN_CONTINUATION_PARENT_INVALID",
    );
    assert.equal(
      Number((await dataSource.query(
        `SELECT COUNT(*)::int AS count
         FROM deployment_intents
         WHERE request_payload->>'parentPlanIntentId' = $1`,
        [terminal.parentIntentId],
      ))[0].count),
      0,
    );

    const continuationConflict = await seedFixture("continuation-conflict");
    const conflictingApplyId = randomUUID();
    const conflictingPayload = {
      schemaVersion: 1,
      operation: "infrastructure_apply_continuation",
      parentPlanIntentId: continuationConflict.parentIntentId,
      incompatible: true,
    };
    await dataSource.query(
      `INSERT INTO deployment_intents (
         id, project_id, environment_name, requested_by_user_id,
         kind, classification, status, client_idempotency_key,
         canonical_idempotency_key, request_fingerprint, request_payload,
         decision, infrastructure_manifest_id, received_at, planned_at
       ) VALUES (
         $1,$2,'dev',7,'apply','infrastructure_change','planned',
         'conflicting-continuation',$3,$4,$5::jsonb,$6::jsonb,$7,
         clock_timestamp(),clock_timestamp()
       )`,
      [
        conflictingApplyId,
        continuationConflict.projectId,
        canonicalSha256({ conflict: true }),
        canonicalSha256(conflictingPayload),
        JSON.stringify(conflictingPayload),
        JSON.stringify({
          approvalRequired: true,
          executionLane: "infrastructure",
        }),
        continuationConflict.infrastructureManifestId,
      ],
    );
    await assert.rejects(
      () => service.complete(continuationConflict.input),
      (error: unknown) =>
        error instanceof InfrastructurePlanCompletionContinuationError
        && error.code === "INFRASTRUCTURE_PLAN_CONTINUATION_CONFLICT",
    );
    assert.equal(
      Number((await dataSource.query(
        `SELECT COUNT(*)::int AS count
         FROM deployment_intents
         WHERE request_payload->>'parentPlanIntentId' = $1`,
        [continuationConflict.parentIntentId],
      ))[0].count),
      1,
    );
    const [conflictingParent] = await dataSource.query(
      `SELECT status FROM deployment_intents WHERE id = $1`,
      [continuationConflict.parentIntentId],
    );
    assert.equal(conflictingParent.status, "running");

    const source = readFileSync(
      join(
        __dirname,
        "../src/orchestration-contracts/infrastructure/infrastructure-plan-completion-continuation.service.ts",
      ),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /TerraformRunnerService|DurableOutboxDispatcherService|BullMQ|ECSClient|ECRClient|Docker|PipelineService/,
    );
    assert.doesNotMatch(source, /\.publish\(|\.dispatchExact\(|\.plan\(|\.apply\(/);
    console.log(
      "Infrastructure plan-completion continuation PostgreSQL verification passed",
    );
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.destroy();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
