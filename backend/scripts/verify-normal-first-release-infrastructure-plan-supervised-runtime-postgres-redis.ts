import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestFactory } from "@nestjs/core";
import { DataSource, DataSourceOptions } from "typeorm";
import IORedis from "ioredis";
import AppDataSource from "../src/data-source";
import { AppModule } from "../src/app.module";
import { AuthService, SESSION_COOKIE_NAME } from "../src/auth/auth.service";
import { User, UserRole } from "../src/users/user.entity";
import { Project, ProjectStatus, ProjectVisibility } from "../src/projects/project.entity";
import { ProjectDeploymentContract } from "../src/projects/project-deployment-contract.entity";
import { ProjectPreflightReport } from "../src/projects/project-preflight-report.entity";
import { DeploymentIntent } from "../src/orchestration-contracts/entities/deployment-intent.entity";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { InitialReleaseDraft } from "../src/orchestration-contracts/entities/initial-release-draft.entity";
import { OrchestrationOutbox } from "../src/orchestration-contracts/entities/orchestration-outbox.entity";
import { FrozenProtocolQueue } from "../src/orchestration-contracts/outbox/frozen-bullmq-job.adapter";
import { workerEnvelopeJobId } from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import { createRedisConnection } from "../src/projects/pipeline/redis.config";
import { ConfigService } from "@nestjs/config";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const databaseName = `normal_first_infra_${suffix}`;
const projectId = randomUUID();
const foreignProjectId = randomUUID();
const commit = "a".repeat(40);
const prefix = `normal-first-infra-${suffix}`;
const sessionSecret = "isolated-session-secret-with-more-than-thirty-two-characters";
const managedDatabaseSoak = process.env.NORMAL_FIRST_INFRASTRUCTURE_MANAGED_DB_SOAK === "true";
let workspaceRoot = "";

if (!/^[a-z0-9_]+$/.test(databaseName)) throw new Error("Unsafe isolated database name.");

function databaseOptions(database: string): DataSourceOptions {
  return { ...AppDataSource.options, database, migrations: [], logging: false } as DataSourceOptions;
}

async function waitFor(condition: () => Promise<boolean> | boolean, label: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}.`);
}

function waitForExit(child: ChildProcess) {
  return new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

async function seed(dataSource: DataSource) {
  const user = await dataSource.getRepository(User).save({
    githubId: `normal-first-infra-${suffix}`,
    name: "Isolated Developer", email: `normal-first-infra-${suffix}@example.invalid`,
    passwordHash: null, image: null, githubLogin: null, githubAccessToken: null,
    lastLoginAt: null, role: UserRole.ADMIN,
  });
  await dataSource.getRepository(Project).save({
    id: projectId, ownerUserId: user.id, name: "Isolated first release project",
    description: null, repositoryUrl: "https://example.invalid/isolated/first-release",
    repositoryProvider: "github", githubRepositoryId: null,
    repositoryFullName: "isolated/first-release", targetBranch: "main", environmentName: "dev",
    appDirectory: ".", deploymentOverrides: {}, status: ProjectStatus.CONFIGURED,
    visibility: ProjectVisibility.PRIVATE, archivedAt: null, deletionFenceToken: null,
    deletionIntentId: null, deletionStartedAt: null,
  });
  const contractHash = createHash("sha256").update(`first-release-contract-${suffix}`).digest("hex");
  await dataSource.getRepository(ProjectDeploymentContract).save({
    projectId, detectionProfileId: null, repositoryFullName: "isolated/first-release", branch: "main",
    commitSha: commit, appRoot: ".", language: "javascript", framework: "express", runtimeType: "server",
    packageManager: "npm", dependencyManifest: "package.json", lockfile: "package-lock.json",
    nodeVersion: "20", pythonVersion: null, installCommand: "npm ci", buildCommand: "npm run build",
    startCommand: "npm start", outputDirectory: null, port: 3000, portSource: "detected",
    bindsToPortEnv: true, bindHost: "0.0.0.0", healthPath: "/health", requiredEnvVars: [],
    optionalEnvVars: [], buildTimeEnvVars: [], runtimeEnvVars: [], secretEnvVars: [], missingEnvVars: [],
    databaseRequired: managedDatabaseSoak, databaseEngine: managedDatabaseSoak ? "postgres" : null, persistentStorageRequired: false,
    privateRegistryRequired: false, dockerStrategy: "generated", dockerTemplate: "node-server",
    ecsPlan: { containerPort: 3000, targetGroupPort: 3000, healthCheckPath: "/health", command: "npm start", cpu: 256, memory: 512, environmentMappings: [], secretMappings: [], database: { required: managedDatabaseSoak, provider: managedDatabaseSoak ? "managed" : "none", engine: managedDatabaseSoak ? "postgres" : null, host: managedDatabaseSoak ? `db.project-${projectId}.deployguard.local` : null, port: managedDatabaseSoak ? 5432 : null, databaseName: managedDatabaseSoak ? "smart_retail" : null, databaseUser: managedDatabaseSoak ? "dg_smartretail" : null, image: managedDatabaseSoak ? "postgres:16" : null, dataPath: managedDatabaseSoak ? "/var/lib/postgresql/data" : null, persistenceEnabled: managedDatabaseSoak } },
    deployable: true, blockers: [], warnings: [], confidence: "high", generatedAt: new Date(),
    detectionSourceCommit: commit, overridesHash: "a".repeat(64), contractHash,
    generatedDockerfile: null, invalidatedReason: null, invalidatedAt: null,
  });
  await dataSource.getRepository(ProjectPreflightReport).save({
    projectId, detectionProfileId: null, inputFingerprint: contractHash, templateKey: "node-server",
    templateDisplayName: "Node server", ecosystem: "javascript", framework: "express",
    frameworkVariant: null, packageManager: "npm", runtimeVersion: "20", expectedPort: 3000,
    buildCommand: "npm run build", startCommand: "npm start", healthCheckPath: "/health",
    hasDockerfile: false, dockerfileRequired: false, generatedDockerfile: null, report: {},
    validationStatus: "passed", warnings: [], errors: [],
  });
  if (managedDatabaseSoak) {
    await dataSource.query(
      `INSERT INTO project_database_tiers
         (id, project_id, required_by_detection, engine, provider, status, external_tls_required,
          internal_host, database_name, database_user, persistence_enabled, backup_enabled)
       VALUES ($1, $2, true, 'postgres', 'managed', 'pending', true, $3, 'smart_retail', 'dg_smartretail', true, true)`,
      [randomUUID(), projectId, `db.project-${projectId}.deployguard.local`],
    );
  }
  return user;
}

async function run() {
  const sourceOptions = AppDataSource.options as DataSourceOptions & { host?: string; port?: number; username?: string; password?: string };
  const admin = new DataSource(databaseOptions(String(AppDataSource.options.database)));
  let app: Awaited<ReturnType<typeof NestFactory.create>> | null = null;
  let consumer: ChildProcess | null = null;
  let queue: FrozenProtocolQueue | null = null;
  let redis: IORedis | null = null;
  let output = "";
  await admin.initialize();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  try {
    const schema = new DataSource({ ...databaseOptions(databaseName), synchronize: true } as DataSourceOptions);
    await schema.initialize();
    await schema.destroy();
    workspaceRoot = await mkdtemp(join(tmpdir(), "deployguard-normal-first-infra-"));
    Object.assign(process.env, {
      DATABASE_NAME: databaseName, DATABASE_HOST: String(sourceOptions.host), DATABASE_PORT: String(sourceOptions.port),
      DATABASE_USERNAME: String(sourceOptions.username), DATABASE_PASSWORD: String(sourceOptions.password),
      TYPEORM_SYNCHRONIZE: "false", NODE_ENV: "test", AUTH_SESSION_SECRET: sessionSecret,
      STATE_MOCK_MODE: "true", TERRAFORM_WORKING_BASE_DIR: workspaceRoot,
      TERRAFORM_NETWORK_TEMPLATE_DIR: join(process.cwd(), "terraform/base-network"),
      TWO_LANE_CANARY_PLAN_AVAILABILITY_ZONES: "us-east-1a,us-east-1b",
      TWO_LANE_CANARY_PLAN_PUBLIC_SUBNET_CIDRS: "10.253.1.0/24,10.253.2.0/24",
      TWO_LANE_CANARY_PLAN_PRIVATE_SUBNET_CIDRS: "10.253.101.0/24,10.253.102.0/24",
      TWO_LANE_CANARY_PLAN_VPC_CIDR: "10.253.0.0/16",
      TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED: "true",
      TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_EXECUTION_ENABLED: "true",
      TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_EXECUTION_ENABLED: "true",
      TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_ENABLED: "true",
      TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_LOCAL_FIXTURE_ENABLED: "true",
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId, TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
      OUTBOX_BULLMQ_PREFIX: prefix,
    });
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const dataSource = app.get(DataSource);
    const user = await seed(dataSource);
    const token = app.get(AuthService).createSessionToken(user);
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${token}` };

    // The normal authenticated planner creates the frozen parent/draft/outbox.
    const prepare = await fetch(`${baseUrl}/api/projects/${projectId}/release-lane/prepare`, { method: "POST", headers });
    assert.equal(prepare.status, 201);
    assert.equal((await prepare.json() as any).releaseLane.state, "prepared");
    const parent = await dataSource.getRepository(DeploymentIntent).findOneByOrFail({ projectId, environmentName: "dev", status: "planned" });
    assert.equal(parent.classification, "infrastructure_change");
    const manifest = await dataSource.getRepository(InfrastructureManifest).findOneByOrFail({ id: parent.infrastructureManifestId! });
    const draft = await dataSource.getRepository(InitialReleaseDraft).findOneByOrFail({ intentId: parent.id });
    const planOutbox = await dataSource.getRepository(OrchestrationOutbox).findOneByOrFail({ intentId: parent.id });
    assert.equal(manifest.status, "desired"); assert.equal(draft.infrastructureManifestId, manifest.id);
    assert.equal(planOutbox.eventType, "intent.infrastructure.plan"); assert.equal(planOutbox.status, "pending");

    const childEnvironment = {
      ...process.env,
      TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_CONSUMER_ENABLED: "true",
      TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED: "true", TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED: "true",
      TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST: projectId, TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST: "dev",
      TWO_LANE_INFRASTRUCTURE_WORKER_ID: `normal-v1:infra-${suffix}`,
      TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_CONSUMER_STATUS_FILE: join(workspaceRoot, "consumer-status.json"),
    };
    consumer = spawn(process.execPath, ["-r", "ts-node/register", "-r", "tsconfig-paths/register", "src/normal-v1-infrastructure-plan-consumer.worker.ts"], { cwd: process.cwd(), env: childEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    consumer.stdout!.on("data", (chunk) => { output += chunk.toString(); });
    consumer.stderr!.on("data", (chunk) => { output += chunk.toString(); });
    await waitFor(() => output.includes("NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_READY"), "infrastructure consumer readiness");
    consumer.kill("SIGUSR1");
    await waitFor(() => output.includes('"state":"idle"'), "idle infrastructure consumer observation");

    queue = new FrozenProtocolQueue("deployguard-infrastructure-v1", { connection: createRedisConnection(new ConfigService(process.env)), prefix });
    const unauthenticated = await fetch(`${baseUrl}/api/projects/${projectId}/release-lane/infrastructure-plan/dispatch`, { method: "POST" });
    assert.equal(unauthenticated.status, 401);
    const crossProject = await fetch(`${baseUrl}/api/projects/${foreignProjectId}/release-lane/infrastructure-plan/dispatch`, { method: "POST", headers });
    assert.equal(crossProject.status, 201);
    assert.equal((await crossProject.json() as any).infrastructurePlan.state, "blocked");
    assert.equal((await dataSource.getRepository(OrchestrationOutbox).findOneByOrFail({ id: planOutbox.id })).status, "pending");

    const firstDispatch = await fetch(`${baseUrl}/api/projects/${projectId}/release-lane/infrastructure-plan/dispatch`, { method: "POST", headers });
    assert.equal(firstDispatch.status, 201);
    assert.equal((await firstDispatch.json() as any).infrastructurePlan.state, "dispatched");
    const duplicateDispatch = await fetch(`${baseUrl}/api/projects/${projectId}/release-lane/infrastructure-plan/dispatch`, { method: "POST", headers });
    assert.equal(duplicateDispatch.status, 201);
    assert.notEqual((await duplicateDispatch.json() as any).infrastructurePlan.state, "dispatched");
    await waitFor(async () => (await dataSource.getRepository(DeploymentIntent).findOneByOrFail({ id: parent.id })).status === "plan_completed", "plan completion continuation", 120_000);

    const finalParent = await dataSource.getRepository(DeploymentIntent).findOneByOrFail({ id: parent.id });
    const finalManifest = await dataSource.getRepository(InfrastructureManifest).findOneByOrFail({ id: manifest.id });
    const finalDraft = await dataSource.getRepository(InitialReleaseDraft).findOneByOrFail({ id: draft.id });
    const finalPlanOutbox = await dataSource.getRepository(OrchestrationOutbox).findOneByOrFail({ id: planOutbox.id });
    const applyChildren = await dataSource.getRepository(DeploymentIntent).find({ where: { projectId, environmentName: "dev", kind: "apply" } });
    const applyOutboxes = await dataSource.getRepository(OrchestrationOutbox).find({ where: { eventType: "intent.infrastructure.apply" } });
    assert.equal(finalParent.status, "plan_completed");
    assert.equal(finalManifest.status, "planned"); assert.equal(finalManifest.appliedAt, null);
    assert.ok(finalManifest.planArtifactSha256); assert.ok(finalManifest.planInputFingerprint);
    if (managedDatabaseSoak) {
      const managedEvidence = finalManifest.planArtifactReference?.managedDatabase as Record<string, unknown> | undefined;
      assert.equal(finalManifest.desiredSpec.database.mode, "managed");
      assert.equal(managedEvidence?.engine, "postgres");
      assert.equal(managedEvidence?.passwordSecretReference, "terraform://database/password");
      assert.equal(managedEvidence?.internalHost, `db.project-${projectId}.deployguard.local`);
    }
    assert.deepEqual(finalDraft.releaseDraft, draft.releaseDraft);
    assert.equal(finalPlanOutbox.status, "published"); assert.equal(finalPlanOutbox.attemptCount, 1);
    assert.equal(finalPlanOutbox.publishedJobId, workerEnvelopeJobId(finalPlanOutbox.workerEnvelope));
    assert.equal(applyChildren.length, 1); assert.equal(applyChildren[0].status, "planned");
    assert.equal(applyOutboxes.length, 1); assert.equal(applyOutboxes[0].status, "pending"); assert.equal(applyOutboxes[0].attemptCount, 0);
    const journals = await dataSource.query(`SELECT count(*)::int AS count FROM deployment_side_effects WHERE intent_id = $1 AND effect_type = 'infrastructure_terraform_plan' AND status = 'succeeded'`, [parent.id]);
    assert.equal(journals[0].count, 1);
    const current = await fetch(`${baseUrl}/api/projects/${projectId}/current-state`, { headers });
    assert.equal(current.status, 200);
    assert.equal((await current.json() as any).releaseLane.intent.lifecycleCode, "FIRST_RELEASE_INFRASTRUCTURE_APPLY_AWAITING_APPROVAL");
    assert.equal((await queue.getJob(finalPlanOutbox.publishedJobId!))?.id, finalPlanOutbox.publishedJobId);
    const replay = await fetch(`${baseUrl}/api/projects/${projectId}/release-lane/infrastructure-plan/dispatch`, { method: "POST", headers });
    assert.equal(replay.status, 201);
    assert.notEqual((await replay.json() as any).infrastructurePlan.state, "dispatched");
    assert.equal((await dataSource.getRepository(OrchestrationOutbox).count({ where: { intentId: parent.id } })), 1);
    assert.equal((await dataSource.getRepository(DeploymentIntent).count({ where: { projectId, environmentName: "dev", kind: "apply" } })), 1);

    if (process.env.NORMAL_FIRST_INFRASTRUCTURE_APPLY_SOAK === "true") {
      consumer.kill("SIGTERM"); assert.equal(await waitForExit(consumer), 0); consumer = null;
      const applyOutputOffset = output.length;
      consumer = spawn(process.execPath, ["-r", "ts-node/register", "-r", "tsconfig-paths/register", "src/normal-v1-infrastructure-apply-consumer.worker.ts"], {
        cwd: process.cwd(),
        env: { ...childEnvironment, TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_CONSUMER_ENABLED: "true", TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_ENABLED: "true", TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_LOCAL_FIXTURE_ENABLED: "true", TWO_LANE_INFRASTRUCTURE_APPLY_WORKER_ID: `normal-v1:apply-${suffix}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      consumer.stdout!.on("data", (chunk) => { output += chunk.toString(); });
      consumer.stderr!.on("data", (chunk) => { output += chunk.toString(); });
      try {
        await waitFor(() => output.slice(applyOutputOffset).includes("NORMAL_V1_INFRASTRUCTURE_APPLY_CONSUMER_READY"), "infrastructure apply consumer readiness");
      } catch (error) {
        const safeCodes = [...new Set((output.slice(applyOutputOffset).match(/(?:NORMAL|CONSUMER)_[A-Z0-9_]+/g) || []))].join(",") || "NONE";
        throw new Error(`${error instanceof Error ? error.message : "Infrastructure apply consumer readiness failed"}; safeCodes=${safeCodes}`);
      }
      const applyDispatch = await fetch(`${baseUrl}/api/projects/${projectId}/release-lane/infrastructure-apply/dispatch`, { method: "POST", headers });
      assert.equal(applyDispatch.status, 201);
      assert.equal((await applyDispatch.json() as any).infrastructureApply.state, "dispatched");
      const duplicateApplyDispatch = await fetch(`${baseUrl}/api/projects/${projectId}/release-lane/infrastructure-apply/dispatch`, { method: "POST", headers });
      assert.equal(duplicateApplyDispatch.status, 201);
      assert.notEqual((await duplicateApplyDispatch.json() as any).infrastructureApply.state, "dispatched");
      await waitFor(async () => (await dataSource.getRepository(DeploymentIntent).findOneByOrFail({ id: applyChildren[0].id })).status === "completed", "infrastructure apply completion", 60_000);
      const appliedManifest = await dataSource.getRepository(InfrastructureManifest).findOneByOrFail({ id: manifest.id });
      const appliedChild = await dataSource.getRepository(DeploymentIntent).findOneByOrFail({ id: applyChildren[0].id });
      const appliedOutbox = await dataSource.getRepository(OrchestrationOutbox).findOneByOrFail({ id: applyOutboxes[0].id });
      assert.equal(appliedManifest.status, "applied"); assert.ok(appliedManifest.terraformOutputsHash); assert.ok(appliedManifest.stateVersionId);
      if (managedDatabaseSoak) {
        assert.equal(appliedManifest.terraformOutputs?.database_internal_host, `db.project-${projectId}.deployguard.local`);
        assert.equal(appliedManifest.terraformOutputs?.database_port, 5432);
        assert.equal(appliedManifest.terraformOutputs?.database_enabled, true);
      }
      assert.equal(appliedChild.status, "completed"); assert.equal(appliedOutbox.status, "published"); assert.equal(appliedOutbox.attemptCount, 1);
      assert.equal((await dataSource.query(`SELECT count(*)::int AS count FROM deployment_side_effects WHERE intent_id = $1 AND effect_type = 'infrastructure_terraform_apply' AND status = 'succeeded'`, [appliedChild.id]))[0].count, 1);
      const appliedCurrent = await fetch(`${baseUrl}/api/projects/${projectId}/current-state`, { headers });
      assert.equal(appliedCurrent.status, 200);
      assert.equal((await appliedCurrent.json() as any).releaseLane.intent.lifecycleCode, "FIRST_RELEASE_INFRASTRUCTURE_APPLIED_RELEASE_AWAITING_EXECUTION");
      assert.deepEqual((await dataSource.getRepository(InitialReleaseDraft).findOneByOrFail({ id: draft.id })).releaseDraft, draft.releaseDraft);
      assert.equal((await dataSource.getRepository(DeploymentIntent).findOneByOrFail({ id: parent.id })).status, "plan_completed");
    }

    const [durable] = await dataSource.query(`SELECT
      (SELECT count(*)::int FROM project_operation_leases WHERE project_id = $1 AND environment_name = 'dev' AND status IN ('acquired','heartbeat_active') AND expires_at > clock_timestamp()) AS leases,
      (SELECT count(*)::int FROM project_release_lane_ownerships WHERE project_id = $1 AND environment_name = 'dev' AND status IN ('acquired','heartbeat_active') AND expires_at > clock_timestamp()) AS owners,
      (SELECT count(*)::int FROM orchestration_outbox WHERE intent_id = $2 AND claimed_by IS NOT NULL) AS claims`, [projectId, parent.id]);
    assert.deepEqual(durable, { leases: 0, owners: 0, claims: 0 });

    consumer.kill("SIGTERM"); assert.equal(await waitForExit(consumer), 0); consumer = null;
    await waitFor(() => output.includes('"state":"stopped"'), "stopped infrastructure consumer observation");
    assert.equal(output.includes(projectId), false); assert.equal(output.includes(parent.id), false);
    await queue.obliterate({ force: true }); await queue.close(); queue = null;
    await app.close(); app = null;
    redis = new IORedis({ ...createRedisConnection(new ConfigService(process.env)), lazyConnect: false });
    assert.deepEqual(await redis.keys(`${prefix}:*`), []); await redis.quit(); redis = null;
    process.stdout.write("Normal first-release infrastructure-plan supervised runtime verification passed.\n");
  } finally {
    if (consumer && consumer.exitCode === null) { consumer.kill("SIGTERM"); await Promise.race([waitForExit(consumer), new Promise((resolve) => setTimeout(resolve, 5_000))]); }
    if (queue) { await queue.obliterate({ force: true }).catch(() => undefined); await queue.close().catch(() => undefined); }
    if (app) await app.close().catch(() => undefined);
    if (redis) await redis.quit().catch(() => undefined);
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.destroy();
  }
}

run().catch((error) => {
  process.stderr.write(`Normal first-release infrastructure-plan supervised runtime verification failed: ${error instanceof Error ? error.stack || error.message : "unknown"}\n`);
  process.exitCode = 1;
});
