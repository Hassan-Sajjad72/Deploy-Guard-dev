import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
const WebSocket: any = require("ws");
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import IORedis from "ioredis";
import AppDataSource from "../src/data-source";
import { AppModule } from "../src/app.module";
import { AuthService, SESSION_COOKIE_NAME } from "../src/auth/auth.service";
import { User, UserRole } from "../src/users/user.entity";
import { Project, ProjectStatus, ProjectVisibility } from "../src/projects/project.entity";
import { ProjectDetectionProfile } from "../src/projects/project-detection-profile.entity";
import { ProjectDeploymentContract } from "../src/projects/project-deployment-contract.entity";
import { ProjectPreflightReport } from "../src/projects/project-preflight-report.entity";
import { TransactionalDeploymentPlannerService } from "../src/orchestration-contracts/planner/transactional-deployment-planner.service";
import { TerminalOutboxPolicyService } from "../src/orchestration-contracts/outbox/terminal-outbox-policy.service";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { ReleaseManifest } from "../src/orchestration-contracts/entities/release-manifest.entity";
import { InitialReleaseDraft } from "../src/orchestration-contracts/entities/initial-release-draft.entity";
import { DeploymentIntent } from "../src/orchestration-contracts/entities/deployment-intent.entity";
import { OrchestrationOutbox } from "../src/orchestration-contracts/entities/orchestration-outbox.entity";
import {
  workerEnvelopeJobId,
  workerEnvelopePayloadForHash,
  validateWorkerEnvelopeV1,
} from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { FrozenProtocolQueue } from "../src/orchestration-contracts/outbox/frozen-bullmq-job.adapter";
import { NormalReleaseLaneConvergenceService } from "../src/orchestration-contracts/release-lane/normal-release-lane-convergence.service";
import { createRedisConnection } from "../src/projects/pipeline/redis.config";

export const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const databaseName = `normal_v1_supervised_${suffix}`;
if (!/^[a-z0-9_]+$/.test(databaseName)) {
  throw new Error("Unsafe isolated database name.");
}
export const projectId = randomUUID();
const outOfScopeProjectId = randomUUID();
export const initialCommit = "1".repeat(40);
export const candidateCommit = "2".repeat(40);
const prefix = `normal-v1-supervised-${suffix}`;
const secret = "isolated-session-secret-with-more-than-thirty-two-characters";
const managedFirstReleaseMode =
  process.env.NORMAL_V1_MANAGED_FIRST_RELEASE_FIXTURE === "true";

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
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForJob(
  queue: FrozenProtocolQueue,
  jobId: string,
  state: string,
) {
  await waitFor(async () => {
    const job = await queue.getJob(jobId);
    return Boolean(job && await job.getState() === state);
  }, `job ${state}`);
  return (await queue.getJob(jobId))!;
}

async function childExit(child: ChildProcess) {
  return new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

type CdpClient = {
  send: (method: string, params?: Record<string, unknown>) => Promise<any>;
  close: () => Promise<void>;
};

async function connectCdp(port: number): Promise<CdpClient> {
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/json/list`)).ok;
    } catch {
      return false;
    }
  }, "browser debugger");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{
    type: string;
    webSocketDebuggerUrl: string;
  }>;
  const target = targets.find((entry) => entry.type === "page");
  assert.ok(target?.webSocketDebuggerUrl);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || "CDP command failed."));
    else request.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      return new Promise((resolve) => socket.close(1000, undefined, resolve));
    },
  };
}

async function pageText(cdp: CdpClient) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: "document.body.innerText",
    returnByValue: true,
  });
  return String(result.result.value || "");
}

export async function seedPlannerEvidence(
  dataSource: DataSource,
  planner: TransactionalDeploymentPlannerService,
  terminalOutbox: TerminalOutboxPolicyService,
) {
  const user = await dataSource.getRepository(User).save({
    githubId: `isolated-${suffix}`,
    name: "Isolated Developer",
    email: `isolated-${suffix}@example.invalid`,
    passwordHash: null,
    image: null,
    githubLogin: null,
    githubAccessToken: null,
    lastLoginAt: null,
    role: UserRole.DEVELOPER,
  });
  await dataSource.getRepository(Project).save({
    id: projectId,
    ownerUserId: user.id,
    name: "Isolated normal v1 project",
    description: null,
    repositoryUrl: "https://example.invalid/isolated/release",
    repositoryProvider: "github",
    githubRepositoryId: null,
    repositoryFullName: "isolated/normal-v1-release",
    targetBranch: "main",
    environmentName: "dev",
    appDirectory: ".",
    deploymentOverrides: {},
    status: ProjectStatus.CONFIGURED,
    visibility: ProjectVisibility.PRIVATE,
    archivedAt: null,
    deletionFenceToken: null,
    deletionIntentId: null,
    deletionStartedAt: null,
  });
  const contractHash1 = createHash("sha256")
    .update(`contract-initial-${suffix}`)
    .digest("hex");
  const profile = await dataSource.getRepository(
    ProjectDetectionProfile,
  ).save({
    projectId,
    repositoryUrl: "https://example.invalid/isolated/release",
    repositoryFullName: "isolated/normal-v1-release",
    targetBranch: "main",
    commitSha: initialCommit,
    inputFingerprint: contractHash1,
    ecosystem: "javascript",
    language: "javascript",
    framework: "express",
    frameworkVariant: null,
    packageManager: "npm",
    runtimeVersion: "20",
    buildCommand: "npm run build",
    startCommand: "npm start",
    expectedPort: 3000,
    healthCheckPath: "/health",
    requiresDatabase: false,
    databaseType: null,
    requiresPersistentStorage: false,
    staticOutput: false,
    dockerfileRequired: false,
    hasDockerfile: false,
    selectedTemplate: "node-server",
    confidence: "high",
    detectionStatus: "success",
    warnings: [],
    errors: [],
    rawProfile: {},
  });
  const contract = await dataSource.getRepository(
    ProjectDeploymentContract,
  ).save({
    projectId,
    detectionProfileId: profile.id,
    repositoryFullName: "isolated/normal-v1-release",
    branch: "main",
    commitSha: initialCommit,
    appRoot: ".",
    language: "javascript",
    framework: "express",
    runtimeType: "server",
    packageManager: "npm",
    dependencyManifest: "package.json",
    lockfile: "package-lock.json",
    nodeVersion: "20",
    pythonVersion: null,
    installCommand: "npm ci",
    buildCommand: "npm run build",
    startCommand: "npm start",
    outputDirectory: null,
    port: 3000,
    portSource: "detected",
    bindsToPortEnv: true,
    bindHost: "0.0.0.0",
    healthPath: "/health",
    requiredEnvVars: [],
    optionalEnvVars: [],
    buildTimeEnvVars: [],
    runtimeEnvVars: [],
    secretEnvVars: [],
    missingEnvVars: [],
    databaseRequired: false,
    databaseEngine: null,
    persistentStorageRequired: false,
    privateRegistryRequired: false,
    dockerStrategy: "generated",
    dockerTemplate: "node-server",
    ecsPlan: {
      containerPort: 3000,
      targetGroupPort: 3000,
      healthCheckPath: "/health",
      command: "npm start",
      cpu: 256,
      memory: 512,
      environmentMappings: [],
      secretMappings: [],
      database: {
        required: false,
        provider: "none",
        engine: null,
        host: null,
        port: null,
        databaseName: null,
        databaseUser: null,
        image: null,
        dataPath: null,
        persistenceEnabled: false,
      },
    },
    deployable: true,
    blockers: [],
    warnings: [],
    confidence: "high",
    generatedAt: new Date(),
    detectionSourceCommit: initialCommit,
    overridesHash: "a".repeat(64),
    contractHash: contractHash1,
    generatedDockerfile: null,
    invalidatedReason: null,
    invalidatedAt: null,
  });
  const preflight = await dataSource.getRepository(
    ProjectPreflightReport,
  ).save({
    projectId,
    detectionProfileId: profile.id,
    inputFingerprint: contractHash1,
    templateKey: "node-server",
    templateDisplayName: "Node server",
    ecosystem: "javascript",
    framework: "express",
    frameworkVariant: null,
    packageManager: "npm",
    runtimeVersion: "20",
    expectedPort: 3000,
    buildCommand: "npm run build",
    startCommand: "npm start",
    healthCheckPath: "/health",
    hasDockerfile: false,
    dockerfileRequired: false,
    generatedDockerfile: null,
    report: {},
    validationStatus: "passed",
    warnings: [],
    errors: [],
  });
  const initial = await planner.plan({
    actor: { userId: user.id, role: "developer" },
    projectId,
    environmentName: "dev",
    kind: "deploy",
    idempotencyKey: `isolated-initial-${suffix}`,
    requestedCommitSha: initialCommit,
    requiredClassification: "infrastructure_change",
  });
  const initialDraft = await dataSource.getRepository(
    InitialReleaseDraft,
  ).findOneByOrFail({ intentId: initial.intent.id });
  const infrastructure = await dataSource.getRepository(
    InfrastructureManifest,
  ).findOneByOrFail({ id: initial.intent.infrastructureManifestId! });
  if (managedFirstReleaseMode) {
    const frozen = structuredClone(initialDraft.releaseDraft);
    frozen.releaseSpec.runtime.secretReferenceNames = ["JWT_SECRET"];
    frozen.runtimeFingerprint = canonicalSha256({
      runtime: frozen.releaseSpec.runtime,
      health: frozen.releaseSpec.health,
      configurationFingerprint: frozen.configurationFingerprint,
    });
    frozen.specHash = canonicalSha256(frozen.releaseSpec);
    initialDraft.releaseDraft = frozen;
    initialDraft.draftHash = canonicalSha256(frozen);
    await dataSource.getRepository(InitialReleaseDraft).save(initialDraft);
    infrastructure.desiredSpec = {
      ...infrastructure.desiredSpec,
      network: {
        ...infrastructure.desiredSpec.network,
        publicSubnets: true,
        privateSubnets: true,
        natMode: "none",
      },
      database: {
        mode: "managed",
        engine: "postgres",
        tierRevision: "1",
        persistence: true,
        externalTlsRequired: null,
      },
      discovery: {
        cloudMapRequired: true,
        namespace: "project-isolated.deployguard.local",
      },
    };
    infrastructure.specHash = canonicalSha256(infrastructure.desiredSpec);
  }
  infrastructure.status = "applied";
  infrastructure.appliedAt = new Date();
  const serviceName = infrastructure.desiredSpec.ecsFoundation.serviceName;
  infrastructure.terraformOutputs = {
    ecs_cluster_arn: "arn:aws:ecs:us-east-1:123456789012:cluster/isolated",
    ecs_service_arn:
      `arn:aws:ecs:us-east-1:123456789012:service/isolated/${serviceName}`,
    ecs_task_definition_arn:
      `arn:aws:ecs:us-east-1:123456789012:task-definition/${serviceName}:1`,
    ecs_container_name: "app",
    ecs_service_name: serviceName,
    ecs_log_group_name: `/deployguard/${serviceName}`,
    ecr_repository_name: "isolated-repository",
    ecr_repository_url:
      "123456789012.dkr.ecr.us-east-1.amazonaws.com/isolated-repository",
    alb_target_group_arn:
      "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/isolated/123",
    alb_dns_name: "isolated.example.invalid",
    app_security_group_id: "sg-0123abc",
    database_security_group_id: "sg-0456def",
    private_subnet_ids: ["subnet-0123abc", "subnet-0456def"],
    canary_ecs_assign_public_ip: false,
    database_enabled: true,
    database_internal_host: "db.isolated",
    database_port: "5432",
    database_password_secret_arn:
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:database-password",
    database_url_secret_arn:
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:database-url",
    application_jwt_secret_arn:
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:application-jwt",
  };
  infrastructure.terraformOutputsHash = canonicalSha256(
    infrastructure.terraformOutputs,
  );
  await dataSource.getRepository(InfrastructureManifest).save(infrastructure);

  if (managedFirstReleaseMode) {
    await dataSource.getRepository(DeploymentIntent).update(initial.intent.id, {
      status: "completed",
      completedAt: new Date(),
    });
    await dataSource.transaction("SERIALIZABLE", async (manager) => {
      await terminalOutbox.terminalizeUndispatched(manager, {
        intentId: initial.intent.id,
        intentStatus: "completed",
      });
    });
    const initialOutbox = await dataSource.getRepository(OrchestrationOutbox)
      .findOneByOrFail({ intentId: initial.intent.id });
    return { user, initialOutbox };
  }

  const stable = await dataSource.getRepository(ReleaseManifest).save({
    ...initialDraft.releaseDraft,
    revision: "1",
    createdByIntentId: initial.intent.id,
    pipelineRunId: null,
    status: "stable",
    imageUri:
      "123456789012.dkr.ecr.us-east-1.amazonaws.com/isolated-repository"
      + `@sha256:${"3".repeat(64)}`,
    imageDigest: `sha256:${"3".repeat(64)}`,
    taskDefinitionInputHash: "4".repeat(64),
    taskDefinitionArn:
      `arn:aws:ecs:us-east-1:123456789012:task-definition/${serviceName}:1`,
    initialServiceInputHash: "5".repeat(64),
    initialServiceArn:
      `arn:aws:ecs:us-east-1:123456789012:service/isolated/${serviceName}`,
    healthEvidence: { safeCode: "ISOLATED_STABLE" },
    failureCode: null,
    failureMessage: null,
    buildStartedAt: null,
    builtAt: new Date(),
    deploymentStartedAt: new Date(),
    healthVerifiedAt: new Date(),
    promotedAt: new Date(),
    supersededAt: null,
    rollbackStartedAt: null,
    rolledBackAt: null,
  } as Partial<ReleaseManifest>);
  await dataSource.getRepository(DeploymentIntent).update(initial.intent.id, {
    releaseManifestId: stable.id,
    status: "completed",
    completedAt: new Date(),
  });
  await dataSource.transaction("SERIALIZABLE", async (manager) => {
    await terminalOutbox.terminalizeUndispatched(manager, {
      intentId: initial.intent.id,
      intentStatus: "completed",
    });
  });

  const contractHash2 = createHash("sha256")
    .update(`contract-candidate-${suffix}`)
    .digest("hex");
  contract.commitSha = candidateCommit;
  contract.detectionSourceCommit = candidateCommit;
  contract.contractHash = contractHash2;
  contract.generatedAt = new Date();
  await dataSource.getRepository(ProjectDeploymentContract).save(contract);
  profile.commitSha = candidateCommit;
  profile.inputFingerprint = contractHash2;
  await dataSource.getRepository(ProjectDetectionProfile).save(profile);
  preflight.inputFingerprint = contractHash2;
  preflight.validationStatus = "passed";
  await dataSource.getRepository(ProjectPreflightReport).save(preflight);

  const initialOutbox = await dataSource.getRepository(OrchestrationOutbox)
    .findOneByOrFail({ intentId: initial.intent.id });
  return { user, initialOutbox };
}

async function run() {
  const checkpoint = (name: string) =>
    process.stdout.write(`supervised-runtime checkpoint: ${name}\n`);
  const sourceOptions = AppDataSource.options as DataSourceOptions & {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
  };
  const admin = new DataSource(databaseOptions(
    String(AppDataSource.options.database),
  ));
  let app: Awaited<ReturnType<typeof NestFactory.create>> | null = null;
  let queue: FrozenProtocolQueue | null = null;
  let redis: IORedis | null = null;
  let child: ChildProcess | null = null;
  let vite: ChildProcess | null = null;
  let browser: ChildProcess | null = null;
  let cdp: CdpClient | null = null;
  let childOutput = "";
  let viteOutput = "";
  await admin.initialize();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  try {
    const schema = new DataSource({
      ...databaseOptions(databaseName),
      synchronize: true,
    } as DataSourceOptions);
    await schema.initialize();
    await schema.query(`
      CREATE TABLE normal_v1_mock_handler_calls (
        intent_id uuid PRIMARY KEY,
        message_type varchar(64) NOT NULL,
        result_code varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await schema.query(`
      CREATE TABLE normal_v1_mock_handler_attempts (
        sequence serial PRIMARY KEY,
        intent_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await schema.destroy();

    Object.assign(process.env, {
      DATABASE_NAME: databaseName,
      DATABASE_HOST: String(sourceOptions.host),
      DATABASE_PORT: String(sourceOptions.port),
      DATABASE_USERNAME: String(sourceOptions.username),
      DATABASE_PASSWORD: String(sourceOptions.password),
      TYPEORM_SYNCHRONIZE: "false",
      AUTH_SESSION_SECRET: secret,
      NODE_ENV: "test",
      // The convergence contract validates a concrete provider region even
      // when this fixture replaces the provider clients with deterministic
      // local responses.
      AWS_REGION: "us-east-1",
      TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: "true",
      TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED:
        managedFirstReleaseMode ? "true" : "false",
      TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_PLANNING_ENABLED:
        managedFirstReleaseMode ? "true" : "false",
      TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_EXECUTION_ENABLED:
        managedFirstReleaseMode ? "true" : "false",
      TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED: "true",
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_ENABLED: "true",
      TWO_LANE_NORMAL_RELEASE_OUTCOME_RECONCILE_APPROVED: "true",
      // The first supervised process must remain pending long enough to prove
      // that shutdown cancels its scheduler before a replacement starts.
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_INTERVAL_MS: "60000",
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_MAX_ATTEMPTS: "2",
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_MAX_ELAPSED_MS: "60000",
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
      TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
      OUTBOX_BULLMQ_PREFIX: prefix,
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
    const planner = app.get(TransactionalDeploymentPlannerService);
    const terminalOutbox = app.get(TerminalOutboxPolicyService);
    const seeded = await seedPlannerEvidence(
      dataSource,
      planner,
      terminalOutbox,
    );
    const childEnvironment = {
      ...process.env,
      TWO_LANE_NORMAL_RELEASE_CONSUMER_ENABLED: "true",
      TWO_LANE_RELEASE_WORKER_ID: `normal-v1:supervised-${suffix}`,
      TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED: "true",
      TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED: "true",
      TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST: projectId,
      TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST: "dev",
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_ENABLED: "true",
      TWO_LANE_NORMAL_RELEASE_OUTCOME_RECONCILE_APPROVED: "true",
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_INTERVAL_MS: "1000",
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_MAX_ATTEMPTS: "2",
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_MAX_ELAPSED_MS: "60000",
      NORMAL_V1_ISOLATED_AUTO_CONVERGENCE_FIXTURE:
        managedFirstReleaseMode ? "false" : "true",
      NORMAL_V1_MANAGED_FIRST_RELEASE_FIXTURE:
        managedFirstReleaseMode ? "true" : "false",
    };
    const startConsumer = async (overrides: Record<string, string> = {}) => {
      const outputOffset = childOutput.length;
      const started = spawn(
        process.execPath,
        [
          "-r",
          "ts-node/register",
          "-r",
          "tsconfig-paths/register",
          "scripts/run-normal-v1-release-consumer-isolated-fixture.ts",
        ],
        {
          cwd: process.cwd(),
          env: { ...childEnvironment, ...overrides },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      started.stdout!.on("data", (chunk) => {
        childOutput += chunk.toString();
      });
      started.stderr!.on("data", (chunk) => {
        childOutput += chunk.toString();
      });
      await waitFor(
        () => childOutput.slice(outputOffset).includes(
          "NORMAL_V1_RELEASE_CONSUMER_READY",
        ),
        "consumer readiness",
      );
      return { child: started, outputOffset };
    };
    const firstConsumer = await startConsumer();
    child = firstConsumer.child;
    child.kill("SIGUSR1");
    await waitFor(
      () => childOutput.includes('"state":"idle"'),
      "idle observation",
    );

    const config = app.get(ConfigService);
    queue = new FrozenProtocolQueue("deployguard-release-v1", {
      connection: createRedisConnection(config),
      prefix,
    });
    const outOfScopeEnvelope = structuredClone(seeded.initialOutbox.workerEnvelope);
    outOfScopeEnvelope.identity.projectId = outOfScopeProjectId;
    outOfScopeEnvelope.identity.intentId = randomUUID();
    outOfScopeEnvelope.trace.correlationId =
      outOfScopeEnvelope.identity.intentId;
    outOfScopeEnvelope.idempotency.canonicalKey =
      createHash("sha256").update(`out-of-scope-${suffix}`).digest("hex");
    outOfScopeEnvelope.idempotency.payloadSha256 = canonicalSha256(
      workerEnvelopePayloadForHash(outOfScopeEnvelope),
    );
    validateWorkerEnvelopeV1(outOfScopeEnvelope);
    const outOfScopeJobId = workerEnvelopeJobId(outOfScopeEnvelope);
    await queue.add(
      outOfScopeEnvelope.protocol.messageType,
      outOfScopeEnvelope,
      {
        jobId: outOfScopeJobId,
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    const rejected = await waitForJob(queue, outOfScopeJobId, "failed");
    assert.ok(
      [
        "CONSUMER_JOB_SCOPE_NOT_ALLOWED",
        "CONSUMER_JOB_REJECTED",
      ].includes((await queue!.getJob(outOfScopeJobId))?.failedReason || ""),
      "An out-of-scope frozen job must fail closed before ownership or handler invocation.",
    );
    assert.equal(rejected.attemptsMade, 1);
    assert.equal(
      Number((await dataSource.query(
        `SELECT count(*) FROM normal_v1_mock_handler_calls`,
      ))[0].count),
      0,
    );

    const auth = app.get(AuthService);
    const token = auth.createSessionToken(seeded.user as User);
    const authenticatedHeaders = {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    };
    const outOfScopeResponse = await fetch(
      `${baseUrl}/api/projects/${outOfScopeProjectId}/release-lane/dispatch`,
      {
        method: "POST",
        headers: authenticatedHeaders,
      },
    );
    assert.equal(outOfScopeResponse.status, 201);
    const outOfScopeBody = await outOfScopeResponse.json() as any;
    assert.equal(outOfScopeBody.releaseLane.state, "blocked");
    checkpoint("out-of-scope-rejected");
    assert.equal(
      child.exitCode,
      null,
      `The isolated consumer exited after a rejected foreign job: ${childOutput}`,
    );

    const skipBrowser = process.env.NORMAL_V1_SKIP_BROWSER === "true";
    let preparedIntentId: string | null = null;
    if (skipBrowser) {
      const prepareResponses = await Promise.all(
        Array.from({ length: managedFirstReleaseMode ? 2 : 1 }, () => fetch(
          `${baseUrl}/api/projects/${projectId}/release-lane/prepare`,
          { method: "POST", headers: authenticatedHeaders },
        )),
      );
      for (const prepared of prepareResponses) {
        assert.equal(prepared.status, 201);
        assert.equal((await prepared.json() as any).releaseLane.state, "prepared");
      }
      const preparedIntents = await dataSource.getRepository(DeploymentIntent).find({
        where: { projectId, environmentName: "dev", status: "planned" },
      });
      assert.equal(preparedIntents.length, 1);
      preparedIntentId = preparedIntents[0].id;
      const preparedCandidate = await dataSource.getRepository(ReleaseManifest)
        .findOneByOrFail({ id: preparedIntents[0].releaseManifestId! });
      assert.equal(preparedCandidate.status, "desired");
      const preparedOutbox = await dataSource.getRepository(OrchestrationOutbox)
        .findOneByOrFail({ intentId: preparedIntentId });
      assert.equal(preparedOutbox.status, "pending");
      assert.equal(preparedOutbox.attemptCount, 0);
      const dispatched = await fetch(
        `${baseUrl}/api/projects/${projectId}/release-lane/dispatch`,
        { method: "POST", headers: authenticatedHeaders },
      );
      assert.equal(dispatched.status, 201);
      assert.equal((await dispatched.json() as any).releaseLane.state, "dispatched");
      checkpoint("http-prepare-dispatch-complete");
    } else {
    vite = spawn(
      "npm",
      ["exec", "vite", "--", "--host", "127.0.0.1", "--port", "0"],
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
      "frontend readiness",
    );
    checkpoint("frontend-ready");
    const frontendUrl = viteOutput.match(/http:\/\/127\.0\.0\.1:\d+\//)![0].replace(/\/$/, "");
    const debugPort = 9300 + parseInt(suffix.slice(-2), 16) % 500;
    browser = spawn("/usr/bin/google-chrome", [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=/tmp/deployguard-normal-v1-${suffix}`,
      "about:blank",
    ], { stdio: "ignore" });
    cdp = await connectCdp(debugPort);
    checkpoint("browser-connected");
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => { const original = window.fetch.bind(window); window.__deployGuardRequests = []; window.fetch = (input, init = {}) => { window.__deployGuardRequests.push({ url: String(input), method: init.method || "GET" }); return original(input, init); }; })();`,
    });
    await cdp.send("Network.setCookie", {
      url: baseUrl,
      name: SESSION_COOKIE_NAME,
      value: token,
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    });
    await cdp.send("Page.navigate", { url: `${frontendUrl}/projects/${projectId}` });
    checkpoint("page-navigated");
    await waitFor(async () => (await pageText(cdp!)).includes("Start deployment"), "eligible Start deployment action");
    checkpoint("browser-ready");
    await cdp.send("Runtime.evaluate", {
      expression: `(() => { const button = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "Start deployment"); if (!button) throw new Error("Start deployment button unavailable."); button.click(); button.click(); })()`,
      awaitPromise: true,
    });
    checkpoint("start-clicked");
    }

    const plannedIntents = preparedIntentId
      ? [await dataSource.getRepository(DeploymentIntent).findOneByOrFail({ id: preparedIntentId })]
      : await dataSource.getRepository(DeploymentIntent).find({
        where: { projectId, environmentName: "dev", status: "planned" },
      });
    assert.equal(plannedIntents.length, 1);
    const intentId = plannedIntents[0].id;
    const candidate = await dataSource.getRepository(ReleaseManifest).findOneByOrFail({
      id: plannedIntents[0].releaseManifestId!,
    });
    const outbox = await dataSource.getRepository(OrchestrationOutbox).findOneByOrFail({
      intentId,
    });
    await waitFor(async () => {
      const dispatched = await dataSource.getRepository(OrchestrationOutbox).findOneByOrFail({ id: outbox.id });
      return dispatched.status === "published";
    }, "exact outbox dispatch");
    checkpoint("outbox-published");
    if (cdp) {
      const requestLog = await cdp.send("Runtime.evaluate", {
        expression: "window.__deployGuardRequests",
        returnByValue: true,
      });
      const normalRequests = requestLog.result.value as Array<{ url: string; method: string }>;
      assert.equal(normalRequests.filter((request) => request.url.includes("/release-lane/prepare") && request.method === "POST").length, 1);
      assert.equal(normalRequests.filter((request) => request.url.includes("/release-lane/dispatch") && request.method === "POST").length, 1);
      assert.equal(normalRequests.some((request) => request.url.includes("/release-lane/status")), false);
    }
    if (managedFirstReleaseMode) {
      checkpoint("managed-first-release-awaiting-terminal");
      const keepAlive = setInterval(() => undefined, 1_000);
      try {
        await waitFor(async () => {
          const intent = await dataSource.getRepository(DeploymentIntent)
            .findOneByOrFail({ id: intentId });
          return intent.status === "completed";
        }, "managed first-release fixture completion");
      } catch {
        const intent = await dataSource.getRepository(DeploymentIntent)
          .findOneByOrFail({ id: intentId });
        const job = await queue.getJob(outbox.publishedJobId!);
        throw new Error(
          `MANAGED_FIRST_RELEASE_FIXTURE_NOT_TERMINAL:${intent.status}:${intent.failureCode || "none"}:${await job?.getState()}:${job?.failedReason || "none"}:${childOutput.slice(-1000)}`,
        );
      } finally {
        clearInterval(keepAlive);
      }
      checkpoint("managed-first-release-intent-completed");
      assert.equal(
        Number((await dataSource.query(
          `SELECT count(*) FROM normal_v1_mock_handler_calls
           WHERE intent_id = $1`,
          [intentId],
        ))[0].count),
        1,
      );
      const candidateCount = Number((await dataSource.query(
        `SELECT count(*) FROM release_manifests
         WHERE project_id = $1 AND created_by_intent_id = $2`,
        [projectId, intentId],
      ))[0].count);
      assert.equal(candidateCount, 1);
      assert.equal(
        Number((await dataSource.query(
          `SELECT count(*) FROM release_image_provenances
           WHERE project_id = $1`,
          [projectId],
        ))[0].count),
        0,
      );
      assert.equal(
        Number((await dataSource.query(
          `SELECT count(*) FROM deployment_side_effects
           WHERE project_id = $1`,
          [projectId],
        ))[0].count),
        0,
      );
      const published = await dataSource.getRepository(OrchestrationOutbox)
        .findOneByOrFail({ id: outbox.id });
      assert.equal(published.attemptCount, 1);
      assert.equal(
        published.publishedJobId,
        workerEnvelopeJobId(published.workerEnvelope),
      );
      const duplicate = await fetch(
        `${baseUrl}/api/projects/${projectId}/release-lane/dispatch`,
        { method: "POST", headers: authenticatedHeaders },
      );
      assert.equal(duplicate.status, 201);
      assert.notEqual(
        (await duplicate.json() as any).releaseLane.state,
        "dispatched",
      );
      assert.equal(
        Number((await dataSource.query(
          `SELECT count(*) FROM orchestration_outbox
           WHERE intent_id = $1 AND event_type = 'intent.release.execute'`,
          [intentId],
        ))[0].count),
        1,
      );
      const current = await fetch(
        `${baseUrl}/api/projects/${projectId}/current-state`,
        { headers: authenticatedHeaders },
      );
      assert.equal(current.status, 200);
      assert.equal((await current.json() as any).releaseLane.state, "completed");
      const frozenDraft = await dataSource.getRepository(InitialReleaseDraft)
        .findOneByOrFail({
          projectId,
          environmentName: "dev",
          infrastructureManifestId: candidate.infrastructureManifestId,
        });
      const originalDraftHash = frozenDraft.draftHash;
      frozenDraft.draftHash = "f".repeat(64);
      await dataSource.getRepository(InitialReleaseDraft).save(frozenDraft);
      const changedEvidence = await fetch(
        `${baseUrl}/api/projects/${projectId}/release-lane/prepare`,
        { method: "POST", headers: authenticatedHeaders },
      );
      assert.equal(changedEvidence.status, 201);
      assert.deepEqual(
        (await changedEvidence.json() as any).releaseLane.safeCodes,
        ["NORMAL_MANAGED_FIRST_RELEASE_IMMUTABLE_EVIDENCE_CONFLICT"],
      );
      frozenDraft.draftHash = originalDraftHash;
      await dataSource.getRepository(InitialReleaseDraft).save(frozenDraft);
      assert.equal(
        Number((await dataSource.query(
          `SELECT count(*) FROM deployment_intents
           WHERE project_id = $1 AND classification = 'release_only'`,
          [projectId],
        ))[0].count),
        1,
      );
      child.kill("SIGUSR1");
      await waitFor(
        () => childOutput.includes('"state":"terminal"'),
        "managed first-release terminal observation",
      );
      const active = await dataSource.query(
        `SELECT
           (SELECT count(*)::integer FROM project_operation_leases
             WHERE intent_id = $1 AND status = 'active') AS leases,
           (SELECT count(*)::integer FROM project_release_lane_ownerships
             WHERE project_id = $2 AND status IN ('acquired','heartbeat_active')) AS owners,
           (SELECT count(*)::integer FROM orchestration_outbox
             WHERE intent_id = $1 AND claimed_by IS NOT NULL) AS claims`,
        [intentId, projectId],
      );
      assert.deepEqual(active[0], { leases: 0, owners: 0, claims: 0 });
      child.kill("SIGTERM");
      assert.equal(await childExit(child), 0);
      await waitFor(
        () => childOutput.includes('"state":"stopping"')
          && childOutput.includes('"state":"stopped"'),
        "managed first-release stopped observation",
      );
      assert.equal(childOutput.includes(projectId), false);
      assert.equal(childOutput.includes(intentId), false);
      assert.equal(childOutput.includes("fencingToken"), false);
      child = null;
      checkpoint("managed-first-release-consumer-stopped");
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
      process.stdout.write(
        "Normal managed first-release authenticated dispatch and supervised consumer verification passed.\n",
      );
      return;
    }
    await waitFor(async () => {
      const attempts = await dataSource.query(
        `SELECT count(*)::integer AS count
         FROM normal_v1_mock_handler_attempts`,
      );
      return attempts[0].count === 1;
    }, "ambiguous first handler outcome");
    checkpoint("ambiguous-outcome");
    let lastReleaseLane: unknown = null;
    try {
      await waitFor(async () => {
        const response = await fetch(
          `${baseUrl}/api/projects/${projectId}/current-state`,
          { headers: authenticatedHeaders },
        );
        if (response.status !== 200) return false;
        lastReleaseLane = (await response.json() as any).releaseLane;
        return (lastReleaseLane as { state?: unknown }).state === "reconciling";
      }, "reconciling current-state");
    } catch {
      const intent = await dataSource.getRepository(DeploymentIntent)
        .findOneByOrFail({ id: intentId });
      throw new Error(
        `RECONCILING_CURRENT_STATE_MISMATCH:${intent.status}:${intent.failureCode || "none"}:${JSON.stringify(lastReleaseLane)}`,
      );
    }
    checkpoint("reconciling-observed");

    // The first supervisor is stopped while the exact failed job is still
    // pending. Its 60-second timer cannot run after process exit, and the
    // replacement is the only process allowed to schedule convergence.
    const ambiguousJob = await waitForJob(
      queue,
      outbox.publishedJobId!,
      "failed",
    );
    assert.equal(ambiguousJob.attemptsMade, 1);
    const firstChild = child!;
    firstChild.kill("SIGTERM");
    assert.equal(await childExit(firstChild), 0);
    await waitFor(
      () => childOutput.slice(firstConsumer.outputOffset).includes('"state":"stopped"'),
      "first consumer stopped",
    );
    child = null;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const stoppedJob = await queue.getJob(outbox.publishedJobId!);
    assert.equal(await stoppedJob!.getState(), "failed");
    assert.equal(stoppedJob!.attemptsMade, 1);
    const stoppedIntent = await dataSource.getRepository(DeploymentIntent)
      .findOneByOrFail({ id: intentId });
    assert.equal(stoppedIntent.status, "failed");
    assert.equal(
      await app.get(NormalReleaseLaneConvergenceService)
        .findAutomaticCandidate(projectId),
      intentId,
      "The exact failed delivery must remain eligible for the replacement scheduler.",
    );

    const replacementConsumer = await startConsumer({
      TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_INTERVAL_MS: "1000",
    });
    child = replacementConsumer.child;
    checkpoint("replacement-consumer-ready");
    try {
      await waitFor(async () => {
        const intent = await dataSource.getRepository(
          DeploymentIntent,
        ).findOneByOrFail({ id: intentId });
        return intent.status === "running";
      }, "intent running");
    } catch {
      const intent = await dataSource.getRepository(DeploymentIntent)
        .findOneByOrFail({ id: intentId });
      const [evidence] = await dataSource.query(
        `SELECT intent.status, intent.failure_code AS "failureCode",
                candidate.status AS "candidateStatus",
                candidate.previous_stable_manifest_id AS "previousStableManifestId",
                candidate.image_digest AS "imageDigest",
                candidate.task_definition_arn AS "taskDefinitionArn",
                outbox.status AS "outboxStatus", outbox.attempt_count AS "attemptCount",
                outbox.claimed_by AS "claimedBy", outbox.claim_expires_at AS "claimExpiresAt",
                (SELECT count(*)::integer FROM release_image_provenances
                  WHERE intent_id = intent.id) AS provenance,
                (SELECT count(*)::integer FROM deployment_side_effects
                  WHERE intent_id = intent.id AND status = 'succeeded') AS effects,
                (SELECT count(*)::integer FROM project_operation_leases
                  WHERE intent_id = intent.id AND status IN ('acquired','heartbeat_active')
                    AND expires_at > clock_timestamp()) AS activeLeases,
                (SELECT count(*)::integer FROM project_release_lane_ownerships
                  WHERE project_id = intent.project_id AND environment_name = intent.environment_name
                    AND status IN ('acquired','heartbeat_active')
                    AND expires_at > clock_timestamp()) AS activeOwners
           FROM deployment_intents intent
           JOIN release_manifests candidate ON candidate.id = intent.release_manifest_id
           JOIN orchestration_outbox outbox ON outbox.intent_id = intent.id
          WHERE intent.id = $1`,
        [intentId],
      );
      throw new Error(
        `CONVERGENCE_RESTART_DID_NOT_RESUME:${intent.status}:${intent.failureCode || "none"}:${JSON.stringify(evidence)}:${childOutput.slice(replacementConsumer.outputOffset)}`,
      );
    }
    child.kill("SIGUSR1");
    await waitFor(
      () => childOutput.slice(replacementConsumer.outputOffset).includes('"state":"processing"'),
      "processing observation",
    );
    await waitFor(async () => {
      const intent = await dataSource.getRepository(
        DeploymentIntent,
      ).findOneByOrFail({ id: intentId });
      return intent.status === "completed";
    }, "intent completed");
    checkpoint("intent-completed");
    child.kill("SIGUSR1");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await waitFor(
      () => childOutput.slice(replacementConsumer.outputOffset).includes('"state":"terminal"'),
      "terminal observation",
    );

    const completedOutbox = await dataSource.getRepository(
      OrchestrationOutbox,
    ).findOneByOrFail({ id: outbox.id });
    assert.equal(completedOutbox.status, "published");
    assert.equal(completedOutbox.attemptCount, 1);
    assert.equal(
      completedOutbox.publishedJobId,
      workerEnvelopeJobId(completedOutbox.workerEnvelope),
    );
    const completedJob = await waitForJob(
      queue,
      completedOutbox.publishedJobId!,
      "completed",
    );
    assert.equal(completedJob.attemptsMade, 2);
    const [handlerCalls] = await dataSource.query(
      `SELECT count(*)::integer AS count
       FROM normal_v1_mock_handler_attempts WHERE intent_id = $1`,
      [intentId],
    );
    assert.equal(handlerCalls.count, 2);
    const [journalSummary] = await dataSource.query(
      `SELECT count(*)::integer AS effects,
              count(*) FILTER (WHERE status = 'succeeded')::integer AS succeeded,
              count(DISTINCT effect_type)::integer AS types
       FROM deployment_side_effects WHERE intent_id = $1`,
      [intentId],
    );
    assert.deepEqual(journalSummary, { effects: 3, succeeded: 3, types: 3 });
    const [provenanceSummary] = await dataSource.query(
      `SELECT count(*)::integer AS count
       FROM release_image_provenances WHERE intent_id = $1`,
      [intentId],
    );
    assert.equal(provenanceSummary.count, 1);
    const currentStateResponse = await fetch(
      `${baseUrl}/api/projects/${projectId}/current-state`,
      { headers: authenticatedHeaders },
    );
    assert.equal(currentStateResponse.status, 200);
    const currentState = await currentStateResponse.json() as any;
    assert.equal(currentState.releaseLane.state, "completed");
    assert.equal(currentState.activeRunCount, 0);
    assert.equal(
      Number((await dataSource.query(
        `SELECT count(*)::integer AS count FROM project_pipeline_runs WHERE project_id = $1`,
        [projectId],
      ))[0].count),
      0,
    );
    if (cdp) {
      await cdp.send("Page.reload", { ignoreCache: true });
      await waitFor(async () => (await pageText(cdp!)).includes("Release intent completed."), "completed release after browser refresh");
      const refreshedRequests = await cdp.send("Runtime.evaluate", {
        expression: "window.__deployGuardRequests",
        returnByValue: true,
      });
      const refreshedLog = refreshedRequests.result.value as Array<{ url: string; method: string }>;
      assert.ok(refreshedLog.some((request) => request.url.includes(`/projects/${projectId}/current-state`)));
      assert.equal(refreshedLog.some((request) => request.url.includes("/release-lane/status")), false);
    }
    const [durable] = await dataSource.query(
      `SELECT
         (SELECT count(*)::integer FROM project_operation_leases
          WHERE intent_id = $1 AND status IN ('acquired','heartbeat_active')
            AND expires_at > clock_timestamp()) AS active_leases,
         (SELECT count(*)::integer FROM project_release_lane_ownerships
          WHERE project_id = $2 AND environment_name = 'dev'
            AND status IN ('acquired','heartbeat_active')
            AND expires_at > clock_timestamp()) AS active_owners,
         (SELECT count(*)::integer FROM orchestration_outbox
          WHERE intent_id = $1 AND claimed_by IS NOT NULL) AS claims`,
      [intentId, projectId],
    );
    assert.deepEqual(durable, {
      active_leases: 0,
      active_owners: 0,
      claims: 0,
    });

    child.kill("SIGTERM");
    assert.equal(await childExit(child), 0);
    await waitFor(
      () => childOutput.includes('"state":"stopping"')
        && childOutput.includes('"state":"stopped"'),
      "stopped observation",
    );
    assert.equal(childOutput.includes(projectId), false);
    assert.equal(childOutput.includes(intentId), false);
    assert.equal(childOutput.includes("fencingToken"), false);

    if (cdp) {
      await cdp.close();
      cdp = null;
    }
    if (vite) {
      vite.kill("SIGTERM");
      assert.equal(await childExit(vite), 0);
      vite = null;
    }
    if (browser) {
      browser.kill("SIGTERM");
      await childExit(browser);
      browser = null;
    }

    await queue.obliterate({ force: true });
    await queue.close();
    queue = null;
    await app.close();
    app = null;
    redis = new IORedis({
      ...createRedisConnection(new ConfigService(process.env)),
      lazyConnect: false,
    });
    const keys = await redis.keys(`${prefix}:*`);
    assert.deepEqual(keys, []);
    await redis.quit();
    redis = null;

    process.stdout.write(
      "Normal v1 authenticated bridge and supervised consumer verification passed.\n",
    );
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        childExit(child),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (cdp) await cdp.close().catch(() => undefined);
    if (vite && vite.exitCode === null) {
      vite.kill("SIGTERM");
      await Promise.race([childExit(vite), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (browser && browser.exitCode === null) {
      browser.kill("SIGTERM");
      await Promise.race([childExit(browser), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (queue) {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
    if (app) await app.close().catch(() => undefined);
    if (redis) await redis.quit().catch(() => undefined);
    await admin.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
    await admin.destroy();
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(
      `Normal v1 supervised runtime verification failed: ${
        error instanceof Error ? error.stack || error.message : "unknown"
      }\n`,
    );
    process.exitCode = 1;
  });
}
