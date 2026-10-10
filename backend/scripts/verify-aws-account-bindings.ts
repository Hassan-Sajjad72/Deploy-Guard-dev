import "reflect-metadata";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { MiddlewareConsumer, Module, NestModule, ValidationPipe } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { AuthModule } from "../src/auth/auth.module";
import { AuthService, SESSION_COOKIE_NAME } from "../src/auth/auth.service";
import { UsersModule } from "../src/users/users.module";
import { AuthenticatedUserMiddleware } from "../src/common/middleware/authenticated-user.middleware";
import { AwsAccountsModule } from "../src/aws-accounts/aws-accounts.module";
import { AwsAccountsService } from "../src/aws-accounts/aws-accounts.service";
import { AwsAccountBinding } from "../src/aws-accounts/aws-account-binding.entity";
import { OrganizationMembership } from "../src/aws-accounts/organization-membership.entity";
import { User, UserRole } from "../src/users/user.entity";
import { OrganizationAwsAccountBindings1791580000000 } from "../src/migrations/1791580000000-OrganizationAwsAccountBindings";

async function run() {
  const postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
  let database: DataSource | null = null;
  let app: Awaited<ReturnType<typeof NestFactory.create>> | null = null;
  const originalHeader = process.env.ALLOW_INSECURE_USER_HEADER;
  process.env.ALLOW_INSECURE_USER_HEADER = "false";
  try {
    const options = { ...AppDataSource.options, host: postgres.getHost(), port: postgres.getPort(), username: postgres.getUsername(),
      password: postgres.getPassword(), database: postgres.getDatabase(), ssl: false, synchronize: false, migrations: [] } as DataSourceOptions;
    const migrated = spawnSync("npm", ["run", "migration:run"], { cwd: resolve(__dirname, ".."), encoding: "utf8", timeout: 120000,
      env: { ...process.env, DATABASE_HOST: postgres.getHost(), DATABASE_PORT: String(postgres.getPort()), DATABASE_USERNAME: postgres.getUsername(),
        DATABASE_PASSWORD: postgres.getPassword(), DATABASE_NAME: postgres.getDatabase(), DATABASE_SSL: "false",
        AUTH_SESSION_SECRET: "s02-disposable-cookie-session-key-with-32-characters" } });
    assert.equal(migrated.status, 0, `owned disposable migration bootstrap failed: ${migrated.stderr}`);
    database = await new DataSource(options).initialize();
    assert.equal((await database.query("SELECT count(*)::int AS count FROM migrations"))[0].count, 112);
    assert.equal((await database.query("SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1"))[0].name, "OrganizationAwsAccountBindings1791580000000");
    const users = await database.getRepository(User).save(["owner", "outsider", "viewer", "engineer"].map((name) => ({
      githubId: `s02-${name}-${randomUUID()}`, name, email: `${name}@example.invalid`, role: UserRole.DEVELOPER,
    })));
    const config = { AUTH_SESSION_SECRET: "s02-disposable-cookie-session-key-with-32-characters", AWS_ACCOUNT_ID: "123456789012" };
    @Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => config] }),
      TypeOrmModule.forRoot(options), AuthModule, UsersModule, AwsAccountsModule], providers: [AuthenticatedUserMiddleware] })
    class TestRoot implements NestModule {
      configure(consumer: MiddlewareConsumer) { consumer.apply(AuthenticatedUserMiddleware).forRoutes("*"); }
    }
    app = await NestFactory.create(TestRoot, { logger: false, abortOnError: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
    const auth = app.get(AuthService);
    const tokens = users.map((user) => auth.createSessionToken(user));
    async function request(path: string, token?: string, body?: unknown) {
      const response = await fetch(`${origin}/api/organizations${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...(token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      return { status: response.status, body: await response.json() };
    }
    assert.equal((await request("", undefined, { name: "unauthorized" })).status, 401);
    const created = await request("", tokens[0], { name: " Team " });
    assert.equal(created.status, 201); assert.equal(created.body.name, "Team"); assert.equal(created.body.mode, "TEAM");
    const organizationId: string = created.body.id;
    const path = `/${organizationId}/aws-accounts`;
    const dto = { accountId: "222222222222", region: "us-east-1", roleArn: "arn:aws:iam::222222222222:role/team/DeployGuard" };
    const organizations = await request("", tokens[0]);
    assert.equal(organizations.status, 200); assert.equal(organizations.body.length, 1);
    assert.deepEqual((await request("", tokens[1])).body, []);
    for (const mode of [undefined, "TEAM"]) {
      const org = await request("", tokens[1], { name: "No client required", ...(mode ? { mode } : {}) });
      assert.equal(org.status, 201);
    }
    assert.equal((await request(path, tokens[1])).status, 404);
    assert.equal((await request(path, tokens[1], dto)).status, 404);
    for (const body of [
      { ...dto, region: "us-west-2" }, { ...dto, accountId: "123456789012", roleArn: "arn:aws:iam::123456789012:role/control" },
      { ...dto, roleArn: "arn:aws:iam::333333333333:role/foreign" }, { ...dto, accountId: "invalid" },
      { ...dto, roleArn: "arn:aws:sts::222222222222:assumed-role/team/session" }, { ...dto, accessKeyId: "DO-NOT-STORE" },
      { ...dto, organizationId: randomUUID() }, { ...dto, status: "VERIFIED" }, { ...dto, clientId: randomUUID() },
    ]) assert.equal((await request(path, tokens[0], body)).status, 400, JSON.stringify(body));
    assert.equal((await request("/not-a-uuid/aws-accounts", tokens[0])).status, 400);
    const results = await Promise.all([request(path, tokens[0], dto), request(path, tokens[0], dto)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], "concurrent registration must not overwrite identities");
    const binding = results.find((r) => r.status === 201)!.body;
    assert.equal(binding.status, "PENDING"); assert.equal(binding.revokedAt, null);
    assert.match(binding.externalId, /^[0-9a-f-]{36}$/);
    assert.equal((await request(path, tokens[0])).body.length, 1);
    assert.equal((await request(`/${created.body.id}/aws-accounts/${binding.id}/revoke`, tokens[1], {})).status, 404);
    const otherOrganization = (await request("", tokens[1])).body[0];
    assert.equal((await request(`/${otherOrganization.id}/aws-accounts/${binding.id}/revoke`, tokens[1], {})).status, 404);
    for (const [index, role] of [[2, "VIEWER"], [3, "ENGINEER"]] as const) {
      await database.getRepository(OrganizationMembership).save({ organizationId, userId: users[index].id, role, revokedAt: null });
      assert.equal((await request(path, tokens[index])).status, 200);
      assert.equal((await request(path, tokens[index], { ...dto, roleArn: `${dto.roleArn}-other` })).status, 403);
      assert.equal((await request(`${path}/${binding.id}/revoke`, tokens[index], {})).status, 403);
    }
    const service = new AwsAccountsService(database, new ConfigService(config));
    const admin = await database.getRepository(User).save({ name: "Platform admin", role: UserRole.ADMIN });
    await assert.rejects(() => service.list(admin.id, organizationId), { status: 404 }, "platform admin is not tenant membership");
    await assert.rejects(() => new AwsAccountsService(database!, new ConfigService({})).register(users[0].id, organizationId, dto), { status: 503 });
    // Revocation writes contend with the same membership read lock used by
    // admission. No stale session or previously loaded entity bypasses it.
    const runner = database.createQueryRunner();
    await runner.connect(); await runner.startTransaction();
    try {
      await runner.query("UPDATE organization_memberships SET revoked_at = now() WHERE organization_id = $1 AND user_id = $2", [organizationId, users[3].id]);
      let finished = false;
      const blockedRead = service.list(users[3].id, organizationId).then(() => { finished = true; return null; }, (error: unknown) => { finished = true; return error; });
      for (let attempt = 0; attempt < 100; attempt++) {
        // PostgreSQL caches activity snapshots within the observer transaction;
        // refresh it rather than repeatedly observing the first pre-lock query.
        await runner.query("SELECT pg_stat_clear_snapshot()");
        const [row] = await runner.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%organization_memberships%'");
        if (row.count) break;
        if (attempt === 99) assert.fail(`membership access never reached its database lock: ${JSON.stringify(await runner.query("SELECT state, wait_event_type, query FROM pg_stat_activity WHERE datname = current_database()"))}`);
        await new Promise((done) => setTimeout(done, 10));
      }
      assert.equal(finished, false); await runner.commitTransaction();
      const denied = await blockedRead;
      assert.ok(denied instanceof Error); assert.equal((denied as { status?: number }).status, 404);
    } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
    const revoked = await request(`${path}/${binding.id}/revoke`, tokens[0], {});
    assert.equal(revoked.status, 201); assert.equal(revoked.body.status, "REVOKED");
    const retry = await request(`${path}/${binding.id}/revoke`, tokens[0], {});
    assert.equal(retry.body.revokedAt, revoked.body.revokedAt, "revocation is idempotent, not deletion");
    assert.equal((await request(path, tokens[0], dto)).status, 409, "revoked registration cannot be silently reactivated");
    assert.equal(await database.getRepository(AwsAccountBinding).count(), 1);
    const audit = await database.query("SELECT * FROM audit_logs WHERE resource_id = $1 ORDER BY created_at", [binding.id]);
    assert.equal(audit.length, 2); assert.deepEqual(audit.map((row: { action: string }) => row.action), ["aws_account_binding_registered", "aws_account_binding_revoked"]);
    assert.equal(audit[0].metadata.organizationId, organizationId);
    assert.doesNotMatch(JSON.stringify(audit), /DO-NOT-STORE|external_id|accessKey/);
    // Prove audit and privileged writes commit atomically, not best effort.
    await database.query(`ALTER TABLE audit_logs ADD CONSTRAINT s02_fixture_reject_audit CHECK (action <> 'organization_created') NOT VALID`);
    await assert.rejects(() => service.createOrganization(users[0].id, { name: "Must roll back", mode: "TEAM" }));
    assert.equal((await database.query("SELECT count(*)::int AS count FROM organizations WHERE name = 'Must roll back'"))[0].count, 0);
    await database.query("ALTER TABLE audit_logs DROP CONSTRAINT s02_fixture_reject_audit");
    await database.getRepository(User).update(users[0].id, { disabledAt: new Date() });
    assert.equal((await request(path, tokens[0])).status, 401);
    await assert.rejects(() => service.list(users[0].id, organizationId), { status: 401 });
    const migrationRunner = database.createQueryRunner();
    await migrationRunner.connect(); await migrationRunner.startTransaction();
    try { await assert.rejects(() => new OrganizationAwsAccountBindings1791580000000().down(migrationRunner), /Refusing to discard/); }
    finally { await migrationRunner.rollbackTransaction(); await migrationRunner.release(); }
    // Constraints independently reject unsafe direct storage paths.
    await assert.rejects(() => database!.query("UPDATE aws_account_bindings SET status = 'VERIFIED' WHERE id = $1", [binding.id]));
    await assert.rejects(() => database!.query("UPDATE aws_account_bindings SET region = 'us-west-2' WHERE id = $1", [binding.id]));
    await assert.rejects(() => database!.query("UPDATE aws_account_bindings SET role_arn = role_arn || '-changed' WHERE id = $1", [binding.id]));
    await assert.rejects(() => database!.query("UPDATE aws_account_bindings SET status = 'PENDING', revoked_at = NULL WHERE id = $1", [binding.id]));
    await assert.rejects(() => database!.query("DELETE FROM organizations WHERE id = $1", [organizationId]));
    // An empty migration is reversible. Use rollback so the isolated fixture's
    // existing records are never dropped, even in this migration contract test.
    const emptyRunner = database.createQueryRunner();
    await emptyRunner.connect(); await emptyRunner.startTransaction();
    try {
      await emptyRunner.query("DELETE FROM aws_account_bindings");
      await emptyRunner.query("DELETE FROM organization_memberships");
      await emptyRunner.query("DELETE FROM organizations");
      const migration = new OrganizationAwsAccountBindings1791580000000();
      await migration.down(emptyRunner); await migration.up(emptyRunner);
      assert.equal((await emptyRunner.query("SELECT count(*)::int AS count FROM aws_account_bindings"))[0].count, 0);
    } finally { await emptyRunner.rollbackTransaction(); await emptyRunner.release(); }
    assert.equal(await database.getRepository(AwsAccountBinding).count(), 1, "migration tests preserve retained records");
    console.log("S02_BINDING_REGISTRATION=PASS COOKIE_API=PASS TENANT_ISOLATION=PASS REVOCATION_LOCK=PASS AUDIT_ATOMICITY=PASS MIGRATIONS=112 AWS_EXECUTION=NONE BINDINGS_PENDING_ONLY=1");
  } finally {
    if (app) await app.close();
    if (database?.isInitialized) await database.destroy();
    await postgres.stop();
    if (originalHeader === undefined) delete process.env.ALLOW_INSECURE_USER_HEADER;
    else process.env.ALLOW_INSECURE_USER_HEADER = originalHeader;
  }
}
void run().catch((error) => { console.error(error); process.exitCode = 1; });
