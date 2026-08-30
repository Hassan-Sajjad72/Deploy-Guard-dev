import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { getDataSourceToken } from "@nestjs/typeorm";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { AppModule } from "../src/app.module";
import { AuthService, SESSION_COOKIE_NAME } from "../src/auth/auth.service";
import { ProjectEnvironmentCryptoService } from "../src/projects/project-environment-crypto.service";
import { ProjectEnvironmentVariable } from "../src/projects/project-environment-variable.entity";
import { ProjectDeployableService } from "../src/projects/project-deployable-service.entity";
import {
  Project,
  ProjectStatus,
  ProjectVisibility,
} from "../src/projects/project.entity";
import { User, UserRole } from "../src/users/user.entity";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const databaseName = `dg_launch_users_${suffix}`;
const sessionSecret = "iteration-eight-local-session-secret-32-characters";
const plaintextSecret = `workspace-a-secret-${randomUUID()}`;

if (!/^[a-z0-9_]+$/.test(databaseName)) {
  throw new Error("UNSAFE_DISPOSABLE_DATABASE_NAME");
}

function databaseOptions(database: string): DataSourceOptions {
  return {
    ...AppDataSource.options,
    database,
    migrations: [],
    logging: false,
  } as DataSourceOptions;
}

async function requestJson(
  origin: string,
  path: string,
  token?: string,
): Promise<{ status: number; body: any; raw: string }> {
  const response = await fetch(`${origin}${path}`, {
    headers: token
      ? { cookie: `${SESSION_COOKIE_NAME}=${token}` }
      : undefined,
  });
  const raw = await response.text();
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body, raw };
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
  let fixtureCreated = false;

  await admin.initialize();
  const existing = await admin.query(
    `SELECT datname FROM pg_database WHERE datname = $1`,
    [databaseName],
  );
  assert.equal(existing.length, 0, "disposable database name must be unused");
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  fixtureCreated = true;

  try {
    const schema = new DataSource({
      ...databaseOptions(databaseName),
      synchronize: true,
    } as DataSourceOptions);
    await schema.initialize();

    const users = await schema.getRepository(User).save(
      ["alpha", "beta", "gamma"].map((name, index) => ({
        githubId: `iteration-eight-${suffix}-${index}`,
        name: `Workspace ${name}`,
        email: `${name}.${suffix}@example.invalid`,
        passwordHash: null,
        image: null,
        githubLogin: `iteration-eight-${name}-${suffix}`,
        githubAccessToken: null,
        lastLoginAt: new Date(),
        role: UserRole.DEVELOPER,
      })),
    );

    const projectsByUser = new Map<number, Project[]>();
    for (const [userIndex, user] of users.entries()) {
      const projects = await schema.getRepository(Project).save(
        [0, 1].map((projectIndex) => ({
          ownerUserId: user.id,
          name: `Workspace ${userIndex + 1} App ${projectIndex + 1}`,
          description: "Disposable Iteration 8 isolation fixture",
          repositoryUrl: `https://github.com/deployguard-fixtures/workspace-${userIndex + 1}-app-${projectIndex + 1}`,
          repositoryProvider: "github",
          githubRepositoryId: `${Date.now()}${userIndex}${projectIndex}`,
          repositoryFullName: `deployguard-fixtures/workspace-${userIndex + 1}-app-${projectIndex + 1}`,
          targetBranch: "main",
          environmentName: "dev",
          status: ProjectStatus.CONFIGURED,
          visibility: ProjectVisibility.PRIVATE,
          archivedAt: null,
          deletionFenceToken: null,
          deletionIntentId: null,
          deletionStartedAt: null,
        })),
      );
      await schema.getRepository(ProjectDeployableService).save(projects.map((project) => ({
        projectId: project.id,
        name: "Web",
        serviceDirectory: ".",
        position: 0,
      })));
      projectsByUser.set(user.id, projects);
    }

    const secretProject = projectsByUser.get(users[0].id)![0];
    const secretService = await schema.getRepository(ProjectDeployableService).findOneByOrFail({ projectId: secretProject.id, position: 0 });
    process.env.AUTH_SESSION_SECRET = sessionSecret;
    const crypto = new ProjectEnvironmentCryptoService(
      new ConfigService({ AUTH_SESSION_SECRET: sessionSecret }),
    );
    const ciphertext = crypto.encrypt(plaintextSecret);
    assert.notEqual(ciphertext, plaintextSecret);
    await schema.getRepository(ProjectEnvironmentVariable).save({
      projectId: secretProject.id,
      serviceId: secretService.id,
      key: "PRIVATE_APPLICATION_TOKEN",
      normalizedKey: "PRIVATE_APPLICATION_TOKEN",
      value: ciphertext,
      isSecret: true,
      scope: "runtime",
      isRequired: true,
      environment: "dev",
      detectedSource: "iteration-eight-fixture",
      owner: "user_required",
      source: "user",
      protected: false,
      serviceBindingId: null,
      detectedReference: null,
      repositoryDefault: null,
      supersededBy: null,
      configurationFingerprint: null,
      isActive: true,
      supersededAt: null,
      supersededReason: null,
      appliedAt: null,
      encryptionVersion: 1,
    });
    await schema.destroy();

    Object.assign(process.env, {
      DATABASE_NAME: databaseName,
      DATABASE_HOST: String(source.host),
      DATABASE_PORT: String(source.port),
      DATABASE_USERNAME: String(source.username),
      DATABASE_PASSWORD: String(source.password),
      TYPEORM_SYNCHRONIZE: "false",
      AUTH_SESSION_SECRET: sessionSecret,
      NODE_ENV: "test",
      ALLOW_INSECURE_USER_HEADER: "false",
      BILLING_PROVIDER_ENABLED: "false",
      NOTIFICATION_DELIVERY_ENABLED: "false",
      TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: "false",
      TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED: "false",
      TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_PLANNING_ENABLED: "false",
      TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED: "false",
      TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_EXECUTION_ENABLED: "false",
      TWO_LANE_NORMAL_RELEASE_CONSUMER_ENABLED: "false",
      TWO_LANE_INFRASTRUCTURE_PLAN_CONSUMER_ENABLED: "false",
      TWO_LANE_INFRASTRUCTURE_APPLY_CONSUMER_ENABLED: "false",
      TWO_LANE_LATER_RELEASE_LIVE_CLIENT_ENABLED: "false",
      TWO_LANE_LOCAL_RELEASE_FIXTURE_EXECUTION_ENABLED: "false",
      TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED: "false",
    });

    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const auth = app.get(AuthService);
    const tokens = users.map((user) => auth.createSessionToken(user));

    const unauthenticated = await requestJson(origin, "/api/projects");
    assert.equal(unauthenticated.status, 401);

    for (const [index, user] of users.entries()) {
      const list = await requestJson(origin, "/api/projects", tokens[index]);
      assert.equal(list.status, 200);
      assert.equal(list.body.projects.length, 2);
      assert.deepEqual(
        new Set(list.body.projects.map((project: { id: string }) => project.id)),
        new Set(projectsByUser.get(user.id)!.map((project) => project.id)),
      );
    }

    const ownProject = projectsByUser.get(users[0].id)![0];
    const otherProject = projectsByUser.get(users[1].id)![0];
    const [ownView, otherOwnView] = await Promise.all([
      requestJson(origin, `/api/projects/${ownProject.id}`, tokens[0]),
      requestJson(origin, `/api/projects/${otherProject.id}`, tokens[1]),
    ]);
    assert.equal(ownView.status, 200);
    assert.equal(otherOwnView.status, 200);

    const crossProject = await requestJson(
      origin,
      `/api/projects/${otherProject.id}`,
      tokens[0],
    );
    assert.equal(crossProject.status, 403);

    const ownEnvironment = await requestJson(
      origin,
      `/api/projects/${ownProject.id}/env`,
      tokens[0],
    );
    assert.equal(ownEnvironment.status, 200);
    assert.equal(ownEnvironment.body.variables.length, 1);
    assert.equal(ownEnvironment.body.variables[0].maskedValue, "••••••••");
    assert.equal(ownEnvironment.raw.includes(plaintextSecret), false);
    assert.equal(ownEnvironment.raw.includes(ciphertext), false);

    const crossEnvironment = await requestJson(
      origin,
      `/api/projects/${ownProject.id}/env`,
      tokens[1],
    );
    assert.equal(crossEnvironment.status, 403);
    assert.equal(crossEnvironment.raw.includes(plaintextSecret), false);
    assert.equal(crossEnvironment.raw.includes(ciphertext), false);

    const appDataSource = app.get<DataSource>(getDataSourceToken());
    const stored = await appDataSource.getRepository(ProjectEnvironmentVariable)
      .createQueryBuilder("variable")
      .addSelect("variable.value")
      .where("variable.project_id = :projectId", { projectId: ownProject.id })
      .getOneOrFail();
    assert.equal(stored.value, ciphertext);
    assert.equal(crypto.decrypt(stored.value), plaintextSecret);
    assert.notEqual(stored.value, plaintextSecret);

    const retiredRuntimeTables = await appDataSource.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('project_operation_leases', 'project_release_lane_ownerships', 'orchestration_outbox')
    `);
    assert.deepEqual(retiredRuntimeTables, [], "retired orchestration tables must remain unreachable from the synchronized product model");

    console.log("Multi-user local launch PostgreSQL verification passed.");
    console.log("WORKSPACES=3");
    console.log("PROJECTS_PER_WORKSPACE=2");
    console.log("AUTHENTICATION=cookie_session");
    console.log("CROSS_WORKSPACE=denied");
    console.log("SECRET_ISOLATION=encrypted_at_rest,masked_in_response");
    console.log("ACTIVE_RETIRED_RUNTIME_TABLES=0");
  } finally {
    await app?.close().catch(() => undefined);
    if (fixtureCreated) {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    }
    await admin.destroy().catch(() => undefined);
  }
}

void run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
