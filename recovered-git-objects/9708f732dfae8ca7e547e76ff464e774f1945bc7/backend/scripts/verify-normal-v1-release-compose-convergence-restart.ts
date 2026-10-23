import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import IORedis from "ioredis";
import AppDataSource from "../src/data-source";
import { AppModule } from "../src/app.module";
import { AuthService, SESSION_COOKIE_NAME } from "../src/auth/auth.service";
import { DeploymentIntent } from "../src/orchestration-contracts/entities/deployment-intent.entity";
import { OrchestrationOutbox } from "../src/orchestration-contracts/entities/orchestration-outbox.entity";
import { ReleaseImageProvenance } from "../src/orchestration-contracts/entities/release-image-provenance.entity";
import { ReleaseManifest } from "../src/orchestration-contracts/entities/release-manifest.entity";
import { FrozenProtocolQueue } from "../src/orchestration-contracts/outbox/frozen-bullmq-job.adapter";
import { TerminalOutboxPolicyService } from "../src/orchestration-contracts/outbox/terminal-outbox-policy.service";
import { TransactionalDeploymentPlannerService } from "../src/orchestration-contracts/planner/transactional-deployment-planner.service";
import { createRedisConnection } from "../src/projects/pipeline/redis.config";
import {
  candidateCommit,
  projectId,
  seedPlannerEvidence,
  suffix,
} from "./verify-normal-v1-supervised-runtime-postgres-redis";

const repositoryRoot = resolve(__dirname, "../..");
const composeFile = join(repositoryRoot, "docker-compose.yml");
const service = "normal-v1-release-consumer";
const container = "deployguard-normal-v1-release-consumer";
const databaseName = `normal_v1_compose_convergence_${suffix}`;
const prefix = `normal-v1-compose-convergence-${suffix}`;
const temporary = mkdtempSync(join(tmpdir(), "deployguard-v1-compose-convergence-"));
const statusDir = join(temporary, "status");
const statusFile = join(statusDir, "status.json");
const overrideFile = join(temporary, "compose.override.yml");
const secret = "isolated-session-secret-with-more-than-thirty-two-characters";

if (!/^[a-z0-9_]+$/.test(databaseName)) {
  throw new Error("Unsafe isolated database name.");
}

function dockerCompose(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileSync("docker", ["compose", "-f", composeFile, "-f", overrideFile, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function inspect(format: string) {
  return execFileSync("docker", ["inspect", "-f", format, container], {
    encoding: "utf8",
  }).trim();
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 45_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function readStatus() {
  try {
    return JSON.parse(readFileSync(statusFile, "utf8")) as {
      state: string;
      ready: boolean;
      live: boolean;
      safeCode: string;
    };
  } catch {
    try {
      return JSON.parse(execFileSync("docker", [
        "run", "--rm", "--volumes-from", container, "node:20-bookworm-slim",
        "cat", "/run/deployguard/status.json",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as {
        state: string;
        ready: boolean;
        live: boolean;
        safeCode: string;
      };
    } catch {
      return null;
    }
  }
}

function exactEnvironment(overrides: Record<string, string> = {}) {
  return {
    TWO_LANE_NORMAL_RELEASE_CONSUMER_ENABLED: "true",
    TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: "true",
    TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED: "true",
    TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_ENABLED: "true",
    TWO_LANE_NORMAL_RELEASE_OUTCOME_RECONCILE_APPROVED: "true",
    TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_INTERVAL_MS: "60000",
    TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_MAX_ATTEMPTS: "2",
    TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_MAX_ELAPSED_MS: "60000",
    TWO_LANE_NORMAL_RELEASE_CONSUMER_STATUS_INTERVAL_MS: "250",
    TWO_LANE_RELEASE_COMPOSITION_ENABLED: "true",
    TWO_LANE_RELEASE_COMPOSITION_MODE: "production_canary",
    TWO_LANE_RELEASE_WORKER_ID: `normal-v1:compose-convergence-${suffix}`,
    TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    TWO_LANE_LATER_RELEASE_LIVE_CLIENT_ENABLED: "true",
    TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED: "true",
    TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED: "true",
    TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST: "dev",
    TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED: "true",
    TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_ENABLED: "true",
    TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_MODE: "read_only",
    TWO_LANE_EXPECTED_AWS_ACCOUNT_ID:
      process.env.TWO_LANE_EXPECTED_AWS_ACCOUNT_ID
      || process.env.TWO_LANE_CANARY_EXPECTED_AWS_ACCOUNT
      || "",
    AWS_REGION: process.env.AWS_REGION || "",
    NORMAL_V1_ISOLATED_AUTO_CONVERGENCE_FIXTURE: "true",
    ...overrides,
  };
}

async function assertNoDurableClaim(dataSource: DataSource, intentId: string) {
  const [result] = await dataSource.query(
    `SELECT
       (SELECT count(*)::integer FROM project_operation_leases
        WHERE intent_id = $1 AND status IN ('acquired','heartbeat_active')
          AND expires_at > clock_timestamp()) AS leases,
       (SELECT count(*)::integer FROM project_release_lane_ownerships
        WHERE project_id = $2 AND environment_name = 'dev'
          AND status IN ('acquired','heartbeat_active')
          AND expires_at > clock_timestamp()) AS owners,
       (SELECT count(*)::integer FROM orchestration_outbox
        WHERE intent_id = $1 AND claimed_by IS NOT NULL) AS claims`,
    [intentId, projectId],
  );
  assert.deepEqual(result, { leases: 0, owners: 0, claims: 0 });
}

async function run() {
  const options = AppDataSource.options as DataSourceOptions & {
    host?: string; port?: number; username?: string; password?: string;
  };
  const admin = new DataSource({ ...options, logging: false } as DataSourceOptions);
  let app: Awaited<ReturnType<typeof NestFactory.create>> | null = null;
  let queue: FrozenProtocolQueue | null = null;
  let redis: IORedis | null = null;
  await admin.initialize();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  try {
    const schema = new DataSource({
      ...options,
      database: databaseName,
      migrations: [],
      synchronize: true,
      logging: false,
    } as DataSourceOptions);
    await schema.initialize();
    await schema.query(`CREATE TABLE normal_v1_mock_handler_attempts (
      sequence serial PRIMARY KEY, intent_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    await schema.destroy();

    Object.assign(process.env, {
      DATABASE_HOST: String(options.host), DATABASE_PORT: String(options.port),
      DATABASE_USERNAME: String(options.username), DATABASE_PASSWORD: String(options.password),
      DATABASE_NAME: databaseName, TYPEORM_SYNCHRONIZE: "false", NODE_ENV: "test",
      AUTH_SESSION_SECRET: secret, OUTBOX_BULLMQ_PREFIX: prefix,
      TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: "true",
      TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED: "true",
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
      TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    });
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const dataSource = app.get(DataSource);
    const seeded = await seedPlannerEvidence(
      dataSource,
      app.get(TransactionalDeploymentPlannerService),
      app.get(TerminalOutboxPolicyService),
    );
    const token = app.get(AuthService).createSessionToken(seeded.user);
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${token}` };

    queue = new FrozenProtocolQueue("deployguard-release-v1", {
      connection: createRedisConnection(app.get(ConfigService)), prefix,
    });
    writeFileSync(overrideFile, `services:
  ${service}:
    command:
      - node
      - dist/scripts/run-normal-v1-release-consumer-isolated-fixture.js
    volumes:
      - ${statusDir}:/run/deployguard
    environment:
      DATABASE_NAME: ${databaseName}
      OUTBOX_BULLMQ_PREFIX: ${prefix}
      NORMAL_V1_ISOLATED_AUTO_CONVERGENCE_FIXTURE: "true"
`);
    mkdirSync(statusDir, { recursive: true });
    execFileSync("docker", ["compose", "-f", composeFile, "up", "-d", "postgres", "redis"], {
      cwd: repositoryRoot, stdio: "pipe",
    });
    await waitFor(() => {
      try {
        execFileSync("docker", ["compose", "-f", composeFile, "exec", "-T", "postgres", "pg_isready", "-U", "mini_paas_user", "-d", "mini_paas"], { cwd: repositoryRoot, stdio: "ignore" });
        return true;
      } catch { return false; }
    }, "PostgreSQL readiness");

    dockerCompose(["--profile", "normal-v1-release", "up", "-d", service], exactEnvironment());
    await waitFor(() => readStatus()?.state === "ready", "first Compose consumer readiness");
    await waitFor(
      () => inspect("{{.State.Health.Status}}") === "healthy",
      "first Compose liveness health",
    );

    const prepared = await fetch(`${baseUrl}/api/projects/${projectId}/release-lane/prepare`, {
      method: "POST", headers,
    });
    assert.equal(prepared.status, 201);
    assert.equal((await prepared.json() as any).releaseLane.state, "prepared");
    const [intent] = await dataSource.getRepository(DeploymentIntent).find({
      where: { projectId, environmentName: "dev", status: "planned" },
    });
    assert.ok(intent);
    const candidate = await dataSource.getRepository(ReleaseManifest).findOneByOrFail({ id: intent.releaseManifestId! });
    assert.equal(candidate.commitSha, candidateCommit);
    const outbox = await dataSource.getRepository(OrchestrationOutbox).findOneByOrFail({ intentId: intent.id });
    assert.equal(outbox.status, "pending");
    assert.equal(outbox.attemptCount, 0);
    const dispatched = await fetch(`${baseUrl}/api/projects/${projectId}/release-lane/dispatch`, {
      method: "POST", headers,
    });
    assert.equal(dispatched.status, 201);
    assert.equal((await dispatched.json() as any).releaseLane.state, "dispatched");
    await waitFor(async () => (await dataSource.getRepository(OrchestrationOutbox).findOneByOrFail({ id: outbox.id })).status === "published", "exact outbox publication");
    const published = await dataSource.getRepository(OrchestrationOutbox).findOneByOrFail({ id: outbox.id });
    assert.equal(published.attemptCount, 1);
    try {
      await waitFor(async () => Number((await dataSource.query("SELECT count(*)::integer AS count FROM normal_v1_mock_handler_attempts"))[0].count) === 1, "ambiguous first execution");
    } catch (error) {
      const diagnosticJob = await queue.getJob(published.publishedJobId!);
      const diagnosticIntent = await dataSource.getRepository(DeploymentIntent).findOneByOrFail({ id: intent.id });
      const [authorizationRow] = await dataSource.query(
        `SELECT actor.role AS "requestedByRole", project.owner_user_id AS "projectOwnerUserId",
                project.status AS "projectStatus", project.archived_at AS "projectArchivedAt",
                contract.commit_sha AS "contractCommitSha", contract.contract_hash AS "contractHash",
                contract.deployable AS "contractDeployable", contract.invalidated_at AS "contractInvalidatedAt",
                preflight.input_fingerprint AS "preflightFingerprint", preflight.validation_status AS "preflightStatus",
                infrastructure.revision::text AS "infrastructureRevision", release.revision::text AS "releaseRevision"
         FROM deployment_intents intent
         INNER JOIN projects project ON project.id = intent.project_id
         LEFT JOIN users actor ON actor.id = intent.requested_by_user_id
         LEFT JOIN project_deployment_contracts contract ON contract.project_id = intent.project_id
         LEFT JOIN project_preflight_reports preflight ON preflight.project_id = intent.project_id
         LEFT JOIN release_manifests release ON release.id = intent.release_manifest_id
         LEFT JOIN infrastructure_manifests infrastructure ON infrastructure.id = intent.infrastructure_manifest_id
         WHERE intent.id = $1 LIMIT 1`,
        [intent.id],
      );
      const logs = dockerCompose(["logs", "--no-color", "--tail", "80", service]);
      const containerIdentity = inspect("{{range .Config.Env}}{{println .}}{{end}}")
        .split("\n")
        .filter((line) => /^(TWO_LANE_EXPECTED_AWS_ACCOUNT_ID|AWS_REGION)=/.test(line));
      throw new Error(`${error instanceof Error ? error.message : "ambiguous execution timeout"}\njob=${await diagnosticJob?.getState()}:${diagnosticJob?.failedReason || "none"}\nintent=${diagnosticIntent.status}:${diagnosticIntent.failureCode || "none"}\nworker=${containerIdentity.join(",")}\nauthorization=${JSON.stringify(authorizationRow)}\nenvelope=${JSON.stringify(diagnosticJob?.data || null)}\n${logs}`);
    }
    await waitFor(async () => (await dataSource.getRepository(DeploymentIntent).findOneByOrFail({ id: intent.id })).status === "failed", "ambiguous durable outcome");
    await waitFor(() => readStatus()?.state === "reconciling", "first Compose reconciling health");
    const firstJob = await queue.getJob(published.publishedJobId!);
    assert.equal(await firstJob!.getState(), "failed");
    assert.equal(firstJob!.attemptsMade, 1);

    // The stopped container has a 60-second interval. Waiting beyond the
    // accelerated observation cadence proves that it cannot schedule retry.
    dockerCompose(["stop", "-t", "30", service]);
    await waitFor(() => readStatus()?.state === "stopped", "first Compose consumer stopped");
    assert.equal(inspect("{{.State.Status}}"), "exited");
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    const stoppedJob = await queue.getJob(published.publishedJobId!);
    assert.equal(await stoppedJob!.getState(), "failed");
    assert.equal(stoppedJob!.attemptsMade, 1);

    dockerCompose(["--profile", "normal-v1-release", "up", "-d", service], exactEnvironment({
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_INTERVAL_MS: "1000",
    }));
    await waitFor(() => ["ready", "reconciling", "processing"].includes(readStatus()?.state || ""), "replacement Compose consumer start");
    await waitFor(async () => (await dataSource.getRepository(DeploymentIntent).findOneByOrFail({ id: intent.id })).status === "completed", "replacement convergence completion");
    await waitFor(() => readStatus()?.state === "terminal", "terminal Compose health");

    const completed = await dataSource.getRepository(OrchestrationOutbox).findOneByOrFail({ id: outbox.id });
    assert.equal(completed.status, "published");
    assert.equal(completed.attemptCount, 1);
    const completedJob = await queue.getJob(completed.publishedJobId!);
    assert.equal(await completedJob!.getState(), "completed");
    assert.equal(completedJob!.attemptsMade, 2);
    const [attempts] = await dataSource.query("SELECT count(*)::integer AS count FROM normal_v1_mock_handler_attempts WHERE intent_id = $1", [intent.id]);
    assert.equal(attempts.count, 2);
    assert.equal(await dataSource.getRepository(ReleaseImageProvenance).countBy({ intentId: intent.id }), 1);
    const [effectSummary] = await dataSource.query(
      `SELECT count(*)::integer AS effects,
              count(*) FILTER (WHERE status = 'succeeded')::integer AS succeeded,
              count(DISTINCT effect_type)::integer AS types
       FROM deployment_side_effects WHERE intent_id = $1`,
      [intent.id],
    );
    assert.deepEqual(effectSummary, { effects: 3, succeeded: 3, types: 3 });
    await assertNoDurableClaim(dataSource, intent.id);

    dockerCompose(["stop", "-t", "30", service]);
    await waitFor(() => readStatus()?.state === "stopped", "final Compose consumer stopped");
    assert.equal(inspect("{{.State.Status}}"), "exited");
    await assertNoDurableClaim(dataSource, intent.id);
    await queue.obliterate({ force: true });
    await queue.close(); queue = null;
    await app.close(); app = null;
    redis = new IORedis({ ...createRedisConnection(new ConfigService(process.env)), lazyConnect: false });
    assert.deepEqual(await redis.keys(`${prefix}:*`), []);
    await redis.quit(); redis = null;
  } finally {
    try { dockerCompose(["rm", "-sf", service]); } catch { /* best effort */ }
    if (queue) { await queue.obliterate({ force: true }).catch(() => undefined); await queue.close().catch(() => undefined); }
    if (app) await app.close().catch(() => undefined);
    if (redis) await redis.quit().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin.destroy();
    rmSync(temporary, { recursive: true, force: true });
  }
  process.stdout.write("Normal v1 Compose convergence restart verification passed.\n");
}

run().catch((error) => {
  process.stderr.write(`Normal v1 Compose convergence restart verification failed: ${error instanceof Error ? error.stack || error.message : "unknown"}\n`);
  process.exitCode = 1;
});
