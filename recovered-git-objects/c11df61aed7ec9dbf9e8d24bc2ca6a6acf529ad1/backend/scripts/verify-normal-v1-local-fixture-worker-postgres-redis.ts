import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
import {
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
const WebSocket: any = require("ws");
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import IORedis from "ioredis";
import AppDataSource from "../src/data-source";
import { AppModule } from "../src/app.module";
import { AuthService, SESSION_COOKIE_NAME } from "../src/auth/auth.service";
import { DeploymentIntent } from "../src/orchestration-contracts/entities/deployment-intent.entity";
import { OrchestrationOutbox } from "../src/orchestration-contracts/entities/orchestration-outbox.entity";
import { ReleaseManifest } from "../src/orchestration-contracts/entities/release-manifest.entity";
import {
  workerEnvelopeJobId,
} from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import {
  FrozenProtocolQueue,
} from "../src/orchestration-contracts/outbox/frozen-bullmq-job.adapter";
import {
  TransactionalDeploymentPlannerService,
} from "../src/orchestration-contracts/planner/transactional-deployment-planner.service";
import {
  TerminalOutboxPolicyService,
} from "../src/orchestration-contracts/outbox/terminal-outbox-policy.service";
import { createRedisConnection } from "../src/projects/pipeline/redis.config";
import { User, UserRole } from "../src/users/user.entity";
import {
  projectId,
  seedPlannerEvidence,
} from "./verify-normal-v1-supervised-runtime-postgres-redis";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const databaseName = `normal_v1_local_worker_${suffix}`;
const prefix = `normal-v1-local-worker-${suffix}`;
const healthFile = `/tmp/deployguard-normal-v1-local-worker-${suffix}.json`;
const secret = "normal-v1-local-fixture-session-secret-32-characters";
const demoHold = process.env.NORMAL_V1_LOCAL_DEMO_HOLD === "true";
const demoStateFile = process.env.NORMAL_V1_LOCAL_DEMO_STATE_FILE || "";
const failureRecoverySoak =
  process.env.NORMAL_V1_LOCAL_FAILURE_RECOVERY_SOAK === "true";

if (demoHold && demoStateFile !== "/tmp/deployguard-normal-v1-local-demo.json") {
  throw new Error("NORMAL_V1_LOCAL_DEMO_STATE_FILE_INVALID");
}

function writeDemoState(state: Record<string, unknown>) {
  if (!demoHold) return;
  const temporary = `${demoStateFile}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    ...state,
  })}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, demoStateFile);
}

if (!/^[a-z0-9_]+$/.test(databaseName)) {
  throw new Error("UNSAFE_LOCAL_FIXTURE_DATABASE_NAME");
}

function databaseOptions(database: string): DataSourceOptions {
  return {
    ...AppDataSource.options,
    database,
    migrations: [],
    logging: false,
  } as DataSourceOptions;
}

async function waitFor(
  condition: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`TIMED_OUT_WAITING_FOR_${label.toUpperCase().replace(/\W+/g, "_")}`);
}

async function childExit(child: ChildProcess) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

type CdpClient = {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
};

async function connectCdp(port: number): Promise<CdpClient> {
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/json/list`)).ok;
    } catch {
      return false;
    }
  }, "browser debugger");
  const targets = await (await fetch(
    `http://127.0.0.1:${port}/json/list`,
  )).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const target = targets.find((entry) => entry.type === "page");
  assert.ok(target?.webSocketDebuggerUrl);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let nextId = 1;
  const pending = new Map<number, {
    resolve(value: any): void;
    reject(error: Error): void;
  }>();
  socket.on("message", (raw: Buffer) => {
    const message = JSON.parse(raw.toString()) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message || "CDP command failed"));
    } else request.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: async () => {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    },
  };
}

async function run() {
  const source = AppDataSource.options as DataSourceOptions & {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
  };
  const operationalDatabase = String(source.database);
  assert.notEqual(databaseName, operationalDatabase);
  assert.notEqual(databaseName, "mini_paas");

  const admin = new DataSource(databaseOptions(operationalDatabase));
  let app: Awaited<ReturnType<typeof NestFactory.create>> | null = null;
  let worker: ChildProcess | null = null;
  let vite: ChildProcess | null = null;
  let browser: ChildProcess | null = null;
  let cdp: CdpClient | null = null;
  let queue: FrozenProtocolQueue | null = null;
  let redis: IORedis | null = null;
  let workerOutput = "";
  let viteOutput = "";
  let fixtureCreated = false;
  let runSucceeded = false;
  let demoEvidence: Record<string, unknown> = {};
  let shutdownRequested = false;
  let requestShutdown: (() => void) | null = null;
  const shutdown = new Promise<void>((resolve) => {
    requestShutdown = resolve;
  });
  const onShutdown = () => {
    shutdownRequested = true;
    requestShutdown?.();
  };
  if (demoHold) {
    process.once("SIGINT", onShutdown);
    process.once("SIGTERM", onShutdown);
  }

  await admin.initialize();
  const existing = await admin.query(
    `SELECT datname FROM pg_database WHERE datname = $1`,
    [databaseName],
  );
  assert.equal(existing.length, 0);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  fixtureCreated = true;

  try {
    const schema = new DataSource({
      ...databaseOptions(databaseName),
      synchronize: true,
    } as DataSourceOptions);
    await schema.initialize();
    await schema.destroy();

    Object.assign(process.env, {
      DATABASE_NAME: databaseName,
      DATABASE_HOST: String(source.host),
      DATABASE_PORT: String(source.port),
      DATABASE_USERNAME: String(source.username),
      DATABASE_PASSWORD: String(source.password),
      TYPEORM_SYNCHRONIZE: "false",
      AUTH_SESSION_SECRET: secret,
      NODE_ENV: "test",
      AWS_REGION: "us-east-1",
      BILLING_PROVIDER_ENABLED: "false",
      NOTIFICATION_DELIVERY_ENABLED: "false",
      OUTBOX_BULLMQ_PREFIX: prefix,
      TWO_LANE_RELEASE_COMPOSITION_ENABLED: "true",
      TWO_LANE_RELEASE_COMPOSITION_MODE: "fixture",
      TWO_LANE_LOCAL_RELEASE_FIXTURE_EXECUTION_ENABLED: "true",
      TWO_LANE_LOCAL_RELEASE_FIXTURE_OUTCOME:
        failureRecoverySoak ? "ambiguous_once" : "healthy",
      TWO_LANE_RELEASE_WORKER_ID: `normal-v1:local-fixture-${suffix}`,
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
      TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
      TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: "true",
      TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED: "false",
      TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_PLANNING_ENABLED: "false",
      TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_EXECUTION_ENABLED: "false",
      TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED: "true",
      TWO_LANE_NORMAL_RELEASE_CONSUMER_ENABLED: "true",
      TWO_LANE_NORMAL_AUTOMATIC_DEPLOY_ENABLED: "true",
      NORMAL_V1_AUTOMATIC_CONTINUATION_INTERVAL_MS: "1000",
      TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED: "true",
      TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED: "true",
      TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST: projectId,
      TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST: "dev",
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_ENABLED:
        failureRecoverySoak ? "true" : "false",
      TWO_LANE_NORMAL_RELEASE_OUTCOME_RECONCILE_APPROVED:
        failureRecoverySoak ? "true" : "false",
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_INTERVAL_MS: "10000",
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_MAX_ATTEMPTS: "2",
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_MAX_ELAPSED_MS: "60000",
      TWO_LANE_LATER_RELEASE_LIVE_CLIENT_ENABLED: "false",
      TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED: "false",
      TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_ENABLED: "false",
      TWO_LANE_NORMAL_RELEASE_CONSUMER_STATUS_FILE: healthFile,
      TWO_LANE_NORMAL_RELEASE_CONSUMER_STATUS_INTERVAL_MS: "5000",
    });

    app = await NestFactory.create(AppModule, {
      logger: false,
      abortOnError: false,
    });
    app.enableCors({ origin: true, credentials: true });
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
    const auth = app.get(AuthService);
    await dataSource.getRepository(User).update(seeded.user.id, {
      role: UserRole.DEVELOPER,
    });
    const developerUser = await dataSource.getRepository(User)
      .findOneByOrFail({ id: seeded.user.id });
    const fixtureAdmin = await dataSource.getRepository(User).save({
      githubId: `local-fixture-admin-${suffix}`,
      name: "Local fixture operator",
      email: `local-fixture-admin-${suffix}@example.invalid`,
      passwordHash: null,
      image: null,
      githubLogin: null,
      githubAccessToken: null,
      lastLoginAt: null,
      role: UserRole.ADMIN,
    });
    const cookie =
      `${SESSION_COOKIE_NAME}=${auth.createSessionToken(developerUser)}`;
    const adminCookie =
      `${SESSION_COOKIE_NAME}=${auth.createSessionToken(fixtureAdmin)}`;
    const initialCurrentStateResponse = await fetch(
      `${baseUrl}/api/projects/${projectId}/current-state`,
      { headers: { cookie } },
    );
    assert.equal(initialCurrentStateResponse.status, 200);
    const initialCurrentState = await initialCurrentStateResponse.json() as any;
    process.stdout.write(`${JSON.stringify({
      checkpoint: "initial-canonical-state",
      developerState: initialCurrentState.developerState,
      developerAction: initialCurrentState.developerAction,
    })}\n`);
    assert.equal(initialCurrentState.developerState, "ready");
    assert.ok(["deploy", "redeploy"].includes(initialCurrentState.developerAction));
    assert.equal("releaseLane" in initialCurrentState, false);

    worker = spawn(
      process.execPath,
      [
        "-r",
        "ts-node/register",
        "-r",
        "tsconfig-paths/register",
        "src/normal-v1-release-consumer.worker.ts",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    worker.stdout!.on("data", (chunk) => {
      workerOutput += chunk.toString();
    });
    worker.stderr!.on("data", (chunk) => {
      workerOutput += chunk.toString();
    });
    await waitFor(
      () => workerOutput.includes("NORMAL_V1_RELEASE_CONSUMER_READY"),
      "worker ready",
    );
    assert.equal(worker.exitCode, null);
    const readyHealth = JSON.parse(readFileSync(healthFile, "utf8"));
    assert.equal(readyHealth.state, "ready");
    assert.equal(readyHealth.ready, true);

    vite = spawn(
      `${process.cwd()}/../frontend/node_modules/.bin/vite`,
      ["--host", "127.0.0.1", "--port", "0"],
      {
        cwd: `${process.cwd()}/../frontend`,
        env: { ...process.env, VITE_API_BASE_URL: baseUrl },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    vite.stdout!.on("data", (chunk) => { viteOutput += chunk.toString(); });
    vite.stderr!.on("data", (chunk) => { viteOutput += chunk.toString(); });
    await waitFor(
      () => /http:\/\/127\.0\.0\.1:\d+\//.test(viteOutput),
      "frontend ready",
    );
    const frontendUrl = viteOutput
      .match(/http:\/\/127\.0\.0\.1:\d+\//)![0]
      .replace(/\/$/, "");
    const debugPort = 9400 + parseInt(suffix.slice(-2), 16) % 400;
    browser = spawn("/usr/bin/google-chrome", [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=/tmp/deployguard-normal-v1-overview-${suffix}`,
      "about:blank",
    ], { stdio: "ignore" });
    cdp = await connectCdp(debugPort);
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => { const original = window.fetch.bind(window); window.__deployGuardRequests = []; window.fetch = (input, init = {}) => { window.__deployGuardRequests.push({ url: String(input), method: init.method || "GET" }); return original(input, init); }; })();`,
    });
    await cdp.send("Network.setCookie", {
      url: baseUrl,
      name: SESSION_COOKIE_NAME,
      value: cookie.slice(cookie.indexOf("=") + 1),
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    });
    await cdp.send("Page.navigate", {
      url: `${frontendUrl}/projects/${projectId}`,
    });
    await waitFor(
      async () => {
        const result = await cdp!.send("Runtime.evaluate", {
          expression: `Boolean(document.querySelector('.simple-primary-actions button'))`,
          returnByValue: true,
        });
        return result.result.value === true;
      },
      "overview deployment action",
    );
    await cdp.send("Runtime.evaluate", {
      expression: `(() => { const button = document.querySelector('.simple-primary-actions button'); if (!button) throw new Error("Normal release action unavailable"); button.click(); button.click(); })()`,
      awaitPromise: true,
    });
    await waitFor(async () => {
      const count = await dataSource.getRepository(DeploymentIntent).count({
        where: { projectId, environmentName: "dev", classification: "release_only" },
      });
      return count === 1;
    }, "overview prepared intent");
    const planned = await dataSource.getRepository(DeploymentIntent).find({
      where: {
        projectId,
        environmentName: "dev",
        classification: "release_only",
      },
    });
    assert.equal(planned.length, 1);
    const intentId = planned[0].id;
    const outbox = await dataSource.getRepository(OrchestrationOutbox)
      .findOneByOrFail({ intentId });
    await waitFor(async () => {
      const observed = await cdp!.send("Runtime.evaluate", {
        expression: "window.__deployGuardRequests",
        returnByValue: true,
      });
      const requests = observed.result.value as Array<{
        url: string;
        method: string;
      }>;
      return requests.filter((request) =>
        request.method === "POST"
        && request.url.endsWith(`/api/projects/${projectId}/deploy`)
      ).length === 1;
    }, "overview deployment command request");
    const browserRequests = await cdp.send("Runtime.evaluate", {
      expression: "window.__deployGuardRequests",
      returnByValue: true,
    });
    const requestLog = browserRequests.result.value as Array<{
      url: string;
      method: string;
    }>;
    assert.equal(requestLog.filter((request) =>
      request.method === "POST"
      && request.url.endsWith(`/api/projects/${projectId}/deploy`)
    ).length, 1);
    assert.equal(requestLog.some((request) =>
      request.url.includes("/release-lane/prepare")
      || request.url.includes("/release-lane/dispatch")
    ), false);
    assert.equal(requestLog.some((request) =>
      /automation\/start|infrastructure\/deploy|orchestration\/deploy|approve-apply|\/retry|\/cancel/.test(request.url)
    ), false);

    queue = new FrozenProtocolQueue("deployguard-release-v1", {
      connection: createRedisConnection(app.get(ConfigService)),
      prefix,
    });
    if (failureRecoverySoak) {
      await waitFor(async () => {
        const intent = await dataSource.getRepository(DeploymentIntent)
          .findOneByOrFail({ id: intentId });
        return intent.status === "failed"
          && intent.failureCode === "RELEASE_EVIDENCE_AMBIGUOUS";
      }, "durable ambiguous failure");
      const failedJob = await queue.getJob(
        workerEnvelopeJobId(outbox.workerEnvelope),
      );
      assert.ok(failedJob);
      await waitFor(
        async () => (await failedJob!.getState()) === "failed",
        "ambiguous job failure",
      );
      const persistedFailedJob = await queue.getJob(
        workerEnvelopeJobId(outbox.workerEnvelope),
      );
      assert.ok(persistedFailedJob);
      assert.equal(persistedFailedJob.attemptsMade, 1);
      const reconcilingResponse = await fetch(
        `${baseUrl}/api/projects/${projectId}/current-state/details`,
        { headers: { cookie: adminCookie } },
      );
      assert.equal(reconcilingResponse.status, 200);
      const reconcilingState = await reconcilingResponse.json() as any;
      assert.equal(reconcilingState.releaseLane.state, "reconciling");
      assert.equal(
        reconcilingState.releaseLane.intent.operation.latestAttempt.status,
        "reconciling",
      );
      assert.equal(
        reconcilingState.releaseLane.intent.operation.terminalResult,
        null,
      );
      assert.equal(reconcilingState.activeRunCount, 1);
      await cdp.send("Page.reload", { ignoreCache: true });
      await waitFor(async () => {
        const result = await cdp!.send("Runtime.evaluate", {
          expression: `document.querySelector('[data-canonical-deployment-view]')?.getAttribute('data-developer-state') === 'verifying'`,
          returnByValue: true,
        });
        return result.result.value === true;
      }, "overview verifying recovery state");
      const reconcilingView = await cdp.send("Runtime.evaluate", {
        expression: `(() => ({
          operation: document.querySelector('[data-canonical-deployment-view]')?.getAttribute('data-developer-state'),
          body: document.body.textContent,
        }))()`,
        returnByValue: true,
      });
      assert.match(
        reconcilingView.result.value.body,
        /DeployGuard is verifying the deployment\. No action is required\./,
      );
      assert.equal(reconcilingView.result.value.operation, "verifying");
      assert.equal(
        /Retry deployment|Cancel run|Approve infrastructure changes/.test(
          reconcilingView.result.value.body,
        ),
        false,
      );
    }
    await waitFor(async () => {
      const intent = await dataSource.getRepository(DeploymentIntent)
        .findOneByOrFail({ id: intentId });
      return intent.status === "completed";
    }, "durable completion");
    const published = await dataSource.getRepository(OrchestrationOutbox)
      .findOneByOrFail({ id: outbox.id });
    assert.equal(published.status, "published");
    assert.equal(published.attemptCount, 1);
    assert.equal(
      published.publishedJobId,
      workerEnvelopeJobId(published.workerEnvelope),
    );
    const job = await queue.getJob(published.publishedJobId!);
    assert.ok(job);
    await waitFor(async () => (await job!.getState()) === "completed", "job completion");
    // BullMQ does not refresh the in-memory Job fields when getState() is
    // polled. Reload before asserting the persisted delivery attempt.
    const completedJob = await queue.getJob(published.publishedJobId!);
    assert.ok(completedJob);
    assert.equal(completedJob.attemptsMade, failureRecoverySoak ? 2 : 1);

    const [durable] = await dataSource.query(
      `SELECT
         (SELECT count(*)::integer FROM release_image_provenances
          WHERE intent_id = $1) AS provenances,
         (SELECT count(*)::integer FROM deployment_side_effects
          WHERE intent_id = $1 AND status = 'succeeded') AS succeeded_effects,
         (SELECT count(*)::integer FROM project_operation_leases
          WHERE intent_id = $1 AND status IN ('acquired','heartbeat_active')
            AND expires_at > clock_timestamp()) AS active_leases,
         (SELECT count(*)::integer FROM project_release_lane_ownerships
          WHERE project_id = $2 AND environment_name = 'dev'
            AND status IN ('acquired','heartbeat_active')
            AND expires_at > clock_timestamp()) AS active_owners,
         (SELECT count(*)::integer FROM orchestration_outbox
          WHERE id = $3 AND claimed_by IS NOT NULL) AS claims`,
      [intentId, projectId, outbox.id],
    );
    assert.deepEqual(durable, {
      provenances: 1,
      succeeded_effects: 3,
      active_leases: 0,
      active_owners: 0,
      claims: 0,
    });
    if (failureRecoverySoak) {
      const [recovery] = await dataSource.query(
        `SELECT
           (SELECT count(*)::integer FROM audit_logs
             WHERE action = 'normal_release.resume_for_outcome_reconciliation'
               AND resource_id = $1::text) AS resumes,
           (SELECT count(*)::integer FROM orchestration_outbox
             WHERE intent_id = $1::uuid AND attempt_count = 1
               AND status = 'published') AS publications,
           (SELECT count(*)::integer FROM deployment_side_effects
             WHERE intent_id = $1::uuid) AS effects`,
        [intentId],
      );
      assert.deepEqual(recovery, {
        resumes: 1,
        publications: 1,
        effects: 3,
      });
    }
    const candidate = await dataSource.getRepository(ReleaseManifest)
      .findOneByOrFail({ id: planned[0].releaseManifestId! });
    assert.equal(candidate.status, "stable");
    assert.match(candidate.imageDigest ?? "", /^sha256:[0-9a-f]{64}$/);
    const current = await fetch(
      `${baseUrl}/api/projects/${projectId}/current-state/details`,
      { headers: { cookie: adminCookie } },
    );
    if (current.status !== 200) {
      throw new Error(
        `CURRENT_STATE_REQUEST_FAILED_${current.status}_${await current.text()}`,
      );
    }
    const currentState = await current.json() as any;
    assert.equal(currentState.releaseLane.state, "completed");
    assert.equal(currentState.releaseLane.intent.status, "completed");
    assert.equal(
      currentState.releaseLane.stableRelease.revision,
      candidate.revision,
    );
    assert.deepEqual(
      currentState.releaseLane.intent.operation.phases.map(
        (phase: { label: string; status: string }) =>
          [phase.label, phase.status],
      ),
      [
        ["Analyze", "passed"],
        ["Build", "passed"],
        ["Prepare", "passed"],
        ["Deploy", "passed"],
        ["Verify", "passed"],
      ],
    );
    assert.equal(
      currentState.releaseLane.intent.operation.terminalResult,
      "live",
    );
    assert.equal(
      currentState.releaseLane.intent.operation.evidence.preflight.state,
      "passed",
    );
    assert.equal(
      currentState.releaseLane.intent.operation.evidence.preflight.safeCode,
      "NORMAL_RELEASE_PREFLIGHT_PASSED",
    );
    assert.match(
      currentState.releaseLane.intent.operation.evidence.preflight.observedAt,
      /^\d{4}-\d{2}-\d{2}T/,
    );
    const observability = currentState.releaseLane.intent.operation.observability;
    assert.deepEqual(observability.serviceHealth, {
      state: "healthy",
      safeCode: "NORMAL_RELEASE_SERVICE_HEALTHY",
      observedAt: candidate.healthVerifiedAt.toISOString(),
    });
    assert.equal(observability.metrics.completedPhases, 5);
    assert.equal(observability.metrics.totalPhases, 5);
    assert.equal(observability.metrics.succeededEffects, 3);
    assert.equal(observability.metrics.totalEffects, 3);
    assert.equal(Number.isSafeInteger(observability.metrics.durationMs), true);
    assert.deepEqual(
      observability.events.map((event: any) => event.phase),
      ["analyze", "build", "prepare", "deploy", "verify"],
    );
    assert.deepEqual(
      observability.logs.map((entry: any) => entry.label),
      [
        "Immutable image prepared",
        "Runtime definition prepared",
        "Service update requested",
      ],
    );
    const serializedObservability = JSON.stringify(observability);
    for (const forbidden of [
      intentId,
      projectId,
      "ownerWorkerId",
      "fencingToken",
      "leaseId",
      "externalReferenceHash",
      "requestFingerprint",
    ]) assert.equal(serializedObservability.includes(forbidden), false);
    assert.equal(currentState.activeRunCount, 0);

    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(async () => {
      const result = await cdp!.send("Runtime.evaluate", {
        expression: `document.querySelector('[data-canonical-deployment-view]')?.getAttribute('data-developer-state') === 'live'`,
        returnByValue: true,
      });
      return result.result.value === true;
    }, "overview canonical release phases after refresh");
    const rendered = await cdp.send("Runtime.evaluate", {
      expression: `(() => { const panel = document.querySelector('[data-canonical-deployment-view]'); return ({
        operation: panel?.getAttribute('data-developer-state'),
        panelVisible: Boolean(panel && panel.getBoundingClientRect().width > 0 && panel.getBoundingClientRect().height > 0),
        phases: [...document.querySelectorAll('[data-phase]')].map((node) => ({ phase: node.getAttribute('data-phase'), status: node.getAttribute('data-status') })),
        body: document.body.textContent,
      }); })()`,
      returnByValue: true,
    });
    assert.equal(rendered.result.value.operation, "live");
    assert.equal(rendered.result.value.panelVisible, true);
    assert.deepEqual(rendered.result.value.phases, [
      { phase: "analyze", status: "passed" },
      { phase: "build", status: "passed" },
      { phase: "prepare", status: "passed" },
      { phase: "deploy", status: "passed" },
      { phase: "verify", status: "passed" },
    ]);
    for (const visibleEvidence of [
      "Latest attempt",
      `Release ${candidate.revision}`,
      "Analyze",
      "Build",
      "Prepare",
      "Deploy",
      "Verify",
      "Live",
      "Stable release",
    ]) {
      assert.equal(
        rendered.result.value.body.includes(visibleEvidence),
        true,
        `Missing rendered Overview evidence: ${visibleEvidence}`,
      );
    }
    for (const hiddenControl of [
      "Approve infrastructure changes",
      "Retry deployment",
      "Cancel run",
      "Terraform apply",
    ]) {
      assert.equal(rendered.result.value.body.includes(hiddenControl), false);
    }

    await cdp.send("Page.navigate", {
      url: `${frontendUrl}/projects/${projectId}/pipeline`,
    });
    await waitFor(async () => {
      const result = await cdp!.send("Runtime.evaluate", {
        expression: `document.querySelector('[data-canonical-deployment-view]')?.getAttribute('data-developer-state') === 'live'`,
        returnByValue: true,
      });
      return result.result.value === true;
    }, "pipeline canonical release operation");
    const pipelineView = await cdp.send("Runtime.evaluate", {
      expression: `(() => ({
        body: document.body.textContent,
        phases: [...document.querySelectorAll('[data-phase]')].map((node) => node.getAttribute('data-phase')),
        requests: window.__deployGuardRequests,
      }))()`,
      returnByValue: true,
    });
    assert.deepEqual(pipelineView.result.value.phases, [
      "analyze", "build", "prepare", "deploy", "verify",
    ]);
    assert.match(pipelineView.result.value.body, /Latest attempt/);
    assert.match(pipelineView.result.value.body, /Stable release/);
    assert.equal(pipelineView.result.value.body.includes("Run history"), false);
    assert.equal(pipelineView.result.value.body.includes("Terraform approval"), false);
    assert.equal(
      pipelineView.result.value.requests.some((request: any) =>
        request.url.includes(`/api/projects/${projectId}/pipeline/runs`)),
      false,
    );
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(async () => {
      const result = await cdp!.send("Runtime.evaluate", {
        expression: `document.querySelector('[data-canonical-deployment-view]')?.getAttribute('data-developer-state') === 'live'`,
        returnByValue: true,
      });
      return result.result.value === true;
    }, "pipeline canonical operation after refresh");

    await cdp.send("Page.navigate", { url: `${frontendUrl}/dashboard` });
    await waitFor(async () => {
      const result = await cdp!.send("Runtime.evaluate", {
        expression: `Boolean(document.querySelector('[data-workspace-release="live"]'))`,
        returnByValue: true,
      });
      return result.result.value === true;
    }, "dashboard canonical release state");
    const dashboardView = await cdp.send("Runtime.evaluate", {
      expression: `(() => ({ body: document.body.textContent, requests: window.__deployGuardRequests }))()`,
      returnByValue: true,
    });
    assert.match(dashboardView.result.value.body, new RegExp(`Stable release ${candidate.revision}`));
    assert.equal(dashboardView.result.value.body.includes("Cloud Cleanup"), false);
    assert.equal(dashboardView.result.value.body.includes("Activity Log"), false);
    const dashboardWorkspaceRequests = dashboardView.result.value.requests
      .filter((request: any) =>
        request.url.includes("/api/projects/workspace-summary"));
    // Vite's development React Strict Mode may replay the read-only effect.
    // Both calls must remain the same authoritative boundary, never N+1.
    assert.ok(dashboardWorkspaceRequests.length >= 1);
    assert.ok(dashboardWorkspaceRequests.length <= 2);
    assert.equal(new Set(dashboardWorkspaceRequests.map(
      (request: any) => request.url,
    )).size, 1);
    assert.equal(
      dashboardView.result.value.requests.some((request: any) =>
        request.url.includes(`/api/projects/${projectId}/current-state`)),
      false,
    );
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(async () => {
      const result = await cdp!.send("Runtime.evaluate", {
        expression: `Boolean(document.querySelector('[data-workspace-release="live"]'))`,
        returnByValue: true,
      });
      return result.result.value === true;
    }, "dashboard canonical state after refresh");

    await cdp.send("Page.navigate", { url: `${frontendUrl}/billing` });
    await waitFor(async () => {
      const result = await cdp!.send("Runtime.evaluate", {
        expression: `Boolean(document.querySelector('[aria-label="Current canonical release state"] [data-workspace-release="live"]'))`,
        returnByValue: true,
      });
      return result.result.value === true;
    }, "plan usage canonical release state");
    const billingView = await cdp.send("Runtime.evaluate", {
      expression: `(() => ({ body: document.body.textContent, requests: window.__deployGuardRequests }))()`,
      returnByValue: true,
    });
    assert.match(billingView.result.value.body, /Latest attempted and stable releases/);
    assert.match(billingView.result.value.body, new RegExp(`Release ${candidate.revision} \\u00b7 Live`));
    assert.match(billingView.result.value.body, new RegExp(`Stable release ${candidate.revision}`));
    const billingWorkspaceRequests = billingView.result.value.requests
      .filter((request: any) =>
        request.url.includes("/api/projects/workspace-summary"));
    assert.ok(billingWorkspaceRequests.length >= 1);
    assert.ok(billingWorkspaceRequests.length <= 2);
    assert.equal(new Set(billingWorkspaceRequests.map(
      (request: any) => request.url,
    )).size, 1);
    assert.equal(
      billingView.result.value.requests.some((request: any) =>
        request.url.includes(`/api/projects/${projectId}/current-state`)),
      false,
    );
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(async () => {
      const result = await cdp!.send("Runtime.evaluate", {
        expression: `Boolean(document.querySelector('[aria-label="Current canonical release state"] [data-workspace-release="live"]'))`,
        returnByValue: true,
      });
      return result.result.value === true;
    }, "plan usage canonical state after refresh");

    worker.kill("SIGUSR1");
    await waitFor(
      () => workerOutput.includes('"state":"terminal"'),
      "terminal observation",
    );
    assert.equal(workerOutput.includes(projectId), false);
    assert.equal(workerOutput.includes(intentId), false);
    assert.equal(workerOutput.includes("fencingToken"), false);

    await cdp.close();
    cdp = null;
    browser.kill("SIGTERM");
    await childExit(browser);
    browser = null;

    demoEvidence = {
      pid: process.pid,
      backendUrl: baseUrl,
      frontendUrl,
      projectScope: "disposable/dev",
      operationId: intentId,
      jobId: published.publishedJobId,
      workerReadyObserved: true,
      workerReadyCode: "NORMAL_V1_RELEASE_CONSUMER_READY",
      workerState: "terminal",
      currentState: currentState.releaseLane.state,
      renderedOverview:
        "Analyze/Build/Prepare/Deploy/Verify=passed; result=Live",
      operationSignals:
        "phases=5/5; developer-internals=absent",
      crossPageState:
        "overview=pipeline=dashboard=plan-usage:release-completed/stable",
      recoveryState: failureRecoverySoak
        ? "ambiguous-failed=reconciling; same-job-retry=completed; effects=3"
        : "not_requested",
      networkEvidence: "deploy-command=1; legacy-mutations=0",
      durableEvidence:
        "outbox-publications=1; provenance=1; effects=3; leases=0; owners=0; claims=0",
      queueConsumption: "exactly_once",
      cloudExecution: "not_reachable",
      dependenciesStartedByDemo: (
        process.env.NORMAL_V1_LOCAL_DEMO_STARTED_DEPENDENCIES || ""
      ).split(",").filter(Boolean),
      dependenciesCreatedByDemo: (
        process.env.NORMAL_V1_LOCAL_DEMO_CREATED_DEPENDENCIES || ""
      ).split(",").filter(Boolean),
      networkCreatedByDemo: Boolean(
        process.env.NORMAL_V1_LOCAL_DEMO_CREATED_NETWORK,
      ),
      networkName:
        process.env.NORMAL_V1_LOCAL_DEMO_CREATED_NETWORK || undefined,
    };
    if (demoHold) {
      writeDemoState({ state: "ready", ready: true, ...demoEvidence });
      if (!shutdownRequested) await shutdown;
      writeDemoState({ state: "stopping", ready: false, ...demoEvidence });
    }

    worker.kill("SIGTERM");
    assert.equal(await childExit(worker), 0);
    await waitFor(
      () => workerOutput.includes('"state":"stopping"')
        && workerOutput.includes('"state":"stopped"'),
      "worker stopped",
    );
    worker = null;

    const stoppedHealth = JSON.parse(readFileSync(healthFile, "utf8"));
    assert.equal(stoppedHealth.state, "stopped");
    assert.equal(stoppedHealth.ready, false);

    vite.kill("SIGTERM");
    const viteExitCode = await childExit(vite);
    assert.ok(
      viteExitCode === 0
      || (viteExitCode === null && vite.signalCode === "SIGTERM"),
    );
    vite = null;

    await queue.obliterate({ force: true });
    await queue.close();
    queue = null;
    await app.close();
    app = null;

    redis = new IORedis({
      ...createRedisConnection(new ConfigService(process.env)),
      lazyConnect: false,
    });
    assert.deepEqual(await redis.keys(`${prefix}:*`), []);
    await redis.quit();
    redis = null;

    process.stdout.write(`${JSON.stringify({
      workerReady: "NORMAL_V1_RELEASE_CONSUMER_READY",
      projectScope: "disposable/dev",
      operationId: intentId,
      jobId: published.publishedJobId,
      queueConsumed: "exactly_once",
      persistedState: "completed",
      stableRevision: candidate.revision,
      currentState: currentState.releaseLane.state,
      renderedOverview:
        "Analyze/Build/Prepare/Deploy/Verify=passed; result=Live",
      operationSignals:
        "phases=5/5; developer-internals=absent",
      crossPageState:
        "overview=pipeline=dashboard=plan-usage:release-completed/stable",
      recoveryState: failureRecoverySoak
        ? "ambiguous-failed=reconciling; same-job-retry=completed; effects=3"
        : "not_requested",
      networkEvidence: "deploy-command=1; legacy-mutations=0",
      durableEvidence:
        "outbox-publications=1; provenance=1; effects=3; leases=0; owners=0; claims=0",
      cloudExecution: "not_reachable",
    })}\n`);
    process.stdout.write(
      "Repository normal-v1 local fixture worker verification passed.\n",
    );
    runSucceeded = true;
  } finally {
    if (worker && worker.exitCode === null) {
      worker.kill("SIGTERM");
      await Promise.race([
        childExit(worker),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (cdp) await cdp.close().catch(() => undefined);
    if (browser && browser.exitCode === null) {
      browser.kill("SIGTERM");
      await Promise.race([
        childExit(browser),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (vite && vite.exitCode === null) {
      vite.kill("SIGTERM");
      await Promise.race([
        childExit(vite),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (queue) {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
    if (app) await app.close().catch(() => undefined);
    if (redis) await redis.quit().catch(() => undefined);
    rmSync(healthFile, { force: true });
    rmSync(`/tmp/deployguard-normal-v1-overview-${suffix}`, {
      force: true,
      recursive: true,
    });
    if (fixtureCreated) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    }
    await admin.destroy();
    if (demoHold) {
      process.removeListener("SIGINT", onShutdown);
      process.removeListener("SIGTERM", onShutdown);
      if (runSucceeded) {
        writeDemoState({
          state: "stopped",
          ready: false,
          cleanupComplete: true,
          ...demoEvidence,
        });
      }
    }
  }
}

run().catch((error) => {
  writeDemoState({
    state: "failed",
    ready: false,
    cleanupComplete: true,
    safeCode: error instanceof Error
      && /^[A-Z0-9_]{3,128}$/.test(error.message)
      ? error.message
      : "NORMAL_V1_LOCAL_DEMO_FAILED",
  });
  process.stderr.write(
    `Repository normal-v1 local fixture worker verification failed: ${
      error instanceof Error ? error.stack ?? error.message : "unknown"
    }\n`,
  );
  process.exitCode = 1;
});
