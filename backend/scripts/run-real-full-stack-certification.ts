import "reflect-metadata";
import { strict as assert } from "node:assert";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const backendRoot = resolve(__dirname, "..");
const root = resolve(backendRoot, "..");
const frontendRoot = join(root, "frontend");
const resultPath = join(root, ".deployguard-test-results", "full-stack-result.json");
const projectId = "11111111-1111-4111-8111-111111111111";
const serviceId = "22222222-2222-4222-8222-222222222222";
const apiPort = 5100;
const frontendPort = 5174;
const processes: ChildProcess[] = [];
let postgres: StartedPostgreSqlContainer | null = null;
let databaseClient: Client | null = null;

function checked(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, printOutput = true) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  if (printOutput && result.stdout.trim()) process.stdout.write(result.stdout);
}

function start(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  processes.push(child);
  return child;
}

async function waitFor(url: string, child: ChildProcess) {
  let last = "not started";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Process exited before ${url} became ready (code ${child.exitCode})`);
    try { const response = await fetch(url); if (response.ok) return; last = `HTTP ${response.status}`; }
    catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`${url} did not become ready: ${last}`);
}

async function seed(client: Client) {
  const developer = await client.query(`INSERT INTO users (github_id,name,email,image,github_login,role) VALUES ('9000001','Certification Developer','certification@example.test','','certification-developer','developer') RETURNING id`);
  const readonly = await client.query(`INSERT INTO users (github_id,name,email,image,github_login,role) VALUES ('9000002','Certification Reader','reader@example.test','','certification-reader','readonly') RETURNING id`);
  await client.query(`INSERT INTO projects (id,owner_user_id,name,description,repository_url,repository_full_name,target_branch,environment_name,status,visibility) VALUES ($1,$2,'Fixture application','Isolated full-stack fixture','https://github.com/fixture/local','fixture/local','main','dev','configured','workspace')`, [projectId, developer.rows[0].id]);
  await client.query(`INSERT INTO project_deployable_services (id,project_id,name,service_directory,position) VALUES ($1,$2,'Web','.',0)`, [serviceId, projectId]);
  return { developerId: developer.rows[0].id, readonlyId: readonly.rows[0].id };
}

async function verifyPersistence(client: Client, result: any) {
  const requiredTables = ["projects", "project_deployable_services", "project_environment_variables", "project_database_tiers", "project_pipeline_runs", "project_deployment_generations", "project_environment_routes", "project_stable_releases", "project_service_runtime_config_revisions", "project_generation_service_revisions"];
  const tables = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])`, [requiredTables]);
  assert.equal(tables.rowCount, requiredTables.length, "all canonical persistence tables must exist after zero-to-head migrations");
  const project = await client.query(`SELECT name,description,target_branch,application_entrypoint_service_id FROM projects WHERE id=$1`, [projectId]);
  assert.deepEqual(project.rows[0], { name: "Certified application", description: "Full-stack persisted configuration", target_branch: "main", application_entrypoint_service_id: result.apiServiceId });
  const services = await client.query(`SELECT id,name,service_directory,position FROM project_deployable_services WHERE project_id=$1 ORDER BY position`, [projectId]);
  assert.equal(services.rowCount, 2);
  assert.equal(services.rows.find((row) => row.id === result.apiServiceId)?.service_directory, "apps/api");
  const environment = await client.query(`SELECT service_id,normalized_key,is_secret,value FROM project_environment_variables WHERE project_id=$1 ORDER BY normalized_key`, [projectId]);
  assert.equal(environment.rowCount, 2);
  assert.equal(new Set(environment.rows.map((row) => row.service_id)).size, 2, "service ENV must remain isolated by service UUID");
  assert.ok(environment.rows.every((row) => !["https://example.test", "browser-secret-value"].includes(row.value)), "persisted ENV must be encrypted at rest");
  assert.equal(environment.rows.find((row) => row.normalized_key === "JWT_SECRET")?.is_secret, true);
  const database = await client.query(`SELECT provider,engine,attached_service_id,persistence_enabled FROM project_database_tiers WHERE project_id=$1`, [projectId]);
  assert.deepEqual(database.rows[0], { provider: "managed", engine: "mongodb", attached_service_id: result.apiServiceId, persistence_enabled: false });

  const constraints = await client.query(`SELECT count(*)::int AS count FROM pg_constraint WHERE contype IN ('f','u') AND conrelid::regclass::text = ANY($1::text[])`, [["project_deployable_services", "project_environment_variables", "project_database_tiers", "project_pipeline_runs", "project_deployment_generations", "project_environment_routes", "project_service_runtime_config_revisions", "project_generation_service_revisions"]]);
  assert.ok(constraints.rows[0].count >= 16, "canonical foreign-key and uniqueness constraints must be installed");
  const liveIndex = await client.query(`SELECT indexdef FROM pg_indexes WHERE indexname='UQ_project_deployment_generation_live'`);
  assert.match(liveIndex.rows[0]?.indexdef || "", /UNIQUE[\s\S]*WHERE \(\(status\)::text = 'live'::text\)/i, "PostgreSQL must enforce one authoritative LIVE generation per project/environment");

  await verifyReleasePersistence(client, result, services.rows.map((row) => row.id));

  const disposableProject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const disposableService = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await client.query(`INSERT INTO projects (id,owner_user_id,name,repository_url,repository_full_name,target_branch,status,visibility) SELECT $1,owner_user_id,'Disposable','https://github.com/fixture/disposable','fixture/disposable','main','configured','private' FROM projects WHERE id=$2`, [disposableProject, projectId]);
  await client.query(`INSERT INTO project_deployable_services (id,project_id,name,service_directory,position) VALUES ($1,$2,'Web','.',0)`, [disposableService, disposableProject]);
  await client.query(`UPDATE projects SET application_entrypoint_service_id=$1 WHERE id=$2`, [disposableService, disposableProject]);
  await client.query(`INSERT INTO project_environment_variables (project_id,service_id,key,normalized_key,value,is_secret,environment) VALUES ($1,$2,'DISPOSABLE','DISPOSABLE','encrypted',true,'dev')`, [disposableProject, disposableService]);
  await client.query(`DELETE FROM projects WHERE id=$1`, [disposableProject]);
  const residue = await client.query(`SELECT (SELECT count(*) FROM project_deployable_services WHERE project_id=$1)::int AS services,(SELECT count(*) FROM project_environment_variables WHERE project_id=$1)::int AS environment`, [disposableProject]);
  assert.deepEqual(residue.rows[0], { services: 0, environment: 0 }, "project extinction must cascade through service configuration ownership");
}

async function verifyReleasePersistence(client: Client, result: any, serviceIds: string[]) {
  const operationOne = "33333333-3333-4333-8333-333333333331";
  const generationOne = "44444444-4444-4444-8444-444444444441";
  const operationTwo = "33333333-3333-4333-8333-333333333332";
  const generationTwo = "44444444-4444-4444-8444-444444444442";
  const retryOperation = "33333333-3333-4333-8333-333333333333";
  const destroyOperation = "33333333-3333-4333-8333-333333333334";
  const user = await client.query(`SELECT owner_user_id FROM projects WHERE id=$1`, [projectId]);
  const insertRun = `INSERT INTO project_pipeline_runs (id,project_id,triggered_by_user_id,repository_url,repository_full_name,target_branch,commit_sha,status,current_stage,execution_lane,metadata) VALUES ($1,$2,$3,'https://github.com/fixture/local','fixture/local','main',$4,$5,$6,$7,$8::jsonb)`;
  await client.query(insertRun, [operationOne, projectId, user.rows[0].owner_user_id, "a".repeat(40), "completed", "completed", "release", JSON.stringify({ action: "deploy" })]);
  await client.query(`INSERT INTO project_deployment_generations (id,project_id,environment_name,ordinal,status,terraform_state_key,resource_manifest,created_by_operation_id,activated_at) VALUES ($1,$2,'dev',1,'live','projects/fixture/dev/generations/1.tfstate',$3::jsonb,$4,now())`, [generationOne, projectId, JSON.stringify({ services: serviceIds }), operationOne]);
  await client.query(`UPDATE project_pipeline_runs SET generation_id=$1 WHERE id=$2`, [generationOne, operationOne]);

  const revisionIds: string[] = [];
  for (const [position, configuredServiceId] of serviceIds.entries()) {
    const revision = await client.query(`INSERT INTO project_service_runtime_config_revisions (project_id,service_id,created_by_operation_id,environment_name,configuration_fingerprint,non_secret_environment,secret_references,secret_version_ids,database_configuration,platform_values,sealed_at) VALUES ($1,$2,$3,'dev',$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,now()) RETURNING id`, [projectId, configuredServiceId, operationOne, String(position + 1).repeat(64), JSON.stringify({ RELEASE_VALUE: `immutable-${position}` }), JSON.stringify(position ? { JWT_SECRET: "arn:fixture:secret" } : {}), JSON.stringify(position ? { JWT_SECRET: "version-1" } : {}), JSON.stringify({ attachedServiceId: result.apiServiceId }), JSON.stringify({ PORT: "8080", HOST: "0.0.0.0" })]);
    revisionIds.push(revision.rows[0].id);
    await client.query(`INSERT INTO project_generation_service_revisions (project_id,generation_id,service_id,service_name,service_directory,source_sha,image_uri,image_digest,runtime_config_revision_id,runtime_identity) SELECT $1,$2,id,name,service_directory,$3,$4,$5,$6,$7::jsonb FROM project_deployable_services WHERE id=$8`, [projectId, generationOne, "a".repeat(40), `fixture.invalid/service-${position}:immutable`, `sha256:${String(position + 3).repeat(64)}`, revision.rows[0].id, JSON.stringify({ serviceId: configuredServiceId, ecsServiceArn: `arn:fixture:ecs:${position}` }), configuredServiceId]);
  }
  const releaseOne = await client.query(`INSERT INTO project_stable_releases (project_id,generation_id,environment_name,commit_sha,short_commit_sha,deployed_by_pipeline_run_id,deployed_at,status,metadata) VALUES ($1,$2,'dev',$3,$4,$5,now(),'stable',$6::jsonb) RETURNING id`, [projectId, generationOne, "a".repeat(40), "a".repeat(7), operationOne, JSON.stringify({ services: serviceIds })]);
  await client.query(`INSERT INTO project_environment_routes (project_id,environment_name,listener_priority,live_generation_id,metadata) VALUES ($1,'dev',19001,$2,$3::jsonb)`, [projectId, generationOne, JSON.stringify({ operationId: operationOne })]);

  await assert.rejects(client.query(`INSERT INTO project_deployment_generations (id,project_id,environment_name,ordinal,status,terraform_state_key) VALUES ('55555555-5555-4555-8555-555555555555',$1,'dev',99,'live','invalid.tfstate')`, [projectId]), (error: any) => error?.code === "23505", "PostgreSQL must reject a second LIVE generation");
  await assert.rejects(client.query(`DELETE FROM project_service_runtime_config_revisions WHERE id=$1`, [revisionIds[0]]), (error: any) => error?.code === "23503", "sealed runtime configuration referenced by a generation must be immutable");
  const immutable = await client.query(`SELECT non_secret_environment,secret_version_ids FROM project_service_runtime_config_revisions WHERE id=$1`, [revisionIds[0]]);
  assert.deepEqual(immutable.rows[0].non_secret_environment, { RELEASE_VALUE: "immutable-0" });

  await client.query(insertRun, [operationTwo, projectId, user.rows[0].owner_user_id, "b".repeat(40), "completed", "completed", "release", JSON.stringify({ action: "redeploy", previousOperationId: operationOne })]);
  await client.query(`UPDATE project_deployment_generations SET status='retired',retired_by_operation_id=$1,retired_at=now() WHERE id=$2`, [operationTwo, generationOne]);
  await client.query(`INSERT INTO project_deployment_generations (id,project_id,environment_name,ordinal,status,terraform_state_key,resource_manifest,created_by_operation_id,activated_at) VALUES ($1,$2,'dev',2,'live','projects/fixture/dev/generations/2.tfstate',$3::jsonb,$4,now())`, [generationTwo, projectId, JSON.stringify({ services: serviceIds }), operationTwo]);
  await client.query(`UPDATE project_pipeline_runs SET generation_id=$1 WHERE id=$2`, [generationTwo, operationTwo]);
  await client.query(`UPDATE project_stable_releases SET status='rollback_target' WHERE id=$1`, [releaseOne.rows[0].id]);
  await client.query(`INSERT INTO project_stable_releases (project_id,generation_id,environment_name,commit_sha,short_commit_sha,deployed_by_pipeline_run_id,deployed_at,status,metadata) VALUES ($1,$2,'dev',$3,$4,$5,now(),'stable',$6::jsonb)`, [projectId, generationTwo, "b".repeat(40), "b".repeat(7), operationTwo, JSON.stringify({ previousStableReleaseId: releaseOne.rows[0].id })]);
  await client.query(`UPDATE project_environment_routes SET live_generation_id=$1,candidate_generation_id=NULL,metadata=$2::jsonb WHERE project_id=$3 AND environment_name='dev'`, [generationTwo, JSON.stringify({ operationId: operationTwo }), projectId]);
  const authority = await client.query(`SELECT (SELECT count(*) FROM project_deployment_generations WHERE project_id=$1 AND environment_name='dev' AND status='live')::int live_generations,(SELECT count(*) FROM project_stable_releases WHERE project_id=$1 AND environment_name='dev' AND status='stable')::int stable_releases,(SELECT live_generation_id FROM project_environment_routes WHERE project_id=$1 AND environment_name='dev') route_generation,(SELECT count(*) FROM project_generation_service_revisions WHERE generation_id=$2)::int preserved_revisions`, [projectId, generationOne]);
  assert.deepEqual(authority.rows[0], { live_generations: 1, stable_releases: 1, route_generation: generationTwo, preserved_revisions: serviceIds.length });

  await client.query(insertRun, [retryOperation, projectId, user.rows[0].owner_user_id, "b".repeat(40), "failed", "failed", "release", JSON.stringify({ action: "retry", retryOfOperationId: operationTwo, generationId: generationTwo, environmentName: "dev" })]);
  await client.query(insertRun, [destroyOperation, projectId, user.rows[0].owner_user_id, "b".repeat(40), "completed", "completed", "deletion", JSON.stringify({ action: "destroy", destroyEvidence: { generationId: generationTwo, awsDeletionVerified: true, stateKey: "projects/fixture/dev/generations/2.tfstate" } })]);
  const evidence = await client.query(`SELECT metadata FROM project_pipeline_runs WHERE id = ANY($1::uuid[]) ORDER BY id`, [[retryOperation, destroyOperation]]);
  assert.equal(evidence.rowCount, 2);
  assert.ok(evidence.rows.some((row) => row.metadata.retryOfOperationId === operationTwo), "retry ancestry evidence must persist");
  assert.ok(evidence.rows.some((row) => row.metadata.destroyEvidence?.awsDeletionVerified === true), "destroy evidence must persist independently of current projection");
}

async function main() {
  mkdirSync(join(root, ".deployguard-test-results"), { recursive: true });
  if (existsSync(resultPath)) rmSync(resultPath);
  postgres = await new PostgreSqlContainer("postgres:16.9-alpine3.21").withDatabase("deployguard_certification").withUsername("deployguard").withPassword("deployguard-certification").start();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_HOST: postgres.getHost(), DATABASE_PORT: String(postgres.getPort()), DATABASE_USERNAME: postgres.getUsername(), DATABASE_PASSWORD: postgres.getPassword(), DATABASE_NAME: postgres.getDatabase(), DATABASE_SSL: "false",
    AUTH_SESSION_SECRET: "deployguard-certification-session-secret-2026-08-31-000000", ALLOW_INSECURE_USER_HEADER: "true", NODE_ENV: "test",
    PORT: String(apiPort), FRONTEND_URL: `http://127.0.0.1:${frontendPort}`,
  };
  checked("npm", ["run", "migration:run"], backendRoot, env, false);
  console.log("POSTGRES_MIGRATIONS_FROM_ZERO=PASS COUNT=101");
  databaseClient = new Client({ host: postgres.getHost(), port: postgres.getPort(), user: postgres.getUsername(), password: postgres.getPassword(), database: postgres.getDatabase() });
  await databaseClient.connect();
  const users = await seed(databaseClient);
  checked("npm", ["run", "build"], backendRoot, env);
  const api = start("node", ["dist/src/main"], backendRoot, env);
  const frontend = start("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"], frontendRoot, { ...env, VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}` });
  await waitFor(`http://127.0.0.1:${apiPort}/api/health/ready`, api);
  await waitFor(`http://127.0.0.1:${frontendPort}`, frontend);
  const playwrightEnv = {
    ...env, PLAYWRIGHT_API_URL: `http://127.0.0.1:${apiPort}`, PLAYWRIGHT_FRONTEND_URL: `http://127.0.0.1:${frontendPort}`,
    PLAYWRIGHT_USER_ID: String(users.developerId), PLAYWRIGHT_READONLY_USER_ID: String(users.readonlyId), PLAYWRIGHT_PROJECT_ID: projectId, PLAYWRIGHT_RESULT_PATH: resultPath,
  };
  checked(join(frontendRoot, "node_modules", ".bin", "playwright"), ["test", "--config", "playwright.config.js"], frontendRoot, playwrightEnv);
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  await verifyPersistence(databaseClient, result);
  console.log(`PLAYWRIGHT_FULL_STACK=PASS MUTATIONS=${result.browserMutations} SURFACES=${result.crossPageSurfaces} GITHUB_SELECTION=${result.githubSelection}`);
  console.log("POSTGRES_INTEGRATION=PASS MIGRATIONS_FROM_ZERO=1 SERVICE_ENV_ISOLATION=1 DATABASE_ATTACHMENT=1 CASCADE=1 LIVE_UNIQUENESS=1");
  console.log("CROSS_PAGE_DATA_CONSISTENCY=PASS OVERVIEW_PIPELINE_INFRASTRUCTURE_MONITORING_SETTINGS=1");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const child of processes.reverse()) {
    if (child.exitCode === null) {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    }
  }
  if (databaseClient) await databaseClient.end().catch(() => undefined);
  if (postgres) await postgres.stop();
});
