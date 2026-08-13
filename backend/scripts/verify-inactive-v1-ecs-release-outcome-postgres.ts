import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { InactiveV1EcsReleaseOutcomeStore } from
  "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-outcome.store";
import { V1EcsReleaseOutcomeError } from
  "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-outcome.types";
import {
  InactiveV1StableReleaseProjectionStore,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-stable-release-projection.store";
import {
  CanonicalStableReleaseProjection1760000042000,
} from "../src/migrations/1760000042000-CanonicalStableReleaseProjection";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session7_6_outcome_${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe schema");
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

const healthy = {
  status: "healthy" as const,
  safeCode: "ECS_ROLLOUT_AND_TARGETS_HEALTHY" as const,
  evidenceHash: canonicalSha256("healthy-evidence"),
};
const failed = {
  status: "failed" as const,
  safeCode: "ECS_ROLLOUT_FAILED" as const,
  evidenceHash: canonicalSha256("failed-evidence"),
};

type Scope = Awaited<ReturnType<typeof seedScope>>;

async function setup() {
  await dataSource.query(`
    CREATE TABLE deployment_intents (
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL,
      status varchar(32) NOT NULL
    );
    CREATE TABLE project_operation_leases (
      id uuid PRIMARY KEY,
      intent_id uuid NOT NULL,
      project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL,
      owner_worker_id varchar(160) NOT NULL,
      fencing_token bigint NOT NULL,
      status varchar(32) NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE infrastructure_manifests (
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL,
      revision bigint NOT NULL,
      status varchar(32) NOT NULL,
      terraform_outputs jsonb
    );
    CREATE TABLE release_manifests (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      schema_version integer NOT NULL DEFAULT 1,
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
      image_uri varchar,
      image_digest varchar,
      task_definition_input_hash char(64),
      task_definition_arn varchar,
      initial_service_input_hash char(64),
      initial_service_arn varchar,
      release_spec jsonb NOT NULL,
      health_evidence jsonb,
      failure_code varchar(128),
      failure_message text,
      build_started_at timestamptz,
      built_at timestamptz,
      deployment_started_at timestamptz,
      health_verified_at timestamptz,
      promoted_at timestamptz,
      superseded_at timestamptz,
      rollback_started_at timestamptz,
      rolled_back_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, environment_name, revision)
    );
    CREATE UNIQUE INDEX one_stable_release
      ON release_manifests (project_id, environment_name)
      WHERE status = 'stable';
    CREATE TABLE project_stable_releases (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      project_id uuid NOT NULL,
      release_manifest_id uuid,
      environment_name varchar NOT NULL,
      commit_sha varchar NOT NULL,
      short_commit_sha varchar NOT NULL,
      image_uri varchar NOT NULL,
      task_definition_arn varchar NOT NULL,
      ecs_service_arn varchar,
      health_check_path varchar NOT NULL,
      app_port integer,
      deployed_by_pipeline_run_id uuid,
      deployed_at timestamptz NOT NULL,
      status varchar NOT NULL,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function verifyProjectionMigration() {
  const projectId = randomUUID();
  const releaseManifestId = randomUUID();
  await dataSource.query(
    `INSERT INTO project_stable_releases (
       project_id, release_manifest_id, environment_name, commit_sha,
       short_commit_sha, image_uri, task_definition_arn,
       health_check_path, app_port, deployed_at, status, metadata
     ) VALUES
       ($1,$2,'migration','${"a".repeat(40)}','${"a".repeat(12)}',
        'repository@sha256:${"b".repeat(64)}',
        'arn:aws:ecs:us-east-1:123456789012:task-definition/app:1',
        '/',80,now()-interval '1 minute','stable','{}'::jsonb),
       ($1,$2,'migration','${"c".repeat(40)}','${"c".repeat(12)}',
        'repository@sha256:${"d".repeat(64)}',
        'arn:aws:ecs:us-east-1:123456789012:task-definition/app:2',
        '/',80,now(),'stable','{}'::jsonb)`,
    [projectId, releaseManifestId],
  );
  const migration =
    new CanonicalStableReleaseProjection1760000042000();
  const runner = dataSource.createQueryRunner();
  try {
    await migration.up(runner);
    const rows = await dataSource.query(
      `SELECT status, release_manifest_id AS "releaseManifestId"
       FROM project_stable_releases
       WHERE project_id = $1
       ORDER BY deployed_at`,
      [projectId],
    ) as Array<{ status: string; releaseManifestId: string | null }>;
    assert.equal(rows.filter((row) => row.status === "stable").length, 1);
    assert.equal(
      rows.filter((row) => row.releaseManifestId !== null).length,
      1,
    );
    await migration.up(runner);
    await migration.down(runner);
    await migration.up(runner);
  } finally {
    await runner.release();
  }
}

async function seedScope(options?: {
  candidateStatus?: string;
  withPrevious?: boolean;
}) {
  const projectId = randomUUID();
  const environmentName = "production";
  const intentId = randomUUID();
  const leaseId = randomUUID();
  const infrastructureManifestId = randomUUID();
  const previousStableManifestId = randomUUID();
  const candidateManifestId = randomUUID();
  const workerId = `worker-${projectId.slice(0, 8)}`;
  const taskDefinitionArn =
    "arn:aws:ecs:us-east-1:123456789012:task-definition/app:7";
  const outputs = {
    ecs_cluster_arn:
      "arn:aws:ecs:us-east-1:123456789012:cluster/deployguard",
    ecs_service_arn:
      "arn:aws:ecs:us-east-1:123456789012:service/deployguard/app",
  };
  await dataSource.query(
    `INSERT INTO deployment_intents VALUES ($1,$2,$3,'running')`,
    [
      intentId,
      projectId,
      environmentName,
    ],
  );
  await dataSource.query(
    `INSERT INTO project_operation_leases
     VALUES ($1,$2,$3,$4,$5,1,'heartbeat_active',now()+interval '1 hour')`,
    [
      leaseId,
      intentId,
      projectId,
      environmentName,
      workerId,
    ],
  );
  await dataSource.query(
    `INSERT INTO infrastructure_manifests
     VALUES ($1,$2,$3,4,'applied',$4::jsonb)`,
    [
      infrastructureManifestId,
      projectId,
      environmentName,
      JSON.stringify(outputs),
    ],
  );
  if (options?.withPrevious !== false) {
    await insertRelease({
      id: previousStableManifestId,
      projectId,
      environmentName,
      revision: "8",
      infrastructureManifestId,
      previousStableManifestId: null,
      status: "stable",
      taskDefinitionArn,
      health: true,
    });
  }
  await insertRelease({
    id: candidateManifestId,
    projectId,
    environmentName,
    revision: "9",
    infrastructureManifestId,
    previousStableManifestId: options?.withPrevious === false
      ? null
      : previousStableManifestId,
    status: options?.candidateStatus ?? "health_checking",
    taskDefinitionArn:
      "arn:aws:ecs:us-east-1:123456789012:task-definition/app:9",
    health: false,
  });
  return {
    revision: {
      projectId,
      environmentName,
      releaseManifestId: candidateManifestId,
      releaseRevision: "9",
      infrastructureManifestId,
      infrastructureRevision: "4",
    },
    fence: {
      intentId,
      leaseId,
      workerId,
      fencingToken: "1",
    },
    previousStableManifestId,
    candidateManifestId,
  };
}

async function insertRelease(input: {
  id: string;
  projectId: string;
  environmentName: string;
  revision: string;
  infrastructureManifestId: string;
  previousStableManifestId: string | null;
  status: string;
  taskDefinitionArn: string;
  health: boolean;
}) {
  const hash = canonicalSha256(input.id);
  const releaseSpec = {
    source: {
      repositoryFullName: "example/app",
      branch: "main",
      commitSha: "a".repeat(40),
      appRoot: ".",
    },
    runtime: {
      imageUri: null,
      imageDigest: null,
      command: "npm start",
      containerPort: 3000,
      cpu: 256,
      memory: 512,
      plainVariableNames: [],
      secretReferenceNames: [],
      serviceBindingRevisions: [],
    },
    build: {
      dockerStrategy: "generated",
      dockerTemplate: "node-server-v1",
      buildCommand: "npm run build",
      outputDirectory: null,
      buildArgumentNames: [],
    },
    health: {
      path: "/health",
      expectedPort: 3000,
      gracePeriodSeconds: 60,
    },
  };
  await dataSource.query(
    `INSERT INTO release_manifests (
       id, project_id, environment_name, revision,
       previous_stable_manifest_id, infrastructure_manifest_id,
       origin, status, spec_hash, repository_full_name, branch,
       commit_sha, app_root, deployment_contract_hash,
       configuration_fingerprint, build_fingerprint, runtime_fingerprint,
       image_uri, image_digest, task_definition_input_hash,
       task_definition_arn, release_spec, health_verified_at, promoted_at
     ) VALUES (
       $1,$2,$3,$4::bigint,$5,$6,'planner',$7,$8,'example/app','main',
       $9,'.',$8,$8,$8,$8,$10,$11,$8,$12,$13::jsonb,
       CASE WHEN $14 THEN now() ELSE NULL END,
       CASE WHEN $14 THEN now() ELSE NULL END
     )`,
    [
      input.id,
      input.projectId,
      input.environmentName,
      input.revision,
      input.previousStableManifestId,
      input.infrastructureManifestId,
      input.status,
      hash,
      "a".repeat(40),
      "123456789012.dkr.ecr.us-east-1.amazonaws.com/app:build",
      `sha256:${"b".repeat(64)}`,
      input.taskDefinitionArn,
      JSON.stringify(releaseSpec),
      input.health,
    ],
  );
}

function promotionInput(scope: Scope, key = "c".repeat(64)) {
  return {
    revision: scope.revision,
    idempotencyKey: key,
    inputFingerprint: canonicalSha256({ key, action: "promotion" }),
    verification: healthy,
    fence: scope.fence,
  };
}

function rollbackInput(scope: Scope, key = "d".repeat(64)) {
  return {
    revision: scope.revision,
    idempotencyKey: key,
    inputFingerprint: canonicalSha256({ key, action: "rollback" }),
    candidateVerification: failed,
    fence: scope.fence,
  };
}

async function status(id: string) {
  const rows = await dataSource.query(
    `SELECT status FROM release_manifests WHERE id = $1`,
    [id],
  ) as Array<{ status: string }>;
  return rows[0]?.status;
}

void (async () => {
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.initialize();
  await setup();
  await verifyProjectionMigration();
  const store = new InactiveV1EcsReleaseOutcomeStore(dataSource);
  const projections =
    new InactiveV1StableReleaseProjectionStore(dataSource);

  const promotionScope = await seedScope();
  const [firstPromotion, secondPromotion] = await Promise.all([
    store.promoteCandidate(promotionInput(promotionScope)),
    store.promoteCandidate(promotionInput(promotionScope)),
  ]);
  assert.deepEqual(
    new Set([firstPromotion.disposition, secondPromotion.disposition]),
    new Set(["promoted", "replayed"]),
  );
  assert.equal(await status(promotionScope.candidateManifestId), "stable");
  assert.equal(
    await status(promotionScope.previousStableManifestId),
    "superseded",
  );
  const stableCount = await dataSource.query(
    `SELECT count(*)::int AS count FROM release_manifests
     WHERE project_id = $1 AND environment_name = $2 AND status = 'stable'`,
    [
      promotionScope.revision.projectId,
      promotionScope.revision.environmentName,
    ],
  ) as Array<{ count: number }>;
  assert.equal(stableCount[0].count, 1);
  assert.deepEqual(
    await projections.readLegacyProjection(
      promotionScope.revision.projectId,
      promotionScope.revision.environmentName,
    ),
    await projections.readCanonical(
      promotionScope.revision.projectId,
      promotionScope.revision.environmentName,
    ),
  );
  await dataSource.query(
    `DELETE FROM project_stable_releases
     WHERE project_id = $1 AND environment_name = $2`,
    [
      promotionScope.revision.projectId,
      promotionScope.revision.environmentName,
    ],
  );
  assert.equal(
    (await store.promoteCandidate(
      promotionInput(promotionScope),
    )).disposition,
    "replayed",
  );
  assert.deepEqual(
    await projections.readLegacyProjection(
      promotionScope.revision.projectId,
      promotionScope.revision.environmentName,
    ),
    await projections.readCanonical(
      promotionScope.revision.projectId,
      promotionScope.revision.environmentName,
    ),
  );
  await assert.rejects(
    store.promoteCandidate({
      ...promotionInput(promotionScope),
      inputFingerprint: canonicalSha256("changed-input"),
    }),
    (error: unknown) =>
      error instanceof V1EcsReleaseOutcomeError
      && error.code === "ECS_RELEASE_OUTCOME_IDEMPOTENCY_CONFLICT",
  );

  const rollbackScope = await seedScope();
  const [firstPrepare, secondPrepare] = await Promise.all([
    store.prepareRollback(rollbackInput(rollbackScope)),
    store.prepareRollback(rollbackInput(rollbackScope)),
  ]);
  assert.deepEqual(
    new Set([firstPrepare.disposition, secondPrepare.disposition]),
    new Set(["rollback_prepared", "rollback_replayed"]),
  );
  assert.equal(
    await status(rollbackScope.previousStableManifestId),
    "stable",
    "previous stable must remain stable before rollback health proof",
  );
  const prepared = firstPrepare.disposition === "rollback_prepared"
    ? firstPrepare
    : secondPrepare;
  if (prepared.disposition === "rollback_target_missing") {
    throw new Error("Expected an exact rollback target");
  }
  await assert.rejects(
    store.prepareRollback({
      ...rollbackInput(rollbackScope),
      inputFingerprint: canonicalSha256("changed-rollback-input"),
    }),
    (error: unknown) =>
      error instanceof V1EcsReleaseOutcomeError
      && error.code === "ECS_RELEASE_OUTCOME_IDEMPOTENCY_CONFLICT",
  );
  const finalizeRollbackInput = {
    revision: rollbackScope.revision,
    rollbackManifestId: prepared.target.rollbackManifestId,
    rollbackRevision: prepared.target.rollbackRevision,
    previousStableManifestId:
      prepared.target.previousStable.releaseManifestId,
    idempotencyKey: rollbackInput(rollbackScope).idempotencyKey,
    inputFingerprint: rollbackInput(rollbackScope).inputFingerprint,
    verification: healthy,
    fence: rollbackScope.fence,
  };
  const rollbackFinalizations = await Promise.all([
    store.finalizeRollback(finalizeRollbackInput),
    store.finalizeRollback(finalizeRollbackInput),
  ]);
  assert.deepEqual(
    new Set(rollbackFinalizations.map((result) => result.disposition)),
    new Set(["rolled_back", "replayed"]),
  );
  assert.equal(await status(rollbackScope.candidateManifestId), "rolled_back");
  assert.equal(
    await status(rollbackScope.previousStableManifestId),
    "superseded",
  );
  assert.equal(
    await status(prepared.target.rollbackManifestId),
    "stable",
  );
  assert.deepEqual(
    await projections.readLegacyProjection(
      rollbackScope.revision.projectId,
      rollbackScope.revision.environmentName,
    ),
    await projections.readCanonical(
      rollbackScope.revision.projectId,
      rollbackScope.revision.environmentName,
    ),
  );

  const projectionFailureScope = await seedScope();
  const projectionFailureStore = new InactiveV1EcsReleaseOutcomeStore(
    dataSource,
    {
      async syncWithinTransaction() {
        throw new Error("FIXTURE_PROJECTION_WRITE_FAILED");
      },
    },
  );
  await assert.rejects(
    projectionFailureStore.promoteCandidate(
      promotionInput(projectionFailureScope),
    ),
    /FIXTURE_PROJECTION_WRITE_FAILED/,
  );
  assert.equal(
    await status(projectionFailureScope.candidateManifestId),
    "health_checking",
  );
  assert.equal(
    await status(projectionFailureScope.previousStableManifestId),
    "stable",
  );

  const staleScope = await seedScope();
  const stalePrepared = await store.prepareRollback(
    rollbackInput(staleScope),
  );
  if (stalePrepared.disposition === "rollback_target_missing") {
    throw new Error("Expected a stale-fence rollback target");
  }
  await dataSource.query(
    `UPDATE project_operation_leases
     SET fencing_token = 2, owner_worker_id = 'replacement-worker'
     WHERE id = $1`,
    [staleScope.fence.leaseId],
  );
  await assert.rejects(
    store.finalizeRollback({
      revision: staleScope.revision,
      rollbackManifestId: stalePrepared.target.rollbackManifestId,
      rollbackRevision: stalePrepared.target.rollbackRevision,
      previousStableManifestId:
        stalePrepared.target.previousStable.releaseManifestId,
      idempotencyKey: rollbackInput(staleScope).idempotencyKey,
      inputFingerprint: rollbackInput(staleScope).inputFingerprint,
      verification: healthy,
      fence: staleScope.fence,
    }),
    (error: unknown) =>
      error instanceof V1EcsReleaseOutcomeError
      && error.code === "ECS_RELEASE_OUTCOME_OWNERSHIP_LOST",
  );
  assert.equal(
    await status(staleScope.previousStableManifestId),
    "stable",
  );

  const missingScope = await seedScope({ withPrevious: false });
  const missing = await store.prepareRollback(
    rollbackInput(missingScope),
  );
  assert.equal(missing.disposition, "rollback_target_missing");
  assert.equal(await status(missingScope.candidateManifestId), "failed");
  const rollbackRows = await dataSource.query(
    `SELECT count(*)::int AS count FROM release_manifests
     WHERE parent_manifest_id = $1 AND origin = 'rollback'`,
    [missingScope.candidateManifestId],
  ) as Array<{ count: number }>;
  assert.equal(rollbackRows[0].count, 0);

  console.log(
    "Inactive v1 ECS release outcome PostgreSQL checks passed.",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
  if (admin.isInitialized) {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.destroy();
    }
  }
});
