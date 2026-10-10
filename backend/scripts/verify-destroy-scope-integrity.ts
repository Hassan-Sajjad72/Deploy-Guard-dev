import "reflect-metadata";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { DataSource } from "typeorm";
import AppDataSource from "../src/data-source";
import { NotificationSubscription } from "../src/notifications/notification-subscription.entity";
import { githubActionsDestroyEvidenceFromValue } from "../src/projects/github-actions-destroy-evidence";
import { ProjectDeletionIncompleteError, ProjectDeletionService } from "../src/projects/project-deletion.service";
import { PipelineRunStatus, ProjectPipelineRun } from "../src/projects/project-pipeline-run.entity";
import { Project } from "../src/projects/project.entity";
import { ProjectDeploymentGeneration } from "../src/projects/project-deployment-generation.entity";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { servicesBase64 } from "../src/projects/railpack-workflow-contract";

const projectId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000002";
const generationIds = ["30000000-0000-4000-8000-000000000003", "40000000-0000-4000-8000-000000000004"];
const foreignGeneration = "50000000-0000-4000-8000-000000000005";
const project: any = { id: projectId, environmentName: "dev", ownerUserId: 7, repositoryFullName: "fixture/repository" };
const encoded = servicesBase64({
  schemaVersion: 3, projectId, operationId, sourceSha: "a".repeat(40), environmentName: "dev", projectDeletion: { generationIds },
  services: [{ serviceId: "60000000-0000-4000-8000-000000000006", serviceName: "Web", serviceDirectory: ".", servicePort: 8080,
    runtimeConfigRevisionId: "70000000-0000-4000-8000-000000000007", buildEnvironment: {}, buildSecretReferences: {},
    environment: { PORT: "8080", HOST: "0.0.0.0" }, secretReferences: {}, databaseAttached: false, managedDatabase: { engine: null, aliases: [] },
    rollbackImage: `123456789012.dkr.ecr.us-east-1.amazonaws.com/fixture@sha256:${"b".repeat(64)}` }],
});
const evidence = () => ({ contractVersion: "deployguard.destroy-result/v2", deploymentOperationId: operationId, projectId, environmentName: "dev", generationIds: [...generationIds],
  status: "project_delete_ready", generationResourcesRemoved: true, projectResourcesRemoved: true, terraformStateArtifactsRemoved: true, sharedPlatformUntouched: true, verifiedAt: new Date().toISOString() });
const operation = () => ({ id: operationId, projectId, generationId: generationIds[0], commitSha: "a".repeat(40), status: PipelineRunStatus.COMPLETED, currentStage: "project_delete_cleanup",
  metadata: { deploymentAction: "destroy", destroyEvidenceValidated: true, immutableDispatchInputs: { services_base64: encoded }, destroyVerification: evidence() } });

async function verify() {
  const admission: any = Object.create(RailpackDeploymentService.prototype);
  let configurationReads = 0;
  let pendingCleanup = operation();
  admission.captureAdmittedConfiguration = async () => { configurationReads++; throw new Error("ADMISSION_ADVANCED_DURING_CLEANUP"); };
  admission.dataSource = { transaction: async (callback: (manager: unknown) => Promise<unknown>) => callback({
    query: async () => undefined,
    getRepository: (entity: unknown) => entity === Project ? { findOne: async () => project }
      : { findOne: async ({ where }: any) => where.currentStage === "project_delete_cleanup" ? pendingCleanup : null },
  }) };
  for (const status of [PipelineRunStatus.COMPLETED, PipelineRunStatus.FAILED]) {
    pendingCleanup = { ...operation(), status };
    for (const action of ["deploy", "rollback", "destroy"]) {
      await assert.rejects(() => admission.admitLifecycleOperation({ id: 7 }, project, action, null, null, null),
        (error: any) => error?.getStatus?.() === 409 && /deletion cleanup/.test(error.message),
        "verified project deletion cleanup must block another lifecycle admission");
    }
  }
  assert.equal(configurationReads, 0, "cleanup conflicts must fail before configuration or provider work");
  assert.equal(githubActionsDestroyEvidenceFromValue({ ...evidence(), generationIds: [...generationIds, 7] }), null,
    "non-string generation identities cannot be silently discarded from deletion claims");
  for (const invalid of [null, [], { ...evidence(), environmentName: "Prod" }, { ...evidence(), generationIds: [generationIds[0], generationIds[0]] }]) {
    assert.equal(githubActionsDestroyEvidenceFromValue(invalid), null);
  }
  const lifecycle: any = Object.create(RailpackDeploymentService.prototype);
  let saves = 0;
  let cleanups = 0;
  lifecycle.runs = { save: async (row: unknown) => { saves++; return row; } };
  lifecycle.notifications = { dispatch: async () => undefined };
  lifecycle.projectDeletion = { finalize: async () => { cleanups++; } };
  for (const ids of [[generationIds[0]], [generationIds[0], foreignGeneration], [...generationIds, foreignGeneration]]) {
    const candidate = operation();
    const invalid = { ...evidence(), generationIds: ids };
    await assert.rejects(() => lifecycle.finalizeVerifiedDestroy(project, candidate, { destroyVerification: invalid }, "success"),
      /scope|generation/, "including LIVE is insufficient: deletion must cover exactly the frozen complete generation set");
    candidate.metadata.destroyVerification = invalid;
    assert.equal(lifecycle.verifiedDestroyEvidence(candidate, project), null, "cleanup-only retry must revalidate the same exact scope");
  }
  assert.equal(saves, 0);
  assert.equal(cleanups, 0, "narrowed/widened deletion evidence cannot reach control-plane cleanup");
  const candidate = operation();
  await lifecycle.finalizeVerifiedDestroy(project, candidate, { destroyVerification: { ...evidence(), generationIds: [...generationIds].reverse() } }, "success");
  assert.equal(cleanups, 1, "order-independent complete scope remains supported");

  const deletion: any = Object.create(ProjectDeletionService.prototype);
  deletion.assertReady(project, operation());
  for (const metadata of [
    { ...operation().metadata, immutableDispatchInputs: {} },
    { ...operation().metadata, destroyVerification: { ...evidence(), generationIds: [generationIds[0]] } },
    { ...operation().metadata, destroyEvidenceValidated: false },
  ]) assert.throws(() => deletion.assertReady(project, { ...operation(), metadata }), ProjectDeletionIncompleteError);

  let deletes = 0;
  let persisted = operation();
  let activeOperations = 0;
  let persistedGenerations = [...generationIds];
  deletion.subscriptions = { find: async () => [] };
  deletion.projects = { count: async () => 1 };
  deletion.sns = { deleteProjectResources: async () => undefined };
  deletion.githubApp = { removeManagedWorkflow: async () => { throw new Error("shared caller must be preserved"); } };
  deletion.dataSource = { transaction: async (callback: (manager: unknown) => Promise<unknown>) => callback({
    query: async () => undefined,
    getRepository: (entity: unknown) => entity === ProjectDeploymentGeneration ? { find: async () => persistedGenerations.map((id) => ({ id })) }
      : { count: async () => activeOperations, findOne: async (options: any) => {
      assert.deepEqual(options.lock, { mode: "pessimistic_write" }, "persisted eligibility must remain locked until deletion commits");
      return persisted;
    }, delete: async () => { deletes++; return { affected: 1 }; } },
  }) };
  persisted = { ...operation(), status: PipelineRunStatus.RUNNING };
  await assert.rejects(() => deletion.finalize(project, operation()), ProjectDeletionIncompleteError,
    "the operation must still be eligible inside the deletion transaction");
  assert.equal(deletes, 0, "a revoked/stale operation cannot erase project authority");
  persisted = operation();
  activeOperations = 1;
  await assert.rejects(() => deletion.finalize(project, operation()), /another lifecycle operation is active/);
  activeOperations = 0;
  persistedGenerations = [...generationIds, foreignGeneration];
  await assert.rejects(() => deletion.finalize(project, operation()), /generation set changed/);
  assert.equal(deletes, 0, "new operations/generations cannot be erased by stale cleanup authority");
  persistedGenerations = [...generationIds];
  assert.deepEqual(await deletion.finalize(project, operation()), { projectId, status: "deleted" });
  assert.equal(deletes, 1);
  console.log("DESTROY_SCOPE_INTEGRITY=PASS EXACT_FROZEN_GENERATIONS=1 MALFORMED_IDENTITIES_REJECTED=1 RETRY_REVALIDATED=1 TRANSACTION_REVALIDATED=1 CLEANUP_ADMISSION_BLOCKED=1 AWS_EXECUTION=NONE ABSENCE_PROOF=NOT_CERTIFIED");
}

async function verifyPostgresBoundary() {
  const postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
  let database: DataSource | null = null;
  try {
    const env = { ...process.env, DATABASE_HOST: postgres.getHost(), DATABASE_PORT: String(postgres.getPort()), DATABASE_USERNAME: postgres.getUsername(), DATABASE_PASSWORD: postgres.getPassword(), DATABASE_NAME: postgres.getDatabase(), DATABASE_SSL: "false", AUTH_SESSION_SECRET: "m0-deletion-disposable-local-session-secret-32-characters", TYPEORM_SYNCHRONIZE: "false", NODE_ENV: "test" };
    const migration = spawnSync("npm", ["run", "migration:run"], { cwd: resolve(__dirname, ".."), env, encoding: "utf8", timeout: 120_000 });
    assert.equal(migration.status, 0, "disposable deletion fixture must migrate successfully from zero");
    database = new DataSource({ ...AppDataSource.options, host: postgres.getHost(), port: postgres.getPort(), username: postgres.getUsername(), password: postgres.getPassword(), database: postgres.getDatabase(), ssl: false, synchronize: false, migrations: [] } as any);
    await database.initialize();
    assert.equal((await database.query("SELECT count(*)::int AS count FROM migrations"))[0].count, 111);
    const owner = (await database.query("INSERT INTO users (github_id,name,email,role) VALUES ('m0-deletion','Deletion fixture','deletion@example.invalid','developer') RETURNING id"))[0].id;
    await database.query("INSERT INTO projects (id,owner_user_id,name,repository_url,repository_full_name,target_branch,status,visibility) VALUES ($1,$2,'Deletion fixture','https://github.com/fixture/repository','fixture/repository','main','configured','private')", [projectId, owner]);
    const addGeneration = (id: string, ordinal: number) => database!.query("INSERT INTO project_deployment_generations (id,project_id,environment_name,ordinal,status,terraform_state_key) VALUES ($1,$2,'dev',$3,'retired','fixture.tfstate')", [id, projectId, ordinal]);
    for (let index = 0; index < generationIds.length; index++) await addGeneration(generationIds[index], index + 1);
    await database.query("INSERT INTO project_pipeline_runs (id,project_id,triggered_by_user_id,repository_url,repository_full_name,target_branch,status,current_stage,commit_sha,generation_id,metadata) VALUES ($1,$2,$3,'https://github.com/fixture/repository','fixture/repository','main','completed','project_delete_cleanup',$4,$5,$6::jsonb)", [operationId, projectId, owner, operation().commitSha, generationIds[0], JSON.stringify(operation().metadata)]);
    const deletion = new ProjectDeletionService(database, database.getRepository(Project), database.getRepository(NotificationSubscription),
      { removeManagedWorkflow: async () => undefined } as any, { deleteProjectResources: async () => undefined } as any);
    const persistedProject: any = { ...project, ownerUserId: owner };
    await addGeneration(foreignGeneration, 3);
    await assert.rejects(() => deletion.finalize(persistedProject, operation() as any), /generation set changed/);
    assert.equal(await database.getRepository(Project).countBy({ id: projectId }), 1);
    await database.query("DELETE FROM project_deployment_generations WHERE id=$1", [foreignGeneration]);

    const admission: any = Object.create(RailpackDeploymentService.prototype);
    admission.dataSource = database;
    admission.captureAdmittedConfiguration = async () => { throw new Error("No admission is allowed during cleanup."); };
    for (const action of ["deploy", "rollback", "destroy"]) await assert.rejects(() => admission.admitLifecycleOperation({ id: owner }, persistedProject, action, null, null, null), (error: any) => error.getStatus?.() === 409);

    // Contend at the last destructive transaction boundary, using a separate
    // real PostgreSQL connection. No timing sleeps or provider writes are used.
    const transaction = database.transaction.bind(database);
    let contentionChecks = 0;
    (database as any).transaction = async (callback: any) => transaction(async (manager) => {
      const query = manager.query.bind(manager);
      (manager as any).query = async (sql: string, parameters?: unknown[]) => {
        if (sql.startsWith("DELETE FROM audit_logs")) {
          const contender = database!.createQueryRunner();
          await contender.connect();
          try {
            await contender.startTransaction();
            const lock = await contender.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired", [`project_configuration:${projectId}:dev`]);
            assert.equal(lock[0].acquired, false, "cleanup must hold the same lock as lifecycle admission");
            await contender.query("SET LOCAL lock_timeout='100ms'");
            await assert.rejects(() => contender.query("UPDATE project_pipeline_runs SET status='running' WHERE id=$1", [operationId]), (error: any) => error.code === "55P03", "the persisted authority row must remain locked through deletion");
            contentionChecks++;
          } finally {
            try { if (contender.isTransactionActive) await contender.rollbackTransaction(); }
            finally { await contender.release(); }
          }
        }
        return query(sql, parameters);
      };
      return callback(manager);
    });
    try { assert.deepEqual(await deletion.finalize(persistedProject, operation() as any), { projectId, status: "deleted" }); }
    finally { (database as any).transaction = transaction; }
    assert.equal(contentionChecks, 1);
    assert.equal(await database.getRepository(Project).countBy({ id: projectId }), 0);
    assert.equal(await database.getRepository(ProjectPipelineRun).countBy({ projectId }), 0, "verified deletion must cascade operation authority");
    assert.equal(await database.getRepository(ProjectDeploymentGeneration).countBy({ projectId }), 0);
    console.log("DESTROY_SCOPE_POSTGRES=PASS MIGRATIONS=111 ADMISSION_CONFLICT=1 CHANGED_GENERATIONS_BLOCKED=1 CONFIGURATION_LOCK=1 ROW_LOCK_CONTENTION=1 CASCADE=1 AWS_EXECUTION=NONE");
  } finally {
    try { if (database?.isInitialized) await database.destroy(); }
    finally { await postgres.stop(); }
  }
}
void (async () => { await verify(); await verifyPostgresBoundary(); })().catch((error) => { console.error(error); process.exitCode = 1; });
