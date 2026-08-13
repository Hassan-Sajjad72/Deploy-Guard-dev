import { strict as assert } from "node:assert";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { CreateReleaseLaneOwnerships1760000043000 } from "../src/migrations/1760000043000-CreateReleaseLaneOwnerships";
import { AddReleaseLaneOwnershipCorrelation1760000044000 } from "../src/migrations/1760000044000-AddReleaseLaneOwnershipCorrelation";
import { CreateReleaseLaneShadowObservations1760000045000 } from "../src/migrations/1760000045000-CreateReleaseLaneShadowObservations";
import { CreatePipelineJobFinalities1760000046000 } from "../src/migrations/1760000046000-CreatePipelineJobFinalities";
import { InactiveLegacyShadowInsertionAdapter } from "../src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter";
import { InactiveReleaseLaneShadowObserverService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.service";
import { ProjectPipelineJobFinality } from "../src/projects/pipeline/project-pipeline-job-finality.entity";
import { PipelineJobFinalityService } from "../src/projects/pipeline/pipeline-job-finality.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session8_14_terminal_${suffix}`;
const projectId = "11111111-1111-4111-8111-111111111111";
const completedRunId = "22222222-2222-4222-8222-222222222222";
const failedRunId = "33333333-3333-4333-8333-333333333333";
const base = AppDataSource.options as DataSourceOptions & { extra?: Record<string, unknown> };
const admin = new DataSource({ ...base, entities: [], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
const dataSource = new DataSource({ ...base, schema, entities: base.entities, synchronize: false, logging: false, extra: { ...(base.extra || {}), options: `-c search_path=${schema},public` } } as DataSourceOptions);

async function setup() {
  await dataSource.query(`
    CREATE TABLE projects (id uuid PRIMARY KEY);
    CREATE TABLE project_pipeline_runs (id uuid PRIMARY KEY, project_id uuid NOT NULL, status varchar(64) NOT NULL, completed_at timestamptz, failed_at timestamptz, cross_lane_ownership_id uuid, cross_lane_owner_lane varchar(16), cross_lane_owner_environment_name varchar(64), cross_lane_owner_lease_id uuid, cross_lane_owner_actor_id varchar(160), cross_lane_owner_fencing_token bigint);
    CREATE TABLE project_pipeline_events (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), pipeline_run_id uuid NOT NULL, project_id uuid NOT NULL, stage varchar NOT NULL, status varchar NOT NULL, message text NOT NULL DEFAULT '', metadata jsonb, occurred_at timestamptz NOT NULL DEFAULT now(), ingested_at timestamptz NOT NULL DEFAULT now(), duration_ms bigint, source varchar NOT NULL DEFAULT 'test', sequence_number integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE project_rollback_records (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), project_id uuid NOT NULL);
    CREATE TABLE deployment_intents (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), project_id uuid NOT NULL, environment_name varchar(64) NOT NULL, status varchar(32) NOT NULL);
    CREATE TABLE project_operation_leases (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), project_id uuid NOT NULL, environment_name varchar(64) NOT NULL, intent_id uuid, owner_worker_id varchar(160), fencing_token bigint, status varchar(24) NOT NULL, expires_at timestamptz NOT NULL);
    INSERT INTO projects (id) VALUES ('${projectId}');
    INSERT INTO project_pipeline_runs (id,project_id,status,completed_at,failed_at) VALUES ('${completedRunId}','${projectId}','completed',clock_timestamp() - interval '1 second',NULL), ('${failedRunId}','${projectId}','failed',NULL,clock_timestamp() - interval '1 second');
    INSERT INTO project_pipeline_events (pipeline_run_id,project_id,stage,status) VALUES ('${completedRunId}','${projectId}','completed','success'), ('${failedRunId}','${projectId}','build','failed');
  `);
  const runner = dataSource.createQueryRunner();
  try {
    for (const migration of [new CreateReleaseLaneOwnerships1760000043000(), new AddReleaseLaneOwnershipCorrelation1760000044000(), new CreateReleaseLaneShadowObservations1760000045000(), new CreatePipelineJobFinalities1760000046000()]) await migration.up(runner);
  } finally { await runner.release(); }
}

async function main() {
  const priorFinality = process.env.LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED;
  const priorShadow = process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.initialize();
  try {
    await setup();
    process.env.LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED = "true";
    process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE = "true";
    const observer = new InactiveReleaseLaneShadowObserverService(dataSource);
    const pending: Promise<unknown>[] = [];
    const adapter = new InactiveLegacyShadowInsertionAdapter({ observe(input) { const result = observer.observe(input); pending.push(result); return result; } } as never);
    const finality = new PipelineJobFinalityService(dataSource, { get: (key: string) => process.env[key] } as never, dataSource.getRepository(ProjectPipelineJobFinality), adapter);
    const completed = await finality.recordCompleted({ pipelineRunId: completedRunId, bullmqJobId: "job-completed" });
    assert.equal((completed as any).disposition, "recorded");
    await finality.recordCompleted({ pipelineRunId: completedRunId, bullmqJobId: "job-completed" });
    const failed = await finality.recordFailedAfterRetriesExhausted({ pipelineRunId: failedRunId, bullmqJobId: "job-failed", queueState: "failed", attemptsMade: 2, configuredAttempts: 2 });
    assert.equal((failed as any).disposition, "recorded");
    const results = await Promise.all(pending);
    assert.equal(results.filter((value: any) => value.disposition === "observed").length, 2);
    assert.equal(results.filter((value: any) => value.disposition === "already_observed").length, 1);
    const rows = await dataSource.query(`SELECT operation_class, insertion_source, to_jsonb(t)::text AS value FROM project_release_lane_shadow_observations t ORDER BY insertion_source`);
    assert.deepEqual(rows.map((row: any) => [row.operation_class, row.insertion_source]), [["legacy_worker_terminal_success", "pipeline_worker.completed_persisted"], ["legacy_worker_terminal_failure", "pipeline_worker.failed_persisted"]]);
    assert.equal(rows.every((row: any) => !/job-completed|job-failed|${completedRunId}|${failedRunId}|payload|repository|credential|error/i.test(row.value)), true);

    const [{ finalityCount }] = await dataSource.query(`SELECT count(*)::integer AS "finalityCount" FROM project_pipeline_job_finalities`);
    assert.equal(finalityCount, 2);
    delete process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
    await finality.recordCompleted({ pipelineRunId: completedRunId, bullmqJobId: "job-completed" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const [{ shadowCount }] = await dataSource.query(`SELECT count(*)::integer AS "shadowCount" FROM project_release_lane_shadow_observations`);
    assert.equal(shadowCount, 2, "disabled shadow mode must not write");
    console.log("Inactive legacy worker terminal shadow PostgreSQL verification passed");
  } finally {
    if (priorFinality === undefined) delete process.env.LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED; else process.env.LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED = priorFinality;
    if (priorShadow === undefined) delete process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE; else process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE = priorShadow;
    if (dataSource.isInitialized) await dataSource.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.destroy();
  }
}
void main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });
