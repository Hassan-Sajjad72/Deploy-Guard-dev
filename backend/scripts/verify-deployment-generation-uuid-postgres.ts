import "reflect-metadata";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { DeploymentGenerations1760000065000 } from "../src/migrations/1760000065000-DeploymentGenerations";
import { NoConflictGenerationArchitecture1760000072000 } from "../src/migrations/1760000072000-NoConflictGenerationArchitecture";
import { RemoveAbsoluteDestroyLifecycle1760000073000 } from "../src/migrations/1760000073000-RemoveAbsoluteDestroyLifecycle";
import { GenerationCandidateRoutingPriority1760000074000 } from "../src/migrations/1760000074000-GenerationCandidateRoutingPriority";
import { DeploymentGenerationService } from "../src/projects/deployment-generation.service";
import { DeploymentGenerationStatus, ProjectDeploymentGeneration } from "../src/projects/project-deployment-generation.entity";
import { ProjectEnvironmentRoute } from "../src/projects/project-environment-route.entity";

const schema = `generation_v2_test_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
if (!/^[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe generation test schema.");
const dataSource = new DataSource({ ...AppDataSource.options, migrations: [], synchronize: false, logging: false } as DataSourceOptions);

async function operation(runner: ReturnType<DataSource["createQueryRunner"]>, projectId: string) {
  const id = randomUUID();
  await runner.query(`INSERT INTO project_pipeline_runs (id, project_id, status, metadata) VALUES ($1,$2,'queued','{}')`, [id, projectId]);
  return id;
}

async function main() {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    await runner.query(`CREATE SCHEMA "${schema}"`);
    await runner.query(`SET search_path TO "${schema}", public`);
    await runner.query(`CREATE TABLE projects (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE project_pipeline_runs (id uuid PRIMARY KEY, project_id uuid NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), status varchar NOT NULL, current_stage varchar NULL)`);
    await runner.query(`CREATE TABLE project_service_bindings (id uuid PRIMARY KEY, project_id uuid NOT NULL, pipeline_run_id uuid NOT NULL)`);
    await runner.query(`CREATE TABLE project_stable_releases (id uuid PRIMARY KEY, project_id uuid NOT NULL, environment_name varchar NOT NULL, status varchar NOT NULL, deployed_by_pipeline_run_id uuid NULL)`);
    await runner.query(`CREATE TABLE project_database_tiers (project_id uuid PRIMARY KEY, status varchar NOT NULL DEFAULT 'pending', efs_file_system_id varchar NULL, efs_access_point_id varchar NULL, credentials_secret_arn varchar NULL, database_url_secret_arn varchar NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    await new DeploymentGenerations1760000065000().up(runner);
    await new NoConflictGenerationArchitecture1760000072000().up(runner);
    await new RemoveAbsoluteDestroyLifecycle1760000073000().up(runner);
    await new GenerationCandidateRoutingPriority1760000074000().up(runner);
    assert.equal((await runner.query(`SELECT to_regclass('project_destroy_lifecycles') AS relation`))[0].relation, null);
    const statusConstraint = String((await runner.query(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'CHK_project_deployment_generation_status_v3'
    `))[0]?.definition || "");
    assert.doesNotMatch(statusConstraint, /legacy_live|legacy_retired/);

    const generations = runner.manager.getRepository(ProjectDeploymentGeneration);
    const routes = runner.manager.getRepository(ProjectEnvironmentRoute);
    const service = new DeploymentGenerationService(generations, routes);
    const firstProject = randomUUID();
    const secondProject = randomUUID();
    await runner.query(`INSERT INTO projects (id) VALUES ($1),($2)`, [firstProject, secondProject]);

    const g1 = await service.createCandidate(firstProject, "dev", runner.manager);
    assert.equal(g1.ordinal, 1);
    assert.match(g1.id, /^[0-9a-f-]{36}$/i);
    assert.equal(g1.terraformStateKey, `projects/${firstProject}/dev/${g1.id}/terraform.tfstate`);
    assert.equal(g1.candidateListenerPriority, 20000, "G001 receives a persisted collision-free candidate priority");
    const op1 = await operation(runner, firstProject);
    await service.bindCreatingOperation(g1.id, op1, runner.manager);
    await service.promoteVerified(g1.id, op1, { ecsServiceArn: "arn:g1", taskDefinitionArn: "arn:task:g1", targetGroupArn: "arn:tg:g1", listenerRuleArn: "arn:stable" }, runner.manager);

    const g2 = await service.createCandidate(firstProject, "dev", runner.manager);
    assert.notEqual(g2.id, g1.id);
    assert.notEqual(g2.terraformStateKey, g1.terraformStateKey);
    assert.equal(g2.candidateListenerPriority, 20001, "G002 cannot reuse G001's candidate routing identity while G001 remains physical LIVE infrastructure");
    assert.equal((await service.live(firstProject, "dev", runner.manager))?.id, g1.id, "G001 remains LIVE while G002 deploys");
    const op2 = await operation(runner, firstProject);
    await service.bindCreatingOperation(g2.id, op2, runner.manager);
    await service.markFailed(g2.id, op2, "health failed", runner.manager);
    assert.equal((await service.live(firstProject, "dev", runner.manager))?.id, g1.id, "failed candidate cannot replace LIVE");
    assert.equal((await service.route(firstProject, "dev", runner.manager))?.candidateGenerationId, null, "terminal candidate failure clears the route candidate identity");
    await service.requireRetryableGeneration(g2.id, firstProject, "dev", runner.manager);
    assert.equal((await service.candidate(firstProject, "dev", runner.manager))?.id, g2.id, "Retry preserves candidate generation");
    const retryOp2 = await operation(runner, firstProject);
    await service.bindCreatingOperation(g2.id, retryOp2, runner.manager);
    assert.equal((await generations.findOneByOrFail({ id: g2.id })).createdByOperationId, op2, "Retry never rewrites the generation creator");
    await service.promoteVerified(g2.id, retryOp2, { ecsServiceArn: "arn:g2", taskDefinitionArn: "arn:task:g2", targetGroupArn: "arn:tg:g2", listenerRuleArn: "arn:stable" }, runner.manager);
    assert.equal((await generations.findOneByOrFail({ id: g1.id })).status, DeploymentGenerationStatus.RETIRED);
    assert.equal((await generations.findOneByOrFail({ id: g1.id })).candidateListenerPriority, 20000, "G001 retains its immutable historical candidate routing identity while its application resources remain LIVE");
    assert.equal((await service.live(firstProject, "dev", runner.manager))?.id, g2.id);

    await service.markCleanupPending(g1.id, { error: "dependency still draining" }, runner.manager);
    const g3 = await service.createCandidate(firstProject, "dev", runner.manager);
    assert.equal(g3.ordinal, 3, "CLEANUP_PENDING does not block a new candidate");
    assert.equal(g3.candidateListenerPriority, 20002, "G003 receives another collision-free candidate routing identity while G001 remains cleanup pending");
    const route = await service.route(firstProject, "dev", runner.manager);
    assert.equal(route?.liveGenerationId, g2.id);
    assert.equal(route?.candidateGenerationId, g3.id);
    const other = await service.createCandidate(secondProject, "dev", runner.manager);
    const otherRoute = await service.route(secondProject, "dev", runner.manager);
    assert.notEqual(otherRoute?.listenerPriority, route?.listenerPriority, "project route allocations are globally unique");
    assert.notEqual(other.terraformStateKey, g3.terraformStateKey, "same repository identity cannot couple different projects");

    const cleanup = await service.cleanupTarget(g1.id, runner.manager);
    assert.equal(cleanup.generationId, g1.id);
    assert.equal(cleanup.terraformStateKey, g1.terraformStateKey);
    assert.equal((cleanup.resources as Record<string, unknown>).targetGroupArn, "arn:tg:g1");
    assert.equal("ecrRepositoryName" in cleanup.resources, false);
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    await runner.release();
    await dataSource.destroy();
  }
}

main().then(() => console.log("No-conflict generation PostgreSQL checks passed.")).catch((error) => { console.error(error); process.exitCode = 1; });
