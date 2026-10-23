import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
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
  sanitizeNormalV1InfrastructurePlanConsumerHealth,
} from "../src/orchestration-contracts/worker-runtime/normal-v1-infrastructure-plan-consumer-health";
import {
  sanitizeNormalV1InfrastructureApplyConsumerHealth,
} from "../src/orchestration-contracts/worker-runtime/normal-v1-infrastructure-apply-consumer-health";

const projectId = "33333333-3333-4333-8333-333333333333";
const repositoryRoot = resolve(__dirname, "../..");
const composeFile = join(repositoryRoot, "docker-compose.yml");
const databaseName = `normal_v1_infra_supervisor_${process.pid}_${Date.now()}`;
const prefix = `normal-v1-infra-supervisor-${process.pid}-${Date.now()}`;
const composeProject = `dg-infra-supervisor-${process.pid}-${Date.now()}`;
const temporary = mkdtempSync(join(tmpdir(), "deployguard-v1-infra-supervisor-"));
const overrideFile = join(temporary, "compose.override.yml");
let databasePort: number | null = null;

type Role = Readonly<{
  name: "plan" | "apply";
  service: string;
  container: string;
  profile: string;
  statusDir: string;
  statusFile: string;
  healthEntry: string;
}>;

const roles: Role[] = [
  {
    name: "plan",
    service: "normal-v1-infrastructure-plan-consumer",
    container: `${composeProject}-plan-consumer`,
    profile: "normal-v1-infrastructure-plan",
    statusDir: join(temporary, "plan-status"),
    statusFile: join(temporary, "plan-status", "status.json"),
    healthEntry: "dist/src/normal-v1-infrastructure-plan-consumer.health.js",
  },
  {
    name: "apply",
    service: "normal-v1-infrastructure-apply-consumer",
    container: `${composeProject}-apply-consumer`,
    profile: "normal-v1-infrastructure-apply",
    statusDir: join(temporary, "apply-status"),
    statusFile: join(temporary, "apply-status", "status.json"),
    healthEntry: "dist/src/normal-v1-infrastructure-apply-consumer.health.js",
  },
];

function compose(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileSync(
    "docker",
    [
      "compose",
      "--project-name",
      composeProject,
      "-f",
      composeFile,
      "-f",
      overrideFile,
      ...args,
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function buildInfrastructureImage() {
  try {
    compose(["build", roles[0].service]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (!detail.includes("docker-buildx") && !detail.includes("buildx")) {
      throw error;
    }
    // Docker 29 still exposes the legacy builder when a local Desktop install
    // has left a broken Buildx plugin symlink. This bounded fallback builds the
    // exact same repository Dockerfile and does not change service semantics.
    execFileSync(
      "docker",
      [
        "build",
        "-t",
        "deployguard-normal-v1-infrastructure-consumer:local",
        "backend/docker/normal-v1-infrastructure-consumer",
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, DOCKER_BUILDKIT: "0" },
        stdio: "pipe",
      },
    );
  }
}

function inspect(role: Role, format: string) {
  return execFileSync("docker", ["inspect", "-f", format, role.container], {
    encoding: "utf8",
  }).trim();
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function readStatus(role: Role) {
  try {
    return JSON.parse(readFileSync(role.statusFile, "utf8")) as {
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
          role.container,
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

function exactEnvironment(role: Role, overrides: Record<string, string> = {}) {
  return {
    DATABASE_NAME: databaseName,
    OUTBOX_BULLMQ_PREFIX: prefix,
    // This fixture verifies exact-scope rejection. Never inherit the
    // operational shared-worker mode from backend/.env.
    TWO_LANE_NORMAL_V1_OPERATING_MODE: "canary",
    TWO_LANE_RELEASE_COMPOSITION_MODE: "production_canary",
    TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED: "true",
    TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_EXECUTION_ENABLED: "true",
    TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_EXECUTION_ENABLED: "true",
    TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_CONSUMER_ENABLED:
      role.name === "plan" ? "true" : "false",
    TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_CONSUMER_ENABLED:
      role.name === "apply" ? "true" : "false",
    TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_ENABLED:
      role.name === "apply" ? "true" : "false",
    TWO_LANE_INFRASTRUCTURE_WORKER_ID: "normal-v1:infra-plan-supervisor-fixture",
    TWO_LANE_INFRASTRUCTURE_APPLY_WORKER_ID:
      "normal-v1:infra-apply-supervisor-fixture",
    TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED: "true",
    TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED: "true",
    TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST: "dev",
    TERRAFORM_APPLY_ENABLED: "false",
    ...overrides,
  };
}

async function createDatabase(admin: DataSource) {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const schema = new DataSource({
    ...(AppDataSource.options as any),
    host: "127.0.0.1",
    port: requiredDatabasePort(),
    database: databaseName,
    synchronize: false,
  });
  await schema.initialize();
  try {
    await schema.runMigrations({ transaction: "all" });
    assert.equal((await schema.showMigrations()), false);
  } finally {
    await schema.destroy();
  }
}

async function assertNoDurableExecution() {
  const scoped = new DataSource({
    ...(AppDataSource.options as any),
    host: "127.0.0.1",
    port: requiredDatabasePort(),
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
          WHERE claimed_by IS NOT NULL) AS claims,
        (SELECT count(*)::integer FROM deployment_side_effects) AS effects,
        (SELECT count(*)::integer FROM orchestration_outbox) AS outboxes`,
    );
    assert.deepEqual(result, {
      leases: 0,
      owners: 0,
      claims: 0,
      effects: 0,
      outboxes: 0,
    });
  } finally {
    await scoped.destroy();
  }
}

function requiredDatabasePort() {
  if (!databasePort) throw new Error("FIXTURE_POSTGRES_PORT_UNAVAILABLE");
  return databasePort;
}

function redisKeys() {
  const output = compose([
    "exec",
    "-T",
    "redis",
    "redis-cli",
    "--scan",
    "--pattern",
    `${prefix}:*`,
  ]);
  return output.split("\n").map((value) => value.trim()).filter(Boolean);
}

function removeRedisKeys() {
  const keys = redisKeys();
  if (keys.length > 0) {
    compose(["exec", "-T", "redis", "redis-cli", "DEL", ...keys]);
  }
  assert.deepEqual(redisKeys(), []);
}

function verifyHealthShapes() {
  const observedAt = new Date("2026-07-31T12:00:00.000Z");
  for (const sanitize of [
    sanitizeNormalV1InfrastructurePlanConsumerHealth,
    sanitizeNormalV1InfrastructureApplyConsumerHealth,
  ]) {
    for (const [runtimeState, state, ready, live] of [
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
      const health = sanitize({
        state: runtimeState,
        ready: runtimeState === "idle",
        safeCode: "NORMAL_V1_INFRASTRUCTURE_CONSUMER_TEST_STATE",
        activeMessageType: null,
        lastOutcome: null,
      } as never, observedAt);
      assert.equal(health.state, state);
      assert.equal(health.ready, ready);
      assert.equal(health.live, live);
      assert.deepEqual(Object.keys(health).sort(), [
        "live",
        "observedAt",
        "ready",
        "safeCode",
        "schemaVersion",
        "state",
      ]);
      assert.equal(JSON.stringify(health).includes(projectId), false);
    }
  }
}

async function verifyRole(role: Role) {
  const up = (env: Record<string, string>) => compose(
    ["--profile", role.profile, "up", "-d", "--no-deps", role.service],
    env,
  );

  // Disabled configuration exits successfully and cannot restart-loop.
  up(exactEnvironment(role, {
    [role.name === "plan"
      ? "TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_CONSUMER_ENABLED"
      : "TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_CONSUMER_ENABLED"]: "false",
  }));
  await waitFor(() => inspect(role, "{{.State.Status}}") === "exited", `${role.name} disabled exit`);
  assert.equal(inspect(role, "{{.State.ExitCode}}"), "0");
  assert.equal(inspect(role, "{{.RestartCount}}"), "0");
  assert.equal(readStatus(role)?.state, "disabled");
  compose(["rm", "-sf", role.service]);

  // A broad project allowlist fails closed before opening a worker.
  up(exactEnvironment(role, {
    TWO_LANE_RELEASE_PROJECT_ALLOWLIST:
      `${projectId},44444444-4444-4444-8444-444444444444`,
  }));
  const invalidEnvironment = inspect(role, "{{range .Config.Env}}{{println .}}{{end}}");
  assert.match(invalidEnvironment, /TWO_LANE_NORMAL_V1_OPERATING_MODE=canary/);
  assert.match(
    invalidEnvironment,
    /TWO_LANE_RELEASE_COMPOSITION_MODE=production_canary/,
  );
  assert.match(
    invalidEnvironment,
    /TWO_LANE_RELEASE_PROJECT_ALLOWLIST=33333333-3333-4333-8333-333333333333,44444444-4444-4444-8444-444444444444/,
  );
  try {
    await waitFor(
      () => inspect(role, "{{.State.Status}}") === "exited",
      `${role.name} invalid exit`,
      5_000,
    );
  } catch {
    throw new Error(
      `${role.name.toUpperCase()}_INVALID_CONFIG_DID_NOT_EXIT:`
        + `${inspect(role, "{{.State.Status}}")}:`
        + compose(["logs", "--no-color", "--tail", "30", role.service])
          .replaceAll(projectId, "<project>")
          .replaceAll(prefix, "<prefix>"),
    );
  }
  assert.equal(inspect(role, "{{.State.ExitCode}}"), "0");
  assert.equal(inspect(role, "{{.RestartCount}}"), "0");
  assert.equal(readStatus(role)?.state, "failed");
  compose(["rm", "-sf", role.service]);

  // Exact scope starts one idle, ready consumer.
  up(exactEnvironment(role));
  await waitFor(() => readStatus(role)?.state === "ready", `${role.name} ready`);
  assert.equal(
    execFileSync(
      "docker",
      ["ps", "-q", "--filter", `name=^/${role.container}$`],
      { encoding: "utf8" },
    ).trim().split("\n").filter(Boolean).length,
    1,
  );
  const status = JSON.parse(compose([
    "exec",
    "-T",
    role.service,
    "node",
    role.healthEntry,
    "status",
  ]));
  assert.equal(status.state, "ready");
  assert.equal(status.ready, true);

  const observedAt = status.observedAt;
  execFileSync("docker", ["kill", "--signal=USR1", role.container], {
    stdio: "ignore",
  });
  await waitFor(
    () => readStatus(role)?.observedAt !== observedAt,
    `${role.name} SIGUSR1 observation`,
  );

  // Compose restart supplies SIGTERM, drains, and returns one ready process.
  compose(["restart", "-t", "30", role.service], exactEnvironment(role));
  await waitFor(() => readStatus(role)?.state === "ready", `${role.name} graceful restart`);
  const gracefulLogs = compose(["logs", "--no-color", role.service]);
  assert.match(gracefulLogs, /"state":"stopping"/);
  assert.match(gracefulLogs, /"state":"stopped"/);
  assert.equal(gracefulLogs.includes(projectId), false);
  assert.equal(gracefulLogs.includes(prefix), false);

  // Unexpected PID 1 exit is bounded by on-failure and recovers once.
  const restarts = Number(inspect(role, "{{.RestartCount}}"));
  const preCrashObservedAt = readStatus(role)?.observedAt;
  try {
    compose([
      "exec",
      "-T",
      role.service,
      "sh",
      "-c",
      "for f in /proc/[0-9]*/comm; do "
        + "if [ \"$(cat \"$f\")\" = node ]; then "
        + "p=${f#/proc/}; p=${p%/comm}; kill -KILL \"$p\"; fi; done",
    ]);
  } catch {
    // The exec channel is expected to close when the container process exits.
  }
  await waitFor(
    () => Number(inspect(role, "{{.RestartCount}}")) > restarts,
    `${role.name} unexpected-exit restart`,
  );
  await waitFor(
    () => inspect(role, "{{.State.Status}}") === "running"
      && readStatus(role)?.state === "ready"
      && readStatus(role)?.observedAt !== preCrashObservedAt,
    `${role.name} recovered ready`,
  );

  compose(["stop", "-t", "30", role.service]);
  await waitFor(
    () => inspect(role, "{{.State.Status}}") === "exited",
    `${role.name} container exit`,
  );
  assert.equal(inspect(role, "{{.State.Status}}"), "exited");
  const finalLogs = compose(["logs", "--no-color", role.service]);
  assert.match(finalLogs, /"state":"stopping"/);
  assert.match(finalLogs, /"state":"stopped"/);
  assert.equal(finalLogs.includes(projectId), false);
  assert.equal(finalLogs.includes(prefix), false);
  const persisted = readStatus(role);
  if (persisted?.state !== "stopped") {
    throw new Error(`${role.name.toUpperCase()}_STOPPED_HEALTH_NOT_PERSISTED:${JSON.stringify({
      persisted,
      exitCode: inspect(role, "{{.State.ExitCode}}"),
      mounts: inspect(role, "{{json .Mounts}}"),
      logTail: finalLogs.slice(-2_000),
    })}`);
  }
  await assertNoDurableExecution();
  compose(["rm", "-sf", role.service]);
}

async function run() {
  const composeSource = readFileSync(composeFile, "utf8");
  for (const required of [
    "normal-v1-infrastructure-plan-consumer:",
    "normal-v1-infrastructure-apply-consumer:",
    "normal-v1-infrastructure-plan",
    "normal-v1-infrastructure-apply",
    'restart: "on-failure:3"',
    "stop_grace_period: 90s",
    "backend/docker/normal-v1-infrastructure-consumer",
    "TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_CONSUMER_ENABLED",
    "TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_CONSUMER_ENABLED",
    "TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED",
    "normal-v1-infrastructure-plan-consumer.health.js",
    "normal-v1-infrastructure-apply-consumer.health.js",
  ]) assert.ok(composeSource.includes(required), `Missing Compose contract: ${required}`);
  assert.equal(composeSource.includes("/var/run/docker.sock"), true);
  for (const role of roles) {
    const serviceBlock = composeSource.split(`  ${role.service}:`)[1]?.split("\n  ")[0] ?? "";
    assert.equal(serviceBlock.includes("/var/run/docker.sock"), false);
  }
  verifyHealthShapes();

  for (const role of roles) mkdirSync(role.statusDir, { recursive: true });
  writeFileSync(overrideFile, `services:
  postgres:
    ports: !override
      - "127.0.0.1::5432"
  redis:
    ports: !override []
  normal-v1-infrastructure-plan-consumer:
    container_name: ${roles[0].container}
    environment:
      TWO_LANE_RELEASE_COMPOSITION_MODE: production_canary
    volumes:
      - ${roles[0].statusDir}:/run/deployguard
  normal-v1-infrastructure-apply-consumer:
    container_name: ${roles[1].container}
    environment:
      TWO_LANE_RELEASE_COMPOSITION_MODE: production_canary
    volumes:
      - ${roles[1].statusDir}:/run/deployguard
`);

  let admin: DataSource | null = null;
  try {
    compose(["up", "-d", "postgres", "redis"]);
    const publishedPostgres = compose(["port", "postgres", "5432"]).trim();
    databasePort = Number(publishedPostgres.split(":").at(-1));
    if (!Number.isInteger(databasePort) || databasePort < 1) {
      throw new Error("FIXTURE_POSTGRES_PORT_INVALID");
    }
    await waitFor(() => {
      try {
        execFileSync(
          "pg_isready",
          [
            "-h",
            "127.0.0.1",
            "-p",
            String(requiredDatabasePort()),
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
    }, "PostgreSQL readiness");
    process.stdout.write(
      `infrastructure-supervision checkpoint: fixture-services-ready:${databasePort}\n`,
    );

    admin = new DataSource({
      ...(AppDataSource.options as any),
      host: "127.0.0.1",
      port: requiredDatabasePort(),
      database: "mini_paas",
    });
    await admin.initialize();
    process.stdout.write("infrastructure-supervision checkpoint: admin-connected\n");
    await createDatabase(admin);
    process.stdout.write("infrastructure-supervision checkpoint: migrations-complete\n");
    buildInfrastructureImage();
    process.stdout.write("infrastructure-supervision checkpoint: image-ready\n");
    const terraformVersion = compose([
      "run",
      "--rm",
      "--no-deps",
      roles[0].service,
      "/usr/local/bin/terraform",
      "version",
    ]);
    assert.match(terraformVersion, /Terraform v1\.10\.5/);
    for (const role of roles) {
      await verifyRole(role);
      process.stdout.write(`infrastructure-supervision checkpoint: ${role.name}-verified\n`);
    }
    removeRedisKeys();
  } finally {
    for (const role of roles) {
      try { compose(["rm", "-sf", role.service]); } catch { /* best effort */ }
    }
    try { removeRedisKeys(); } catch { /* best effort */ }
    if (admin?.isInitialized) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      } finally {
        await admin.destroy().catch(() => undefined);
      }
    }
    try {
      compose(["down", "--volumes", "--remove-orphans"]);
    } catch { /* best effort */ }
    try {
      execFileSync(
        "docker",
        [
          "volume",
          "rm",
          `${composeProject}_normal_v1_infrastructure_workspaces`,
        ],
        { stdio: "ignore" },
      );
    } catch { /* absent or already removed */ }
    rmSync(temporary, { recursive: true, force: true });
  }

  process.stdout.write(
    "Normal v1 infrastructure plan/apply Compose supervision verification passed.\n",
  );
}

run().catch((error) => {
  process.stderr.write(
    `Normal v1 infrastructure consumer supervision verification failed: ${
      error instanceof Error ? error.stack || error.message : "unknown"
    }\n`,
  );
  process.exitCode = 1;
});
