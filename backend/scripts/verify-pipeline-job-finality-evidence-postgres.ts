import { strict as assert } from "node:assert";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { CreatePipelineJobFinalities1760000046000 } from "../src/migrations/1760000046000-CreatePipelineJobFinalities";
import { ProjectPipelineJobFinality } from "../src/projects/pipeline/project-pipeline-job-finality.entity";
import { PipelineJobFinalityService } from "../src/projects/pipeline/pipeline-job-finality.service";
import { ProjectPipelineEvent } from "../src/projects/project-pipeline-event.entity";
import { ProjectPipelineRun } from "../src/projects/project-pipeline-run.entity";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session8_13_finality_${suffix}`;
const projectId = "11111111-1111-4111-8111-111111111111";
const completedRunId = "22222222-2222-4222-8222-222222222222";
const failedRunId = "33333333-3333-4333-8333-333333333333";
const base = AppDataSource.options as DataSourceOptions & { extra?: Record<string, unknown> };
const admin = new DataSource({ ...base, entities: [], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
const dataSource = new DataSource({
  ...base, schema, synchronize: false, logging: false,
  entities: base.entities,
  extra: { ...(base.extra || {}), options: `-c search_path=${schema},public` },
} as DataSourceOptions);

async function setup() {
  await dataSource.query(`
    CREATE TABLE projects (id uuid PRIMARY KEY);
    CREATE TABLE project_pipeline_runs (id uuid PRIMARY KEY, project_id uuid NOT NULL, status varchar(64) NOT NULL, completed_at timestamptz, failed_at timestamptz);
    CREATE TABLE project_pipeline_events (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), pipeline_run_id uuid NOT NULL, project_id uuid NOT NULL, stage varchar NOT NULL, status varchar NOT NULL, message text NOT NULL DEFAULT '', metadata jsonb, occurred_at timestamptz NOT NULL DEFAULT now(), ingested_at timestamptz NOT NULL DEFAULT now(), duration_ms bigint, source varchar NOT NULL DEFAULT 'test', sequence_number integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO projects (id) VALUES ('${projectId}');
    INSERT INTO project_pipeline_runs (id, project_id, status, completed_at, failed_at) VALUES ('${completedRunId}','${projectId}','completed', now() - interval '1 second', NULL), ('${failedRunId}','${projectId}','failed', NULL, now() - interval '1 second');
    INSERT INTO project_pipeline_events (pipeline_run_id, project_id, stage, status) VALUES ('${completedRunId}','${projectId}','completed','success'), ('${failedRunId}','${projectId}','build','failed');
  `);
  const runner = dataSource.createQueryRunner();
  try {
    const migration = new CreatePipelineJobFinalities1760000046000();
    await migration.up(runner);
    await migration.up(runner);
    await migration.down(runner);
    await migration.up(runner);
    await migration.up(runner);
  } finally { await runner.release(); }
}

async function main() {
  const prior = process.env.LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED;
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.initialize();
  try {
    await setup();
    process.env.LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED = "true";
    const service = new PipelineJobFinalityService(dataSource, { get: (key: string) => process.env[key] } as never, dataSource.getRepository(ProjectPipelineJobFinality));
    const completed = await service.recordCompleted({ pipelineRunId: completedRunId, bullmqJobId: "finality-job-1" });
    assert.equal(completed.enabled, true);
    assert.equal((completed as any).disposition, "recorded");
    const duplicate = await service.recordCompleted({ pipelineRunId: completedRunId, bullmqJobId: "finality-job-1" });
    assert.equal((duplicate as any).disposition, "already_recorded");
    await assert.rejects(() => service.recordFailedAfterRetriesExhausted({ pipelineRunId: completedRunId, bullmqJobId: "finality-job-1", queueState: "failed", attemptsMade: 2, configuredAttempts: 2 }), /finality_conflict/);

    const early = await service.recordFailedAfterRetriesExhausted({ pipelineRunId: failedRunId, bullmqJobId: "finality-job-2", queueState: "failed", attemptsMade: 1, configuredAttempts: 2 });
    assert.equal((early as any).disposition, "not_eligible");
    const failed = await Promise.all(Array.from({ length: 4 }, () => service.recordFailedAfterRetriesExhausted({ pipelineRunId: failedRunId, bullmqJobId: "finality-job-2", queueState: "failed", attemptsMade: 2, configuredAttempts: 2 })));
    assert.equal(failed.filter((value: any) => value.disposition === "recorded").length, 1);
    assert.equal(failed.filter((value: any) => value.disposition === "already_recorded").length, 3);
    const rows = await dataSource.query(`SELECT decision, to_jsonb(t)::text AS value FROM project_pipeline_job_finalities t ORDER BY bullmq_job_id`);
    assert.deepEqual(rows.map((row: any) => row.decision), ["completed", "failed_after_retries_exhausted"]);
    assert.equal(rows.every((row: any) => !/payload|repository|credential|error|message/i.test(row.value)), true);

    delete process.env.LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED;
    const disabled = await service.recordCompleted({ pipelineRunId: completedRunId, bullmqJobId: "disabled-job" });
    assert.deepEqual(disabled, { enabled: false });
    const [{ count }] = await dataSource.query(`SELECT count(*)::integer AS count FROM project_pipeline_job_finalities`);
    assert.equal(count, 2);
    const runner = dataSource.createQueryRunner();
    try {
      await assert.rejects(() => new CreatePipelineJobFinalities1760000046000().down(runner), /Refusing to roll back/);
    } finally { await runner.release(); }
    console.log("Pipeline job finality evidence PostgreSQL verification passed");
  } finally {
    if (prior === undefined) delete process.env.LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED;
    else process.env.LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED = prior;
    if (dataSource.isInitialized) await dataSource.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.destroy();
  }
}
void main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });
