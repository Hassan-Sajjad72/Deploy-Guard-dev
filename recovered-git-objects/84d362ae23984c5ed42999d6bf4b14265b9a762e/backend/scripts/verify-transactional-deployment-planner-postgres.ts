import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { DeploymentIntent } from "../src/orchestration-contracts/entities/deployment-intent.entity";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { OrchestrationOutbox } from "../src/orchestration-contracts/entities/orchestration-outbox.entity";
import { ProjectOperationLease } from "../src/orchestration-contracts/entities/project-operation-lease.entity";
import { ReleaseManifest } from "../src/orchestration-contracts/entities/release-manifest.entity";
import { ProjectStateRevision } from "../src/orchestration-contracts/entities/project-state-revision.entity";
import { WorkerCapability } from "../src/orchestration-contracts/entities/worker-capability.entity";
import { CreateTwoLaneManifestsAndStateRevisions1760000034000 } from "../src/migrations/1760000034000-CreateTwoLaneManifestsAndStateRevisions";
import { CreateDeploymentIntentsOutboxAndOperationLeases1760000035000 } from "../src/migrations/1760000035000-CreateDeploymentIntentsOutboxAndOperationLeases";
import { PlannerIdempotencyConflictError } from "../src/orchestration-contracts/planner/transactional-deployment-planner.types";
import { TransactionalDeploymentPlannerService } from "../src/orchestration-contracts/planner/transactional-deployment-planner.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session4_planner_test_${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe test schema identifier.");

const entities = [
  InfrastructureManifest,
  ReleaseManifest,
  DeploymentIntent,
  OrchestrationOutbox,
  ProjectOperationLease,
  ProjectStateRevision,
  WorkerCapability,
];

const admin = new DataSource({
  ...AppDataSource.options,
  entities: [],
  migrations: [],
  synchronize: false,
  logging: false,
} as DataSourceOptions);

const options = AppDataSource.options as DataSourceOptions & { extra?: Record<string, unknown> };
const testDataSource = new DataSource({
  ...options,
  schema,
  entities,
  migrations: [],
  synchronize: false,
  logging: false,
  extra: {
    ...(options.extra || {}),
    options: `-c search_path=${schema},public`,
  },
} as DataSourceOptions);

const migrations = [
  new CreateTwoLaneManifestsAndStateRevisions1760000034000(),
  new CreateDeploymentIntentsOutboxAndOperationLeases1760000035000(),
];

const project1 = "11111111-1111-4111-8111-111111111111";
const project2 = "22222222-2222-4222-8222-222222222222";
const commit1 = "a".repeat(40);
const commit2 = "b".repeat(40);
const contractHash1 = "c".repeat(64);
const contractHash2 = "d".repeat(64);

async function createLegacyShape(dataSource: DataSource) {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query(`CREATE TABLE users (id integer PRIMARY KEY)`);
    await runner.query(`
      CREATE TABLE projects (
        id uuid PRIMARY KEY,
        owner_user_id integer NOT NULL,
        name varchar NOT NULL,
        repository_url varchar NOT NULL,
        repository_full_name varchar,
        target_branch varchar NOT NULL,
        environment_name varchar NOT NULL,
        status varchar NOT NULL,
        archived_at timestamptz,
        deletion_fence_token bigint,
        deletion_intent_id uuid,
        deletion_started_at timestamptz
      )
    `);
    await runner.query(`CREATE TABLE project_pipeline_runs (id uuid PRIMARY KEY)`);
    await runner.query(`
      CREATE TABLE project_deployment_contracts (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL,
        repository_full_name varchar,
        branch varchar NOT NULL,
        commit_sha varchar,
        detection_source_commit varchar,
        app_root varchar NOT NULL,
        docker_strategy varchar,
        docker_template varchar,
        build_command varchar,
        output_directory varchar,
        start_command varchar,
        port integer,
        health_path varchar NOT NULL,
        build_time_env_vars jsonb NOT NULL,
        runtime_env_vars jsonb NOT NULL,
        secret_env_vars jsonb NOT NULL,
        missing_env_vars jsonb NOT NULL,
        database_required boolean NOT NULL,
        database_engine varchar,
        persistent_storage_required boolean NOT NULL,
        ecs_plan jsonb NOT NULL,
        deployable boolean NOT NULL,
        blockers jsonb NOT NULL,
        contract_hash char(64) NOT NULL,
        invalidated_reason varchar,
        invalidated_at timestamptz
      )
    `);
    await runner.query(`CREATE TABLE project_configuration_snapshots (id uuid PRIMARY KEY)`);
    await runner.query(`
      CREATE TABLE project_preflight_reports (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL,
        input_fingerprint char(64),
        validation_status varchar NOT NULL,
        errors jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await runner.query(`
      CREATE TABLE project_environment_variables (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL,
        key varchar NOT NULL,
        value text,
        scope varchar NOT NULL,
        is_secret boolean NOT NULL,
        configuration_fingerprint char(64),
        is_active boolean NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await runner.query(`
      CREATE TABLE project_database_tiers (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL,
        provider varchar,
        engine varchar,
        persistence_enabled boolean NOT NULL,
        backup_enabled boolean NOT NULL,
        external_tls_required boolean NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await runner.query(`
      CREATE TABLE project_persistent_storage (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL,
        environment_name varchar NOT NULL,
        enabled boolean NOT NULL,
        encrypted boolean NOT NULL,
        backup_enabled boolean NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await runner.query(`
      CREATE TABLE project_service_bindings (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL,
        configuration_fingerprint char(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await runner.query(`
      CREATE TABLE project_infrastructure_environments (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL,
        environment_name varchar NOT NULL,
        status varchar NOT NULL,
        applied_manifest_id uuid,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await runner.query(`CREATE TABLE project_deployments (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE project_stable_releases (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE infrastructure_destroy_operations (id uuid PRIMARY KEY)`);
    for (const migration of migrations) await migration.up(runner);
  } finally {
    await runner.release();
  }
}

async function seedProject(
  dataSource: DataSource,
  projectId: string,
  contractId: string,
  preflightId: string,
  repository: string,
  commit: string,
  contractHash: string,
) {
  await dataSource.query(
    `INSERT INTO projects (
       id, owner_user_id, name, repository_url, repository_full_name,
       target_branch, environment_name, status
     ) VALUES ($1, 1, $2, $3, $4, 'main', 'production', 'configured')`,
    [projectId, repository, `https://github.com/${repository}`, repository],
  );
  await dataSource.query(
    `INSERT INTO project_deployment_contracts (
       id, project_id, repository_full_name, branch, commit_sha,
       detection_source_commit, app_root, docker_strategy, docker_template,
       build_command, output_directory, start_command, port, health_path,
       build_time_env_vars, runtime_env_vars, secret_env_vars, missing_env_vars,
       database_required, database_engine, persistent_storage_required, ecs_plan,
       deployable, blockers, contract_hash
     ) VALUES (
       $1, $2, $3, 'main', $4, $4, '.', 'generated', 'node-server-v1',
       'npm run build', NULL, 'npm start', 3000, '/api/health',
       '[]'::jsonb, '["NODE_ENV","DATABASE_URL"]'::jsonb,
       '["DATABASE_URL"]'::jsonb, '[]'::jsonb, false, NULL, false,
       $5::jsonb, true, '[]'::jsonb, $6
     )`,
    [
      contractId,
      projectId,
      repository,
      commit,
      JSON.stringify({
        containerPort: 3000,
        targetGroupPort: 3000,
        healthCheckPath: "/api/health",
        command: "npm start",
        cpu: 256,
        memory: 512,
      }),
      contractHash,
    ],
  );
  await dataSource.query(
    `INSERT INTO project_preflight_reports (
       id, project_id, input_fingerprint, validation_status, errors
     ) VALUES ($1, $2, $3, 'passed', '[]'::jsonb)`,
    [preflightId, projectId, contractHash],
  );
  await dataSource.query(
    `INSERT INTO project_environment_variables (
       id, project_id, key, value, scope, is_secret, configuration_fingerprint, is_active
     ) VALUES
       ($1, $2, 'NODE_ENV', 'production', 'runtime', false, $3, true),
       ($4, $2, 'DATABASE_URL', 'plaintext-test-secret', 'runtime', true, $5, true)`,
    [
      projectId === project1 ? "31111111-1111-4111-8111-111111111111" : "32222222-2222-4222-8222-222222222222",
      projectId,
      "e".repeat(64),
      projectId === project1 ? "41111111-1111-4111-8111-111111111111" : "42222222-2222-4222-8222-222222222222",
      "f".repeat(64),
    ],
  );
}

async function counts(dataSource: DataSource, projectId: string) {
  const [row] = await dataSource.query(
    `SELECT
       (SELECT count(*)::integer FROM deployment_intents WHERE project_id = $1) AS intents,
       (SELECT count(*)::integer FROM infrastructure_manifests WHERE project_id = $1) AS infrastructure,
       (SELECT count(*)::integer FROM release_manifests WHERE project_id = $1) AS releases,
       (SELECT count(*)::integer FROM orchestration_outbox o
          JOIN deployment_intents i ON i.id = o.intent_id WHERE i.project_id = $1) AS outbox`,
    [projectId],
  );
  return row as { intents: number; infrastructure: number; releases: number; outbox: number };
}

async function main() {
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  try {
    await testDataSource.initialize();
    await createLegacyShape(testDataSource);
    await testDataSource.query(`INSERT INTO users (id) VALUES (1)`);
    await seedProject(
      testDataSource,
      project1,
      "51111111-1111-4111-8111-111111111111",
      "61111111-1111-4111-8111-111111111111",
      "example/app-one",
      commit1,
      contractHash1,
    );
    await seedProject(
      testDataSource,
      project2,
      "52222222-2222-4222-8222-222222222222",
      "62222222-2222-4222-8222-222222222222",
      "example/app-two",
      commit2,
      contractHash2,
    );

    const planner = new TransactionalDeploymentPlannerService(
      testDataSource,
      new ConfigService({
        AWS_REGION: "us-east-1",
        TERRAFORM_TEMPLATE_VERSION: "v1",
        STATE_MOCK_MODE: "false",
        TERRAFORM_STATE_PREFIX: "projects",
        CLOUDWATCH_LOGS_ENABLED: "true",
        CLOUDWATCH_METRICS_ENABLED: "true",
        PROMETHEUS_ENABLED: "false",
        IAM_POLICY_REVISION: "v1",
        DEPLOYGUARD_VERSION: "session4-test",
        GIT_SHA: "test",
      }),
    );
    const input = {
      actor: { userId: 1, role: "developer" as const },
      projectId: project1,
      environmentName: "production",
      kind: "deploy" as const,
      idempotencyKey: "concurrent-request",
      requestedCommitSha: commit1,
    };
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => planner.plan(input)));
    assert.equal(concurrent.filter((result) => !result.replayed).length, 1);
    assert.equal(new Set(concurrent.map((result) => result.intent.id)).size, 1);
    assert.deepEqual(await counts(testDataSource, project1), {
      intents: 1,
      infrastructure: 1,
      releases: 1,
      outbox: 1,
    });
    assert.equal(concurrent[0].decision.classification, "infrastructure_change");

    const replay = await planner.plan(input);
    assert.equal(replay.replayed, true);
    await assert.rejects(
      () => planner.plan({ ...input, recoveryCode: "different-request" }),
      (error) => error instanceof PlannerIdempotencyConflictError && error.statusCode === 409,
    );

    const [link] = await testDataSource.query(
      `SELECT r.infrastructure_manifest_id AS "releaseInfrastructureId",
              i.infrastructure_manifest_id AS "intentInfrastructureId",
              r.release_spec AS "releaseSpec", i.request_payload AS "requestPayload"
       FROM release_manifests r
       JOIN deployment_intents i ON i.release_manifest_id = r.id
       WHERE i.id = $1`,
      [concurrent[0].intent.id],
    );
    assert.equal(link.releaseInfrastructureId, link.intentInfrastructureId);
    assert.equal(JSON.stringify(link.releaseSpec).includes("plaintext-test-secret"), false);
    assert.equal(JSON.stringify(link.requestPayload).includes("plaintext-test-secret"), false);

    await testDataSource.query(
      `UPDATE infrastructure_manifests SET status = 'applied', applied_at = now()
       WHERE id = $1`,
      [link.intentInfrastructureId],
    );
    await testDataSource.query(
      `UPDATE release_manifests
       SET status = 'stable', image_digest = 'sha256:test', task_definition_arn = 'arn:test',
           health_verified_at = now(), promoted_at = now()
       WHERE id = $1`,
      [concurrent[0].intent.releaseManifestId],
    );
    await testDataSource.query(
      `UPDATE deployment_intents SET status = 'completed', completed_at = now()
       WHERE id = $1`,
      [concurrent[0].intent.id],
    );
    const noOp = await planner.plan({ ...input, idempotencyKey: "no-op-request" });
    assert.equal(noOp.decision.classification, "no_op");
    assert.deepEqual(await counts(testDataSource, project1), {
      intents: 2,
      infrastructure: 1,
      releases: 1,
      outbox: 1,
    });

    await testDataSource.query(
      `UPDATE project_environment_variables
       SET configuration_fingerprint = $1, updated_at = now()
       WHERE project_id = $2 AND key = 'NODE_ENV'`,
      ["1".repeat(64), project1],
    );
    const releaseOnly = await planner.plan({ ...input, idempotencyKey: "runtime-change" });
    assert.equal(releaseOnly.decision.classification, "release_only");
    assert.equal(releaseOnly.decision.desiredInfrastructureManifestId, link.intentInfrastructureId);
    assert.deepEqual(await counts(testDataSource, project1), {
      intents: 3,
      infrastructure: 1,
      releases: 2,
      outbox: 2,
    });

    await testDataSource.query(`
      CREATE FUNCTION fail_session4_outbox() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'session4 forced outbox failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await testDataSource.query(`
      CREATE TRIGGER fail_session4_outbox_trigger
      BEFORE INSERT ON orchestration_outbox
      FOR EACH ROW EXECUTE FUNCTION fail_session4_outbox()
    `);
    await assert.rejects(
      () => planner.plan({
        ...input,
        projectId: project2,
        requestedCommitSha: commit2,
        idempotencyKey: "rollback-proof",
      }),
      /session4 forced outbox failure/,
    );
    assert.deepEqual(await counts(testDataSource, project2), {
      intents: 0,
      infrastructure: 0,
      releases: 0,
      outbox: 0,
    });
    await testDataSource.query(`DROP TRIGGER fail_session4_outbox_trigger ON orchestration_outbox`);
    await testDataSource.query(`DROP FUNCTION fail_session4_outbox()`);
    await testDataSource.query(
      `UPDATE projects SET deletion_fence_token = 1, deletion_started_at = now() WHERE id = $1`,
      [project2],
    );
    const fenced = await planner.plan({
      ...input,
      projectId: project2,
      requestedCommitSha: commit2,
      idempotencyKey: "deletion-fence-proof",
    });
    assert.equal(fenced.decision.classification, "unsafe_or_unknown");
    assert.equal(fenced.decision.reasonCodes.includes("DELETION_FENCE_ACTIVE"), true);
    assert.deepEqual(await counts(testDataSource, project2), {
      intents: 1,
      infrastructure: 0,
      releases: 0,
      outbox: 0,
    });

    console.log("Transactional deployment planner PostgreSQL concurrency and rollback verification passed");
  } finally {
    if (testDataSource.isInitialized) await testDataSource.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.destroy();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
