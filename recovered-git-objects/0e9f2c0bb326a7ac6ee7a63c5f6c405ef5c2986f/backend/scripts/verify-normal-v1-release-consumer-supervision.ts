import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DataSource } from "typeorm";
import AppDataSource from "../src/data-source";
import {
  sanitizeNormalV1ReleaseConsumerHealth,
} from "../src/orchestration-contracts/worker-runtime/normal-v1-release-consumer-health";

const projectId = "11111111-1111-4111-8111-111111111111";
const repositoryRoot = resolve(__dirname, "../..");
const composeFile = join(repositoryRoot, "docker-compose.yml");
const service = "normal-v1-release-consumer";
const fixtureSuffix = `${process.pid}-${Date.now()}`;
const composeProject = `deployguard-release-supervisor-${fixtureSuffix}`;
const container = `deployguard-normal-v1-release-supervisor-${fixtureSuffix}`;
const postgresPort = 20_000 + (process.pid % 10_000);
const redisPort = postgresPort + 1;
const databaseName = `normal_v1_supervisor_${process.pid}_${Date.now()}`;
const prefix = `normal-v1-supervisor-${process.pid}-${Date.now()}`;
const temporary = mkdtempSync(join(tmpdir(), "deployguard-v1-supervisor-"));
const statusDir = join(temporary, "status");
const statusFile = join(statusDir, "status.json");
const overrideFile = join(temporary, "compose.override.yml");

function dockerCompose(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileSync(
    "docker",
    ["compose", "-p", composeProject, "-f", composeFile, "-f", overrideFile, ...args],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        POSTGRES_PORT: String(postgresPort),
        REDIS_PORT: String(redisPort),
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function inspect(format: string) {
  return execFileSync("docker", ["inspect", "-f", format, container], {
    encoding: "utf8",
  }).trim();
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 45_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
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
      observedAt: string;
    };
  } catch {
    try {
      return JSON.parse(execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--volumes-from",
          container,
          "node:20-bookworm-slim",
          "cat",
          "/run/deployguard/status.json",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      )) as {
        state: string;
        ready: boolean;
        live: boolean;
        safeCode: string;
        observedAt: string;
      };
    } catch {
      return null;
    }
  }
}

function exactEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    TWO_LANE_NORMAL_RELEASE_CONSUMER_ENABLED: "true",
    TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: "true",
    TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED: "true",
    TWO_LANE_RELEASE_COMPOSITION_ENABLED: "true",
    TWO_LANE_RELEASE_COMPOSITION_MODE: "production_canary",
    TWO_LANE_RELEASE_WORKER_ID: "normal-v1:supervisor-fixture",
    TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    TWO_LANE_LATER_RELEASE_LIVE_CLIENT_ENABLED: "true",
    TWO_LANE_FIRST_RELEASE_BOOTSTRAP_ENABLED: "false",
    TWO_LANE_FIRST_RELEASE_LIVE_CLIENT_ENABLED: "false",
    TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_EXECUTION_ENABLED: "false",
    TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED: "true",
    TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED: "true",
    TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST: "dev",
    TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED: "true",
    TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_ENABLED: "true",
    TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_MODE: "read_only",
    ...overrides,
  };
}

async function createDatabase(admin: DataSource) {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const options = AppDataSource.options as any;
  const schema = new DataSource({
    ...options,
    host: "127.0.0.1",
    port: postgresPort,
    database: databaseName,
    migrations: [],
    synchronize: true,
  });
  await schema.initialize();
  await schema.destroy();
}

async function assertNoDurableClaim(admin: DataSource) {
  const scoped = new DataSource({
    ...(AppDataSource.options as any),
    host: "127.0.0.1",
    port: postgresPort,
    database: databaseName,
    migrations: [],
    synchronize: false,
  });
  await scoped.initialize();
  try {
    const [result] = await scoped.query(
      `SELECT
        (SELECT count(*)::integer FROM project_operation_leases
          WHERE status IN ('acquired','heartbeat_active')
            AND expires_at > clock_timestamp()) AS leases,
        (SELECT count(*)::integer FROM project_release_lane_ownerships
          WHERE status IN ('acquired','heartbeat_active')
            AND expires_at > clock_timestamp()) AS owners,
        (SELECT count(*)::integer FROM orchestration_outbox
          WHERE claimed_by IS NOT NULL) AS claims`,
    );
    assert.deepEqual(result, { leases: 0, owners: 0, claims: 0 });
  } finally {
    await scoped.destroy();
  }
}

async function run() {
  const composeSource = readFileSync(composeFile, "utf8");
  for (const required of [
    "profiles:",
    "normal-v1-release",
    'restart: "on-failure:3"',
    "stop_grace_period: 90s",
    "backend/docker/normal-v1-release-consumer",
    "/var/run/docker.sock:/var/run/docker.sock",
    "TWO_LANE_NORMAL_RELEASE_CONSUMER_ENABLED",
    "TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED",
    "TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED",
    "TWO_LANE_RELEASE_PROJECT_ALLOWLIST",
    "TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED",
    "TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED",
    "normal-v1-release-consumer.health.js",
  ]) {
    assert.ok(composeSource.includes(required), `Missing supervisor ${required}`);
  }
  assert.equal(
    (composeSource.match(/^  normal-v1-release-consumer:$/gm) ?? []).length,
    1,
  );

  const sanitized = sanitizeNormalV1ReleaseConsumerHealth({
    state: "processing",
    ready: false,
    safeCode: "NORMAL_V1_RELEASE_CONSUMER_PROCESSING",
    activeMessageType: "intent.release.execute",
    lastOutcome: null,
  });
  assert.deepEqual(Object.keys(sanitized).sort(), [
    "live",
    "observedAt",
    "ready",
    "safeCode",
    "schemaVersion",
    "state",
  ]);
  assert.equal(sanitized.state, "processing");
  assert.equal(sanitized.live, true);
  assert.equal(JSON.stringify(sanitized).includes(projectId), false);
  for (const [runtimeState, healthState, ready, live] of [
    ["disabled", "disabled", false, false],
    ["blocked", "failed", false, false],
    ["starting", "starting", false, true],
    ["idle", "ready", true, true],
    ["processing", "processing", false, true],
    ["reconciling", "reconciling", false, true],
    ["terminal", "terminal", false, true],
    ["stopping", "stopping", false, true],
    ["stopped", "stopped", false, false],
  ] as const) {
    const health = sanitizeNormalV1ReleaseConsumerHealth({
      state: runtimeState,
      ready: runtimeState === "idle",
      safeCode: "NORMAL_V1_RELEASE_CONSUMER_TEST_STATE",
      activeMessageType: runtimeState === "processing"
        ? "intent.release.execute"
        : null,
      lastOutcome: null,
    });
    assert.equal(health.state, healthState);
    assert.equal(health.ready, ready);
    assert.equal(health.live, live);
  }

  writeFileSync(
    overrideFile,
    `services:
  postgres:
    container_name: deployguard-release-supervisor-postgres-${fixtureSuffix}
  redis:
    container_name: deployguard-release-supervisor-redis-${fixtureSuffix}
  ${service}:
    container_name: ${container}
    command:
      - node
      - dist/scripts/run-normal-v1-release-consumer-isolated-fixture.js
    volumes:
      - ${statusDir}:/run/deployguard
    environment:
      DATABASE_NAME: ${databaseName}
      OUTBOX_BULLMQ_PREFIX: ${prefix}
`,
  );
  mkdirSync(statusDir, { recursive: true });

  dockerCompose(["up", "-d", "postgres", "redis"]);
  await waitFor(() => {
    try {
      dockerCompose([
        "exec",
        "-T",
        "postgres",
        "pg_isready",
        "-U",
        "mini_paas_user",
        "-d",
        "mini_paas",
      ]);
      return true;
    } catch {
      return false;
    }
  }, "PostgreSQL readiness");
  await waitFor(() => {
    try {
      execFileSync(
        "pg_isready",
        [
          "-h",
          "127.0.0.1",
          "-p",
          String(postgresPort),
          "-U",
          "mini_paas_user",
          "-d",
          "mini_paas",
        ],
        { stdio: "ignore" },
      );
      return true;
    } catch {
      return false;
    }
  }, "host-visible PostgreSQL readiness");
  const admin = new DataSource({
    ...(AppDataSource.options as any),
    host: "127.0.0.1",
    port: postgresPort,
    database: "mini_paas",
  });
  await admin.initialize();
  await createDatabase(admin);

  try {
    // Disabled configuration is terminal and must not restart.
    dockerCompose(
      ["--profile", "normal-v1-release", "up", "-d", "--build", service],
      exactEnvironment({
        TWO_LANE_NORMAL_RELEASE_CONSUMER_ENABLED: "false",
      }),
    );
    await waitFor(() => inspect("{{.State.Status}}") === "exited", "disabled exit");
    assert.equal(
      inspect("{{.State.ExitCode}}"),
      "0",
      dockerCompose(["logs", "--no-color", service]),
    );
    assert.equal(inspect("{{.RestartCount}}"), "0");
    assert.equal(readStatus()?.state, "disabled");
    dockerCompose(["rm", "-sf", service]);

    // Broad configuration fails closed and exits zero to avoid restart loops.
    dockerCompose(
      ["--profile", "normal-v1-release", "up", "-d", service],
      exactEnvironment({
        TWO_LANE_RELEASE_PROJECT_ALLOWLIST:
          `${projectId},22222222-2222-4222-8222-222222222222`,
      }),
    );
    await waitFor(() => inspect("{{.State.Status}}") === "exited", "invalid exit");
    assert.equal(
      inspect("{{.State.ExitCode}}"),
      "0",
      dockerCompose(["logs", "--no-color", service]),
    );
    assert.equal(inspect("{{.RestartCount}}"), "0");
    assert.equal(readStatus()?.state, "failed");
    dockerCompose(["rm", "-sf", service]);

    // Exact configuration starts one ready consumer.
    dockerCompose(
      ["--profile", "normal-v1-release", "up", "-d", service],
      exactEnvironment(),
    );
    await waitFor(() => readStatus()?.state === "ready", "ready state");
    assert.equal(
      execFileSync(
        "docker",
        ["ps", "-q", "--filter", `name=^/${container}$`],
        { encoding: "utf8" },
      ).trim().split("\n").filter(Boolean).length,
      1,
    );
    const statusOutput = dockerCompose([
      "exec",
      "-T",
      service,
      "node",
      "dist/src/normal-v1-release-consumer.health.js",
      "status",
    ]);
    const status = JSON.parse(statusOutput);
    assert.equal(status.state, "ready");
    assert.equal(status.ready, true);
    assert.deepEqual(Object.keys(status).sort(), [
      "live",
      "observedAt",
      "ready",
      "safeCode",
      "schemaVersion",
      "state",
    ]);

    // A supervisor-requested restart drains with SIGTERM and becomes ready.
    dockerCompose(["restart", "-t", "30", service], exactEnvironment());
    await waitFor(() => readStatus()?.state === "ready", "graceful restart");
    const logsAfterRestart = dockerCompose(["logs", "--no-color", service]);
    assert.match(logsAfterRestart, /"state":"stopping"/);
    assert.match(logsAfterRestart, /"state":"stopped"/);

    // Killing PID 1 is an unexpected non-zero exit; on-failure restarts once.
    const restartCount = Number(inspect("{{.RestartCount}}"));
    const preCrashObservedAt = readStatus()?.observedAt;
    try {
      dockerCompose([
        "exec",
        "-T",
        service,
        "sh",
        "-c",
        "for f in /proc/[0-9]*/comm; do "
          + "if [ \"$(cat \"$f\")\" = node ]; then "
          + "p=${f#/proc/}; p=${p%/comm}; kill -KILL \"$p\"; fi; done",
      ]);
    } catch {
      // The exec channel is expected to be severed by the container exit.
    }
    await waitFor(
      () => Number(inspect("{{.RestartCount}}")) > restartCount,
      "unexpected-exit restart",
    );
    await waitFor(() => {
      const recovered = readStatus();
      return inspect("{{.State.Status}}") === "running"
        && recovered?.state === "ready"
        && recovered.observedAt !== preCrashObservedAt;
    }, "recovered ready state");

    // Final stop is graceful, persists stopped health, and leaves no claims.
    dockerCompose(["stop", "-t", "30", service]);
    await waitFor(() => readStatus()?.state === "stopped", "final stopped state");
    assert.equal(inspect("{{.State.Status}}"), "exited");
    await assertNoDurableClaim(admin);
    const redisClients = dockerCompose([
      "exec",
      "-T",
      "redis",
      "redis-cli",
      "CLIENT",
      "LIST",
    ]);
    assert.equal(redisClients.includes("normal-v1:supervisor-fixture"), false);
  } finally {
    try {
      dockerCompose(["rm", "-sf", service]);
    } catch {
      // Best-effort removal; durable assertions happen before cleanup.
    }
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.destroy();
    try {
      dockerCompose(["down", "-v", "--remove-orphans"]);
    } catch {
      // Best-effort removal; durable assertions happen before cleanup.
    }
    rmSync(temporary, { recursive: true, force: true });
  }

  process.stdout.write(
    "Normal v1 release consumer Compose supervision verification passed.\n",
  );
}

run().catch((error) => {
  process.stderr.write(
    `Normal v1 release consumer supervision verification failed: ${
      error instanceof Error ? error.stack || error.message : "unknown"
    }\n`,
  );
  process.exitCode = 1;
});
