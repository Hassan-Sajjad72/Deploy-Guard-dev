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
import { ProjectPipelineEvent } from "../src/projects/project-pipeline-event.entity";
import { ProjectGenerationServiceRevision } from "../src/projects/project-generation-service-revision.entity";
import { ProjectServiceRuntimeConfigRevision } from "../src/projects/project-service-runtime-config-revision.entity";
import { AWS_RESOURCE_OWNERSHIP_SOURCE, ownershipSha256 } from "../src/projects/aws-resource-ownership";
import { RUNTIME_SECRET_OWNERSHIP_SOURCE, runtimeSecretOwnershipRecord } from "../src/projects/runtime-secret-ownership";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { servicesBase64 } from "../src/projects/railpack-workflow-contract";
import { destroyProofFixture } from "./fixtures/destroy-proof";

const projectId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000002";
const generationIds = ["30000000-0000-4000-8000-000000000003", "40000000-0000-4000-8000-000000000004"];
const foreignGeneration = "50000000-0000-4000-8000-000000000005";
const project: any = { id: projectId, environmentName: "dev", ownerUserId: 7, repositoryFullName: "fixture/repository" };
const proof = destroyProofFixture(projectId, operationId, generationIds);
const encoded = servicesBase64({
  schemaVersion: 3, projectId, operationId, sourceSha: "a".repeat(40), environmentName: "dev", projectDeletion: { generationIds, ownership: proof.ownership },
  services: [{ serviceId: "60000000-0000-4000-8000-000000000006", serviceName: "Web", serviceDirectory: ".", servicePort: 8080,
    runtimeConfigRevisionId: "70000000-0000-4000-8000-000000000007", buildEnvironment: {}, buildSecretReferences: {},
    environment: { PORT: "8080", HOST: "0.0.0.0" }, secretReferences: {}, databaseAttached: false, managedDatabase: { engine: null, aliases: [] },
    rollbackImage: `123456789012.dkr.ecr.us-east-1.amazonaws.com/fixture@sha256:${"b".repeat(64)}` }],
});
const evidence = () => structuredClone(proof.evidence);
const operation = () => ({ id: operationId, projectId, generationId: generationIds[0], commitSha: "a".repeat(40), startedAt: new Date(Date.parse(proof.evidence.verifiedAt) - 1000), status: PipelineRunStatus.COMPLETED, currentStage: "project_delete_cleanup",
  metadata: { deploymentAction: "destroy", destroyEvidenceValidated: true, immutableDispatchInputs: { ...proof.inputs, services_base64: encoded }, destroyVerification: evidence() } });

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
  let retainedEvents = structuredClone(proof.events);
  let retainedOperations = [...proof.operations];
  let externalCleanups = 0;
  let invalidateAfterExternalCleanup = false;
  deletion.subscriptions = { find: async () => [] };
  deletion.projects = { count: async () => 1 };
  deletion.sns = { deleteProjectResources: async () => { externalCleanups++; if (invalidateAfterExternalCleanup) retainedEvents = []; } };
  deletion.githubApp = { removeManagedWorkflow: async () => { throw new Error("shared caller must be preserved"); } };
  deletion.dataSource = { transaction: async (callback: (manager: unknown) => Promise<unknown>) => callback({
    query: async () => undefined,
    getRepository: (entity: unknown) => entity === ProjectDeploymentGeneration ? { find: async () => persistedGenerations.map((id) => ({ id, projectId, environmentName: "dev", createdByOperationId: id })) }
      : entity === ProjectPipelineEvent ? { find: async () => retainedEvents }
      : entity === ProjectGenerationServiceRevision ? { find: async () => proof.revisions }
      : entity === ProjectServiceRuntimeConfigRevision ? { find: async () => proof.configurations }
      : { find: async () => retainedOperations, count: async () => activeOperations, findOne: async (options: any) => {
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
  for (const mutate of [
    () => { retainedEvents = []; },
    () => { retainedEvents[0].metadata.sha256 = "f".repeat(64); },
    () => { retainedEvents.push(structuredClone(retainedEvents[0])); },
    () => { retainedOperations.push({ ...proof.operations[0], id: foreignGeneration }); },
    () => { retainedEvents[0].metadata.evidence.resources.push({ type: "aws_ecr_repository", id: "late-owned-repository" }); retainedEvents[0].metadata.sha256 = ownershipSha256(retainedEvents[0].metadata.evidence); },
  ]) {
    const externalBefore = externalCleanups;
    mutate();
    await assert.rejects(() => deletion.finalize(project, operation()), ProjectDeletionIncompleteError);
    assert.equal(externalCleanups, externalBefore, "missing, corrupt, duplicated or changed durable authority must block SNS/GitHub cleanup");
    assert.equal(deletes, 0);
    retainedEvents = structuredClone(proof.events); retainedOperations = [...proof.operations];
  }
  invalidateAfterExternalCleanup = true;
  await assert.rejects(() => deletion.finalize(project, operation()), ProjectDeletionIncompleteError);
  assert.equal(deletes, 0, "the final locked transaction must independently restore receipts after external cleanup");
  invalidateAfterExternalCleanup = false; retainedEvents = structuredClone(proof.events);
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
    for (const row of proof.operations) {
      await database.query("INSERT INTO project_pipeline_runs (id,project_id,triggered_by_user_id,repository_url,repository_full_name,target_branch,status,current_stage,commit_sha,metadata) VALUES ($1,$2,$3,'https://github.com/fixture/repository','fixture/repository','main','completed','runtime_verification',$4,$5::jsonb)", [row.id, projectId, owner, row.commitSha, JSON.stringify(row.metadata)]);
      await database.query("UPDATE project_deployment_generations SET created_by_operation_id=$1 WHERE id=$1", [row.id]);
    }
    await database.query("INSERT INTO project_deployable_services (id,project_id,name,service_directory,position) VALUES ($1,$2,'Web','.',0)", [proof.revisions[0].serviceId, projectId]);
    for (const row of proof.configurations) await database.query("INSERT INTO project_service_runtime_config_revisions (id,project_id,service_id,created_by_operation_id,environment_name,configuration_fingerprint,secret_references,database_configuration,sealed_at) VALUES ($1,$2,$3,$4,'dev',$5,$6::jsonb,$7::jsonb,$8)", [row.id, projectId, row.serviceId, row.createdByOperationId, row.configurationFingerprint, JSON.stringify(row.secretReferences), JSON.stringify(row.databaseConfiguration), row.sealedAt]);
    for (const row of proof.revisions) await database.query("INSERT INTO project_generation_service_revisions (project_id,generation_id,service_id,service_name,service_directory,source_sha,image_uri,image_digest,runtime_config_revision_id,runtime_identity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)", [projectId, row.generationId, row.serviceId, row.serviceName, row.serviceDirectory, row.sourceSha, row.imageUri, row.imageDigest, row.runtimeConfigRevisionId, JSON.stringify(row.runtimeIdentity)]);
    for (const row of proof.events) await database.query("INSERT INTO project_pipeline_events (pipeline_run_id,project_id,stage,status,message,source,metadata) VALUES ($1,$2,'ownership_retention','completed','Simulated identifier ownership',$3,$4::jsonb)", [row.pipelineRunId, projectId, row.source, JSON.stringify(row.metadata)]);
    await database.query("INSERT INTO project_pipeline_runs (id,project_id,triggered_by_user_id,repository_url,repository_full_name,target_branch,status,current_stage,commit_sha,generation_id,metadata,started_at) VALUES ($1,$2,$3,'https://github.com/fixture/repository','fixture/repository','main','completed','project_delete_cleanup',$4,$5,$6::jsonb,$7)", [operationId, projectId, owner, operation().commitSha, generationIds[0], JSON.stringify(operation().metadata), operation().startedAt]);
    let externalCleanups = 0;
    let invalidateAfterExternalCleanup = false;
    const deletion = new ProjectDeletionService(database, database.getRepository(Project), database.getRepository(NotificationSubscription),
      { removeManagedWorkflow: async () => undefined } as any, { deleteProjectResources: async () => {
        externalCleanups++;
        if (invalidateAfterExternalCleanup) await database!.query("UPDATE project_pipeline_events SET metadata=jsonb_set(metadata,'{sha256}',to_jsonb($1::text)) WHERE pipeline_run_id=$2 AND source=$3", ["f".repeat(64), proof.operations[0].id, AWS_RESOURCE_OWNERSHIP_SOURCE]);
      } } as any);
    const persistedProject: any = { ...project, ownerUserId: owner };
    await database.query("INSERT INTO project_deployment_generations (id,project_id,environment_name,ordinal,status,terraform_state_key) VALUES ($1,$2,'prod',1,'retired','projects/fixture/prod/runtime/terraform.tfstate')", [foreignGeneration, projectId]);
    await assert.rejects(() => deletion.finalize(persistedProject, operation() as any), /generation set changed/);
    assert.equal(externalCleanups, 0, "whole-project deletion cannot erase evidence for another unverified environment");
    await database.query("DELETE FROM project_deployment_generations WHERE id=$1", [foreignGeneration]);
    const secretName = `deployguard/${projectId}/dev/services/${proof.revisions[0].serviceId}/runtime`;
    const secretArn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${secretName}-abcdef`;
    const secretScope = { ...proof.ownership.manifest.scope, operationId: proof.operations[0].id };
    const retainSecret = (phase: "intent" | "owned") => database!.getRepository(ProjectPipelineEvent).save(runtimeSecretOwnershipRecord({
      phase, projectId, operationId: secretScope.operationId, serviceId: proof.revisions[0].serviceId, environmentName: "dev", secretName,
      versionToken: "d".repeat(64), ...(phase === "owned" ? { secretArn } : {}),
    }, secretScope));
    await retainSecret("intent");
    await assert.rejects(() => deletion.finalize(persistedProject, operation() as any), ProjectDeletionIncompleteError);
    assert.equal(externalCleanups, 0, "a durable unresolved secret intent blocks cleanup before any provider work");
    await retainSecret("owned");
    await assert.rejects(() => deletion.finalize(persistedProject, operation() as any), ProjectDeletionIncompleteError);
    assert.equal(externalCleanups, 0, "a durable owned secret missing from the complete journal cannot be erased with project authority");
    await database.query("DELETE FROM project_pipeline_events WHERE project_id=$1 AND pipeline_run_id=$2 AND source=$3", [projectId, secretScope.operationId, RUNTIME_SECRET_OWNERSHIP_SOURCE]);
    const canonicalIdentity = proof.revisions[0].runtimeIdentity;
    await database.query("UPDATE project_generation_service_revisions SET runtime_identity=jsonb_set(runtime_identity,'{taskDefinitionArn}',to_jsonb($1::text)) WHERE generation_id=$2", [canonicalIdentity.taskDefinitionArn.replace(/:\d+$/, ":99"), generationIds[0]]);
    await assert.rejects(() => deletion.finalize(persistedProject, operation() as any), ProjectDeletionIncompleteError);
    assert.equal(externalCleanups, 0, "an unrecorded canonical task revision must block cleanup even with valid frozen receipts");
    await database.query("UPDATE project_generation_service_revisions SET runtime_identity=$1::jsonb WHERE generation_id=$2", [JSON.stringify(canonicalIdentity), generationIds[0]]);
    await addGeneration(foreignGeneration, 3);
    await assert.rejects(() => deletion.finalize(persistedProject, operation() as any), /generation set changed/);
    assert.equal(await database.getRepository(Project).countBy({ id: projectId }), 1);
    await database.query("DELETE FROM project_deployment_generations WHERE id=$1", [foreignGeneration]);

    // Real persisted JSONB receipts must be re-read before provider work, not
    // merely hashed once at admission and then trusted until project deletion.
    await database.query("UPDATE project_pipeline_events SET metadata=jsonb_set(metadata,'{sha256}',to_jsonb($1::text)) WHERE pipeline_run_id=$2 AND source=$3", ["f".repeat(64), proof.operations[0].id, AWS_RESOURCE_OWNERSHIP_SOURCE]);
    await assert.rejects(() => deletion.finalize(persistedProject, operation() as any), ProjectDeletionIncompleteError);
    assert.equal(externalCleanups, 0, "corrupt durable receipts block all external cleanup");
    const restore = () => database!.query("UPDATE project_pipeline_events SET metadata=$1::jsonb WHERE pipeline_run_id=$2 AND source=$3", [JSON.stringify(proof.events[0].metadata), proof.operations[0].id, AWS_RESOURCE_OWNERSHIP_SOURCE]);
    await restore();
    invalidateAfterExternalCleanup = true;
    await assert.rejects(() => deletion.finalize(persistedProject, operation() as any), ProjectDeletionIncompleteError);
    assert.equal(externalCleanups, 1);
    assert.equal(await database.getRepository(Project).countBy({ id: projectId }), 1, "changed durable receipts after external cleanup must preserve project authority for recovery");
    invalidateAfterExternalCleanup = false; await restore();

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
    console.log("DESTROY_SCOPE_POSTGRES=PASS MIGRATIONS=111 ADMISSION_CONFLICT=1 CHANGED_GENERATIONS_BLOCKED=1 CONFIGURATION_LOCK=1 ROW_LOCK_CONTENTION=1 DURABLE_RECEIPTS_PRE_CLEANUP=1 DURABLE_RECEIPTS_PRE_CASCADE=1 CANONICAL_TASK_DRIFT=1 RUNTIME_SECRET_INTENT_AND_OWNED=1 CASCADE=1 AWS_EXECUTION=NONE");
  } finally {
    try { if (database?.isInitialized) await database.destroy(); }
    finally { await postgres.stop(); }
  }
}
void (async () => { await verify(); await verifyPostgresBoundary(); })().catch((error) => { console.error(error); process.exitCode = 1; });
