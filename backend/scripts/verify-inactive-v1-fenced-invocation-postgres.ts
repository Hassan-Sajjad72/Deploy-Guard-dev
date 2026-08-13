import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { InfrastructureSpecV1 } from "../src/orchestration-contracts/contracts/infrastructure-manifest.types";
import { ReleaseSpecV1 } from "../src/orchestration-contracts/contracts/release-manifest.types";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";
import { workerEnvelopePayloadForHash } from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import { CreateWorkerCapabilityRegistry1760000037000 } from "../src/migrations/1760000037000-CreateWorkerCapabilityRegistry";
import { CreateDeploymentSideEffectJournal1760000039000 } from "../src/migrations/1760000039000-CreateDeploymentSideEffectJournal";
import { InactiveV1FencedInvocationService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-fenced-invocation.service";
import { InactiveV1PreExecutionOwnershipService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-pre-execution-ownership.service";
import { InactiveV1WorkerRuntimeService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.service";
import {
  ExecutableV1MessageType,
  V1WorkerCapabilityIdentity,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.types";
import {
  V1FencedPlaceholderHandler,
  V1FencedPlaceholderHandlerContext,
  V1FencedPlaceholderOutcome,
} from "../src/orchestration-contracts/worker-runtime/v1-fenced-invocation.types";
import {
  buildV1FencedPlaceholderHandlerRegistry,
  V1_FENCED_PLACEHOLDER_HANDLERS,
} from "../src/orchestration-contracts/worker-runtime/v1-placeholder-handlers";
import { V1WorkerCapabilityService } from "../src/orchestration-contracts/worker-runtime/v1-worker-capability.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session6_3_invocation_test_${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) {
  throw new Error("Unsafe test schema identifier.");
}

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

const routes: Record<
  ExecutableV1MessageType,
  {
    role: "release" | "infrastructure" | "deletion";
    lane: "release" | "infrastructure" | "deletion";
    operation: "execute" | "plan" | "apply" | "destroy";
    queue: string;
    classification: "release_only" | "infrastructure_change" | "deletion";
  }
> = {
  "intent.release.execute": {
    role: "release",
    lane: "release",
    operation: "execute",
    queue: "deployguard-release-v1",
    classification: "release_only",
  },
  "intent.infrastructure.plan": {
    role: "infrastructure",
    lane: "infrastructure",
    operation: "plan",
    queue: "deployguard-infrastructure-v1",
    classification: "infrastructure_change",
  },
  "intent.infrastructure.apply": {
    role: "infrastructure",
    lane: "infrastructure",
    operation: "apply",
    queue: "deployguard-infrastructure-v1",
    classification: "infrastructure_change",
  },
  "intent.deletion.execute": {
    role: "deletion",
    lane: "deletion",
    operation: "destroy",
    queue: "deployguard-deletion-v1",
    classification: "deletion",
  },
};

const workers: Record<string, V1WorkerCapabilityIdentity> = {
  releaseA: {
    workerId: `release-a:${suffix}`,
    role: "release",
    supportedMessageTypes: ["intent.release.execute"],
    serviceVersion: "session6.3-test",
    gitSha: "test",
    heartbeatTtlMs: 120_000,
  },
  releaseB: {
    workerId: `release-b:${suffix}`,
    role: "release",
    supportedMessageTypes: ["intent.release.execute"],
    serviceVersion: "session6.3-test",
    gitSha: "test",
    heartbeatTtlMs: 120_000,
  },
  infrastructure: {
    workerId: `infrastructure:${suffix}`,
    role: "infrastructure",
    supportedMessageTypes: [
      "intent.infrastructure.plan",
      "intent.infrastructure.apply",
    ],
    serviceVersion: "session6.3-test",
    gitSha: "test",
    heartbeatTtlMs: 120_000,
  },
  deletion: {
    workerId: `deletion:${suffix}`,
    role: "deletion",
    supportedMessageTypes: ["intent.deletion.execute"],
    serviceVersion: "session6.3-test",
    gitSha: "test",
    heartbeatTtlMs: 120_000,
  },
};

const infrastructureSpec: InfrastructureSpecV1 = {
  region: "us-east-1",
  terraformTemplateVersion: "session6.3",
  network: {
    topology: "managed_vpc",
    availabilityZoneCount: 2,
    publicSubnets: true,
    privateSubnets: true,
    natMode: "single",
  },
  registry: {
    managedEcrRepository: true,
    immutableTags: true,
    lifecyclePolicyHash: null,
  },
  ecsFoundation: {
    clusterMode: "shared_project",
    serviceName: "session-6-3",
    launchType: "fargate",
    capacityProviders: ["FARGATE"],
  },
  ingress: {
    enabled: true,
    protocol: "HTTP",
    containerPort: 3000,
    targetGroupPort: 3000,
    healthCheckPath: "/health",
    healthCheckProtocol: "HTTP",
  },
  database: {
    mode: "none",
    engine: null,
    tierRevision: null,
    persistence: false,
    externalTlsRequired: null,
  },
  storage: {
    efsRequired: false,
    accessPointRequired: false,
    encrypted: true,
    backupRequired: false,
  },
  discovery: {
    cloudMapRequired: false,
    namespace: null,
  },
  observability: {
    cloudWatchLogs: true,
    cloudWatchMetrics: true,
    prometheus: false,
  },
  iamPolicyRevision: "v1",
  tags: { managedBy: "DeployGuard" },
};

const releaseSpec: ReleaseSpecV1 = {
  source: {
    repositoryFullName: "deployguard/session-6-3",
    branch: "main",
    commitSha: "a".repeat(40),
    appRoot: ".",
  },
  build: {
    dockerStrategy: "generated",
    dockerTemplate: "node-server",
    buildCommand: "npm run build",
    outputDirectory: null,
    buildArgumentNames: [],
  },
  runtime: {
    imageUri: null,
    imageDigest: null,
    command: "node dist/main.js",
    containerPort: 3000,
    cpu: 256,
    memory: 512,
    plainVariableNames: ["NODE_ENV"],
    secretReferenceNames: ["DATABASE_URL"],
    serviceBindingRevisions: [],
  },
  health: {
    path: "/health",
    expectedPort: 3000,
    gracePeriodSeconds: 30,
  },
};

async function createSchema() {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.initialize();
  await dataSource.query(`
    CREATE TABLE projects (
      id uuid PRIMARY KEY,
      deletion_fence_token bigint,
      deletion_intent_id uuid,
      deletion_started_at timestamptz
    )
  `);
  await dataSource.query(`
    CREATE TABLE infrastructure_manifests (
      id uuid PRIMARY KEY,
      schema_version integer NOT NULL,
      project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL,
      revision bigint NOT NULL,
      parent_manifest_id uuid,
      created_by_intent_id uuid,
      created_by_user_id integer,
      origin varchar(32) NOT NULL,
      status varchar(32) NOT NULL,
      spec_hash char(64) NOT NULL,
      terraform_template_version varchar(128) NOT NULL,
      state_backend varchar(16) NOT NULL,
      state_key varchar(512) NOT NULL,
      desired_spec jsonb NOT NULL,
      change_set jsonb NOT NULL,
      requires_terraform boolean NOT NULL
    )
  `);
  await dataSource.query(`
    CREATE TABLE release_manifests (
      id uuid PRIMARY KEY,
      schema_version integer NOT NULL,
      project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL,
      revision bigint NOT NULL,
      parent_manifest_id uuid,
      previous_stable_manifest_id uuid,
      infrastructure_manifest_id uuid NOT NULL,
      created_by_intent_id uuid,
      pipeline_run_id uuid,
      deployment_contract_id uuid,
      configuration_snapshot_id uuid,
      origin varchar(32) NOT NULL,
      status varchar(32) NOT NULL,
      spec_hash char(64) NOT NULL,
      repository_full_name varchar NOT NULL,
      branch varchar NOT NULL,
      commit_sha varchar NOT NULL,
      app_root varchar NOT NULL,
      deployment_contract_hash char(64) NOT NULL,
      configuration_fingerprint char(64) NOT NULL,
      build_fingerprint char(64) NOT NULL,
      runtime_fingerprint char(64) NOT NULL,
      release_spec jsonb NOT NULL
    )
  `);
  await dataSource.query(`
    CREATE TABLE deployment_intents (
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL REFERENCES projects(id),
      environment_name varchar(64) NOT NULL,
      classification varchar(32),
      status varchar(32) NOT NULL,
      canonical_idempotency_key char(64) NOT NULL,
      request_fingerprint char(64),
      infrastructure_manifest_id uuid,
      release_manifest_id uuid,
      pipeline_run_id uuid,
      destroy_operation_id uuid,
      failure_code varchar(128),
      failure_message text,
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
  await dataSource.query(`
    CREATE TABLE project_operation_leases (
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL REFERENCES projects(id),
      environment_name varchar(64) NOT NULL,
      lane varchar(24) NOT NULL,
      scope varchar(32) NOT NULL,
      intent_id uuid NOT NULL REFERENCES deployment_intents(id),
      pipeline_run_id uuid,
      destroy_operation_id uuid,
      owner_worker_id varchar NOT NULL,
      fencing_token bigint NOT NULL,
      status varchar(24) NOT NULL,
      acquired_at timestamptz NOT NULL,
      heartbeat_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      released_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )
  `);
  await dataSource.query(`
    CREATE UNIQUE INDEX "UQ_project_operation_lease_active_scope"
    ON project_operation_leases (
      project_id, environment_name, lane, scope
    )
    WHERE status IN ('acquired','heartbeat_active')
  `);
  await dataSource.query(`
    CREATE UNIQUE INDEX "UQ_project_operation_lease_fencing_token"
    ON project_operation_leases (
      project_id, environment_name, fencing_token
    )
  `);
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await new CreateWorkerCapabilityRegistry1760000037000().up(runner);
    await new CreateDeploymentSideEffectJournal1760000039000().up(runner);
  } finally {
    await runner.release();
  }
}

function buildEnvelope(input: {
  messageType: ExecutableV1MessageType;
  intentId: string;
  projectId: string;
  infrastructureManifestId: string | null;
  releaseManifestId: string | null;
}) {
  const route = routes[input.messageType];
  const canonicalKey = createHash("sha256")
    .update(`intent:${input.intentId}`)
    .digest("hex");
  const envelope = {
    protocol: {
      name: "deployguard.worker",
      schemaVersion: 1,
      messageType: input.messageType,
      minimumWorkerProtocol: 1,
      maximumWorkerProtocol: 1,
    },
    producer: {
      service: "deployguard-outbox-dispatcher",
      serviceVersion: "session6.3-test",
      gitSha: "test",
      producedAt: new Date().toISOString(),
    },
    identity: {
      intentId: input.intentId,
      projectId: input.projectId,
      environmentName: "production",
      pipelineRunId: null,
      destroyOperationId: null,
      infrastructureManifestId: input.infrastructureManifestId,
      releaseManifestId: input.releaseManifestId,
    },
    routing: {
      lane: route.lane,
      operation: route.operation,
      queue: route.queue,
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
      reasonCodes: ["SESSION_6_3_TEST"],
      fencingTokenRequired: true,
    },
    trace: {
      correlationId: input.intentId,
      causationId: null,
      actorUserId: 1,
    },
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  } as DeployGuardWorkerEnvelopeV1;
  envelope.idempotency.payloadSha256 = canonicalSha256(
    workerEnvelopePayloadForHash(envelope),
  );
  return envelope;
}

async function seedIntent(
  messageType: ExecutableV1MessageType,
  options: {
    status?: string;
    createdAt?: Date;
    malformedReleaseManifest?: boolean;
  } = {},
) {
  const projectId = randomUUID();
  const intentId = randomUUID();
  await dataSource.query(`INSERT INTO projects (id) VALUES ($1)`, [projectId]);

  const infrastructureManifestId =
    messageType === "intent.deletion.execute" ? null : randomUUID();
  const releaseManifestId =
    messageType === "intent.release.execute" ? randomUUID() : null;
  if (infrastructureManifestId) {
    await dataSource.query(
      `INSERT INTO infrastructure_manifests (
         id, schema_version, project_id, environment_name, revision,
         parent_manifest_id, created_by_intent_id, created_by_user_id,
         origin, status, spec_hash, terraform_template_version,
         state_backend, state_key, desired_spec, change_set,
         requires_terraform
       ) VALUES (
         $1, 1, $2, 'production', 1, NULL, NULL, 1,
         'planner', 'desired', $3, 'session6.3', 's3',
         $4, $5::jsonb, $6::jsonb, true
       )`,
      [
        infrastructureManifestId,
        projectId,
        canonicalSha256(infrastructureSpec),
        `projects/${projectId}/terraform.tfstate`,
        JSON.stringify(infrastructureSpec),
        JSON.stringify({
          fromManifestId: null,
          changedPaths: [],
          categories: [],
          destructivePaths: [],
          requiresApproval: false,
          reasonCodes: ["SESSION_6_3_TEST"],
        }),
      ],
    );
  }
  if (releaseManifestId && infrastructureManifestId) {
    const persistedReleaseSpec = options.malformedReleaseManifest
      ? { ...releaseSpec, unexpectedMutableField: true }
      : releaseSpec;
    await dataSource.query(
      `INSERT INTO release_manifests (
         id, schema_version, project_id, environment_name, revision,
         parent_manifest_id, previous_stable_manifest_id,
         infrastructure_manifest_id, created_by_intent_id, pipeline_run_id,
         deployment_contract_id, configuration_snapshot_id, origin, status,
         spec_hash, repository_full_name, branch, commit_sha, app_root,
         deployment_contract_hash, configuration_fingerprint,
         build_fingerprint, runtime_fingerprint, release_spec
       ) VALUES (
         $1, 1, $2, 'production', 1, NULL, NULL, $3, NULL, NULL,
         NULL, NULL, 'planner', 'desired', $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13::jsonb
       )`,
      [
        releaseManifestId,
        projectId,
        infrastructureManifestId,
        canonicalSha256(releaseSpec),
        releaseSpec.source.repositoryFullName,
        releaseSpec.source.branch,
        releaseSpec.source.commitSha,
        releaseSpec.source.appRoot,
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
        "e".repeat(64),
        JSON.stringify(persistedReleaseSpec),
      ],
    );
  }
  const envelope = buildEnvelope({
    messageType,
    intentId,
    projectId,
    infrastructureManifestId,
    releaseManifestId,
  });
  await dataSource.query(
    `INSERT INTO deployment_intents (
       id, project_id, environment_name, classification, status,
       canonical_idempotency_key, infrastructure_manifest_id,
       release_manifest_id, pipeline_run_id, destroy_operation_id,
       created_at
     ) VALUES (
       $1, $2, 'production', $3, $4, $5, $6, $7, NULL, NULL, $8
     )`,
    [
      intentId,
      projectId,
      routes[messageType].classification,
      options.status || "enqueued",
      envelope.idempotency.canonicalKey,
      infrastructureManifestId,
      releaseManifestId,
      options.createdAt || new Date(),
    ],
  );
  if (messageType === "intent.deletion.execute") {
    await dataSource.query(
      `UPDATE projects
       SET deletion_fence_token = 1,
           deletion_intent_id = $2,
           deletion_started_at = clock_timestamp()
       WHERE id = $1`,
      [projectId, intentId],
    );
  }
  return {
    envelope,
    projectId,
    intentId,
    infrastructureManifestId,
    releaseManifestId,
  };
}

function invocationInput(
  worker: V1WorkerCapabilityIdentity,
  envelope: DeployGuardWorkerEnvelopeV1,
) {
  return {
    workerId: worker.workerId,
    queueName: envelope.routing.queue,
    envelope,
    leaseTtlMs: 60_000,
  };
}

function customRegistry(
  invoke: (
    context: V1FencedPlaceholderHandlerContext<"intent.release.execute">,
  ) => Promise<V1FencedPlaceholderOutcome> | V1FencedPlaceholderOutcome,
) {
  const replacement: V1FencedPlaceholderHandler<
    "intent.release.execute"
  > = {
    messageType: "intent.release.execute",
    sideEffectPolicy: "deployguard.side-effect/v1",
    invoke,
  };
  return buildV1FencedPlaceholderHandlerRegistry(
    V1_FENCED_PLACEHOLDER_HANDLERS.map((handler) =>
      handler.messageType === "intent.release.execute"
        ? replacement
        : handler
    ) as readonly V1FencedPlaceholderHandler[],
  );
}

async function intentRow(intentId: string) {
  const [row] = await dataSource.query(
    `SELECT status, started_at AS "startedAt",
            completed_at AS "completedAt", failure_code AS "failureCode",
            failure_message AS "failureMessage"
     FROM deployment_intents WHERE id = $1`,
    [intentId],
  );
  return row;
}

async function leaseRows(intentId: string) {
  return dataSource.query(
    `SELECT id, owner_worker_id AS "ownerWorkerId",
            fencing_token AS "fencingToken", status
     FROM project_operation_leases
     WHERE intent_id = $1 ORDER BY fencing_token`,
    [intentId],
  );
}

async function run() {
  await admin.initialize();
  try {
    await createSchema();
    const capabilities = new V1WorkerCapabilityService(dataSource);
    const runtime = new InactiveV1WorkerRuntimeService(
      dataSource,
      capabilities,
    );
    const ownership = new InactiveV1PreExecutionOwnershipService(
      dataSource,
      runtime,
    );
    for (const worker of Object.values(workers)) {
      await capabilities.register(worker);
    }

    const defaultInvocation = new InactiveV1FencedInvocationService(
      dataSource,
      ownership,
      buildV1FencedPlaceholderHandlerRegistry(),
    );
    for (const messageType of Object.keys(routes) as
      ExecutableV1MessageType[]) {
      const fixture = await seedIntent(messageType);
      const worker = messageType === "intent.release.execute"
        ? workers.releaseA
        : messageType === "intent.deletion.execute"
          ? workers.deletion
          : workers.infrastructure;
      const result = await defaultInvocation.invoke(
        invocationInput(worker, fixture.envelope),
      );
      assert.equal(
        result.disposition,
        messageType === "intent.deletion.execute" ? "released" : "completed",
      );
      if (result.disposition === "completed") {
        assert.equal(result.handler, messageType);
        assert.equal(result.workerId, worker.workerId);
      }
      assert.equal(
        (await intentRow(fixture.intentId)).status,
        messageType === "intent.deletion.execute" ? "enqueued" : "completed",
      );
      assert.equal((await leaseRows(fixture.intentId))[0].status, "released");
    }

    let captured:
      | V1FencedPlaceholderHandlerContext<"intent.release.execute">
      | undefined;
    let invocationCount = 0;
    const exactFixture = await seedIntent("intent.release.execute");
    const exactInvocation = new InactiveV1FencedInvocationService(
      dataSource,
      ownership,
      customRegistry((context) => {
        captured = context;
        invocationCount += 1;
        return { outcome: "success" };
      }),
    );
    const exactResult = await exactInvocation.invoke(
      invocationInput(workers.releaseA, exactFixture.envelope),
    );
    assert.equal(exactResult.disposition, "completed");
    assert.equal(invocationCount, 1);
    assert.ok(captured);
    assert.equal(captured.workerId, workers.releaseA.workerId);
    assert.equal(captured.leaseId, exactResult.disposition === "completed"
      ? exactResult.leaseId
      : null);
    assert.equal(captured.fencingToken, exactResult.disposition === "completed"
      ? exactResult.fencingToken
      : null);
    assert.equal(captured.intent.id, exactFixture.intentId);
    assert.equal(
      captured.infrastructureManifest?.id,
      exactFixture.infrastructureManifestId,
    );
    assert.equal(captured.releaseManifest?.id, exactFixture.releaseManifestId);
    assert.equal(
      captured.releaseManifest?.infrastructureManifestId,
      exactFixture.infrastructureManifestId,
    );
    assert.equal(Object.isFrozen(captured.infrastructureManifest), true);
    assert.equal(
      Object.isFrozen(captured.infrastructureManifest?.desiredSpec),
      true,
    );
    assert.equal(Object.isFrozen(captured.releaseManifest), true);
    assert.equal(Object.isFrozen(captured.releaseManifest?.releaseSpec), true);
    assert.deepEqual(captured.route, {
      messageType: "intent.release.execute",
      queueName: "deployguard-release-v1",
      lane: "release",
      operation: "execute",
    });
    assert.notEqual(captured.envelope, exactFixture.envelope);
    assert.deepEqual(captured.envelope, exactFixture.envelope);

    const retryable = await seedIntent("intent.release.execute");
    const retryableInvocation = new InactiveV1FencedInvocationService(
      dataSource,
      ownership,
      customRegistry(() => ({ outcome: "retryable" })),
    );
    const retryableResult = await retryableInvocation.invoke(
      invocationInput(workers.releaseA, retryable.envelope),
    );
    assert.equal(retryableResult.disposition, "released");
    assert.equal((await intentRow(retryable.intentId)).status, "enqueued");
    assert.equal((await leaseRows(retryable.intentId))[0].status, "released");

    const terminalFailure = await seedIntent("intent.release.execute");
    const terminalInvocation = new InactiveV1FencedInvocationService(
      dataSource,
      ownership,
      customRegistry(() => ({
        outcome: "terminal_failure",
        safeFailureCode: "CONTRACT_REJECTED",
      })),
    );
    const terminalResult = await terminalInvocation.invoke(
      invocationInput(workers.releaseA, terminalFailure.envelope),
    );
    assert.equal(terminalResult.disposition, "failed");
    const terminalIntent = await intentRow(terminalFailure.intentId);
    assert.equal(terminalIntent.status, "failed");
    assert.equal(terminalIntent.failureCode, "CONTRACT_REJECTED");
    assert.equal(terminalIntent.failureMessage, null);
    assert.equal(
      (await leaseRows(terminalFailure.intentId))[0].status,
      "failed",
    );

    const thrown = await seedIntent("intent.release.execute");
    const thrownInvocation = new InactiveV1FencedInvocationService(
      dataSource,
      ownership,
      customRegistry(() => {
        throw new Error("transport details must not be persisted");
      }),
    );
    const thrownResult = await thrownInvocation.invoke(
      invocationInput(workers.releaseA, thrown.envelope),
    );
    assert.equal(thrownResult.disposition, "failed");
    const thrownIntent = await intentRow(thrown.intentId);
    assert.equal(thrownIntent.status, "failed");
    assert.equal(thrownIntent.failureCode, "PLACEHOLDER_HANDLER_THROWN");
    assert.equal(thrownIntent.failureMessage, null);
    assert.equal((await leaseRows(thrown.intentId))[0].status, "failed");

    let releaseHandler: (() => void) | undefined;
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let duplicateHandlerCount = 0;
    const duplicate = await seedIntent("intent.release.execute");
    const duplicateInvocation = new InactiveV1FencedInvocationService(
      dataSource,
      ownership,
      customRegistry(async () => {
        duplicateHandlerCount += 1;
        handlerStarted();
        await blocked;
        return { outcome: "success" };
      }),
    );
    const firstDelivery = duplicateInvocation.invoke(
      invocationInput(workers.releaseA, duplicate.envelope),
    );
    await started;
    const sameOwnerDuplicate = await duplicateInvocation.invoke(
      invocationInput(workers.releaseA, duplicate.envelope),
    );
    assert.equal(sameOwnerDuplicate.disposition, "idempotent_no_op");
    if (sameOwnerDuplicate.disposition === "idempotent_no_op") {
      assert.equal(
        sameOwnerDuplicate.reason,
        "duplicate_delivery_already_owned",
      );
    }
    const otherOwnerDuplicate = await duplicateInvocation.invoke(
      invocationInput(workers.releaseB, duplicate.envelope),
    );
    assert.equal(otherOwnerDuplicate.disposition, "idempotent_no_op");
    if (otherOwnerDuplicate.disposition === "idempotent_no_op") {
      assert.equal(
        otherOwnerDuplicate.reason,
        "duplicate_delivery_owned_elsewhere",
      );
    }
    assert.equal(duplicateHandlerCount, 1);
    releaseHandler?.();
    assert.equal((await firstDelivery).disposition, "completed");
    assert.equal(duplicateHandlerCount, 1);

    const stale = await seedIntent("intent.release.execute");
    let replacementLeaseId: string | null = null;
    const staleInvocation = new InactiveV1FencedInvocationService(
      dataSource,
      ownership,
      customRegistry(async (context) => {
        await dataSource.query(
          `UPDATE project_operation_leases
           SET expires_at = clock_timestamp() - interval '1 second'
           WHERE id = $1`,
          [context.leaseId],
        );
        const replacement = await ownership.claim(
          invocationInput(workers.releaseB, stale.envelope),
        );
        assert.equal(replacement.disposition, "claimed");
        if (replacement.disposition === "claimed") {
          replacementLeaseId = replacement.lease.leaseId;
          assert.ok(
            BigInt(replacement.lease.fencingToken)
              > BigInt(context.fencingToken),
          );
        }
        return { outcome: "success" };
      }),
    );
    const staleResult = await staleInvocation.invoke(
      invocationInput(workers.releaseA, stale.envelope),
    );
    assert.equal(staleResult.disposition, "idempotent_no_op");
    if (staleResult.disposition === "idempotent_no_op") {
      assert.equal(staleResult.reason, "ownership_lost");
    }
    const staleLeases = await leaseRows(stale.intentId);
    assert.deepEqual(
      staleLeases.map((row: { status: string }) => row.status),
      ["expired", "acquired"],
    );
    assert.equal(
      staleLeases[1].id,
      replacementLeaseId,
    );
    assert.equal((await intentRow(stale.intentId)).status, "running");

    const terminal = await seedIntent("intent.release.execute", {
      status: "completed",
    });
    let terminalHandlerCount = 0;
    const terminalNoOpInvocation = new InactiveV1FencedInvocationService(
      dataSource,
      ownership,
      customRegistry(() => {
        terminalHandlerCount += 1;
        return { outcome: "success" };
      }),
    );
    const terminalNoOp = await terminalNoOpInvocation.invoke(
      invocationInput(workers.releaseA, terminal.envelope),
    );
    assert.equal(terminalNoOp.disposition, "idempotent_no_op");
    assert.equal(terminalHandlerCount, 0);
    assert.equal((await leaseRows(terminal.intentId)).length, 0);

    const superseded = await seedIntent("intent.release.execute", {
      createdAt: new Date(Date.now() - 10_000),
    });
    await dataSource.query(
      `INSERT INTO deployment_intents (
         id, project_id, environment_name, classification, status,
         canonical_idempotency_key, created_at
       ) VALUES (
         $1, $2, 'production', 'release_only', 'completed', $3,
         clock_timestamp()
       )`,
      [randomUUID(), superseded.projectId, "f".repeat(64)],
    );
    const supersededNoOp = await terminalNoOpInvocation.invoke(
      invocationInput(workers.releaseA, superseded.envelope),
    );
    assert.equal(supersededNoOp.disposition, "idempotent_no_op");
    if (supersededNoOp.disposition === "idempotent_no_op") {
      assert.equal(supersededNoOp.reason, "intent_superseded");
    }
    assert.equal(terminalHandlerCount, 0);
    assert.equal((await leaseRows(superseded.intentId)).length, 0);

    const malformed = await seedIntent("intent.release.execute", {
      malformedReleaseManifest: true,
    });
    const malformedResult = await defaultInvocation.invoke(
      invocationInput(workers.releaseA, malformed.envelope),
    );
    assert.equal(malformedResult.disposition, "failed");
    if (malformedResult.disposition === "failed") {
      assert.equal(
        malformedResult.safeFailureCode,
        "INVOCATION_MANIFEST_INVALID",
      );
    }
    assert.equal((await intentRow(malformed.intentId)).status, "failed");
    assert.equal((await leaseRows(malformed.intentId))[0].status, "failed");

    const unsafeSuccess = await seedIntent("intent.release.execute");
    const rawSideEffectError =
      "AccessKey=secret raw SDK payload must not be persisted";
    const unsafeSuccessInvocation = new InactiveV1FencedInvocationService(
      dataSource,
      ownership,
      customRegistry(async (context) => {
        const effect = await context.sideEffects.execute({
          operationId: randomUUID(),
          idempotencyKey: canonicalSha256("session6.6-effect-key"),
          effectType: "test.uncertain.effect",
          inputFingerprint: canonicalSha256("session6.6-effect-input"),
          timeoutMs: 1_000,
          perform: async () => {
            throw new Error(rawSideEffectError);
          },
        });
        assert.equal(effect.disposition, "reconciliation_required");
        return { outcome: "success" };
      }),
    );
    const unsafeSuccessResult = await unsafeSuccessInvocation.invoke(
      invocationInput(workers.releaseA, unsafeSuccess.envelope),
    );
    assert.equal(unsafeSuccessResult.disposition, "failed");
    if (unsafeSuccessResult.disposition === "failed") {
      assert.equal(
        unsafeSuccessResult.safeFailureCode,
        "SIDE_EFFECT_RECONCILIATION_REQUIRED",
      );
    }
    const unsafeSuccessIntent = await intentRow(unsafeSuccess.intentId);
    assert.equal(unsafeSuccessIntent.status, "failed");
    assert.equal(
      unsafeSuccessIntent.failureCode,
      "SIDE_EFFECT_RECONCILIATION_REQUIRED",
    );
    const [unsafeEffect] = await dataSource.query(
      `SELECT status, failure_code AS "failureCode"
       FROM deployment_side_effects WHERE intent_id = $1`,
      [unsafeSuccess.intentId],
    );
    assert.equal(unsafeEffect.status, "uncertain");
    assert.equal(unsafeEffect.failureCode, "SIDE_EFFECT_OUTCOME_UNKNOWN");
    assert.equal(JSON.stringify(unsafeEffect).includes(rawSideEffectError), false);

    const rollback = await seedIntent("intent.release.execute");
    await dataSource.query(`
      CREATE FUNCTION reject_session6_3_failed_transition()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${rollback.intentId}'::uuid
          AND NEW.status = 'failed' THEN
          RAISE EXCEPTION 'simulated invocation finalization failure';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await dataSource.query(`
      CREATE TRIGGER reject_session6_3_failed_transition
      BEFORE UPDATE ON deployment_intents
      FOR EACH ROW EXECUTE FUNCTION reject_session6_3_failed_transition()
    `);
    const rollbackInvocation = new InactiveV1FencedInvocationService(
      dataSource,
      ownership,
      customRegistry(() => {
        throw new Error("simulated handler throw");
      }),
    );
    await assert.rejects(
      rollbackInvocation.invoke(
        invocationInput(workers.releaseA, rollback.envelope),
      ),
      /simulated invocation finalization failure/,
    );
    assert.equal((await intentRow(rollback.intentId)).status, "running");
    assert.equal((await leaseRows(rollback.intentId))[0].status, "acquired");
    await dataSource.query(
      `DROP TRIGGER reject_session6_3_failed_transition
       ON deployment_intents`,
    );
    await dataSource.query(
      `DROP FUNCTION reject_session6_3_failed_transition()`,
    );

    console.log(
      "Inactive v1 fenced invocation isolated PostgreSQL verification passed",
    );
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
    if (admin.isInitialized) {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.destroy();
      }
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
