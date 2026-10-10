import "reflect-metadata";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { DataSource } from "typeorm";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import AppDataSource from "../src/data-source";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { GithubActionsRuntimeSecretService, RuntimeSecretMaterializer, RuntimeSecretMaterialization, RuntimeSecretOwnershipRecorder } from "../src/projects/github-actions-runtime-secret.service";
import { ProjectPipelineEvent } from "../src/projects/project-pipeline-event.entity";
import { RuntimeSecretOwnershipEvent, RuntimeSecretOwnershipPersistenceError, runtimeSecretOwnershipRecord, RUNTIME_SECRET_OWNERSHIP_SOURCE } from "../src/projects/runtime-secret-ownership";
import { FAILURE_CONTRACT } from "../src/projects/failure-diagnostics/failure-contract.catalog";

const projectId = "11111111-1111-4111-8111-111111111111";
const serviceId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const retryId = "44444444-4444-4444-8444-444444444444";
const accountId = "123456789012";
const scope = { projectId, operationId, environmentName: "dev", region: "us-east-1", accountId };
const input = { projectId, serviceId, generationId: operationId, environment: "dev", configurationFingerprint: "a".repeat(64), secretValues: { TOKEN: "DO-NOT-PERSIST-SECRET-VALUE" } };
const secretName = `deployguard/${projectId}/dev/services/${serviceId}/runtime`;
const secretArn = `arn:aws:secretsmanager:us-east-1:${accountId}:secret:${secretName}-abcdef`;
const tags = { ManagedBy: "DeployGuard", DeployGuardProjectId: projectId, DeployGuardServiceId: serviceId, Environment: "dev", DeployGuardScope: "service", SecretPurpose: "application_runtime" };
const event = (phase: "intent" | "owned"): RuntimeSecretOwnershipEvent => ({ phase, projectId, operationId, serviceId, environmentName: "dev", secretName, versionToken: "f".repeat(64), ...(phase === "owned" ? { secretArn } : {}) });

async function verifyUnitBoundaries() {
  const receipt = runtimeSecretOwnershipRecord(event("owned"), scope);
  assert.equal(receipt.source, RUNTIME_SECRET_OWNERSHIP_SOURCE);
  assert.equal(receipt.pipelineRunId, operationId);
  assert.match(String(receipt.metadata!.sha256), /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(receipt), /DO-NOT-PERSIST|secretValues|valueFromByName/);
  for (const invalid of [
    { ...event("intent"), secretArn }, { ...event("owned"), secretArn: secretArn.replace(accountId, "999999999999") },
    { ...event("owned"), secretArn: secretArn.replace("us-east-1", "us-west-2") },
    { ...event("owned"), secretArn: `${secretArn}:TOKEN::${"a".repeat(64)}` },
    { ...event("owned"), projectId: retryId }, { ...event("owned"), operationId: retryId },
    { ...event("owned"), serviceId: retryId }, { ...event("owned"), environmentName: "prod" },
    { ...event("owned"), secretName: "shared/customer-secret" }, { ...event("owned"), secretValues: input.secretValues },
  ]) assert.throws(() => runtimeSecretOwnershipRecord(invalid as any, scope), RuntimeSecretOwnershipPersistenceError);

  let description: any = null;
  const calls: string[] = [];
  const records: any[] = [];
  const port: any = {
    describe: async () => { calls.push("describe"); return description; },
    create: async (_name: string, _value: string, token: string) => {
      calls.push("create"); description = { arn: secretArn, name: secretName, tags, deletionDate: null, versions: { [token]: ["AWSCURRENT"] } }; return secretArn;
    },
    restore: async () => { calls.push("restore"); description.deletionDate = null; },
    put: async (_arn: string, _value: string, token: string) => { calls.push("put"); description.versions = { ...description.versions, [token]: ["AWSCURRENT"] }; },
    activateVersion: async (_arn: string, move: string, remove: string) => { calls.push("activate"); description.versions[move] = ["AWSCURRENT"]; description.versions[remove] = []; },
    delete: async () => { calls.push("delete"); },
  };
  const recorder: RuntimeSecretOwnershipRecorder = async (value) => { calls.push(`retain:${value.phase}`); records.push(runtimeSecretOwnershipRecord(value, scope)); };
  const materializer = new RuntimeSecretMaterializer(port);
  const created = await materializer.materialize(input, recorder);
  assert.deepEqual(calls, ["retain:intent", "describe", "create", "retain:owned"]);
  assert.equal(created!.provisionalChange, "created");
  assert.doesNotMatch(JSON.stringify(records), /DO-NOT-PERSIST-SECRET-VALUE/);
  await materializer.compensate(created!);
  assert.ok(calls.includes("delete"));
  assert.equal(records.length, 2, "compensation must not erase ownership history or claim resource absence");

  calls.length = 0;
  await materializer.materialize(input, recorder);
  assert.deepEqual(calls, ["retain:intent", "describe", "retain:owned"], "reusing an immutable version retains ownership without a write");
  description = { ...description, deletionDate: new Date(), versions: { ["b".repeat(64)]: ["AWSCURRENT"] } };
  calls.length = 0;
  const changed = await materializer.materialize(input, recorder);
  assert.ok(calls.indexOf("retain:owned") < calls.indexOf("restore"));
  assert.ok(calls.lastIndexOf("retain:owned") < calls.indexOf("put"));
  assert.equal(changed!.previousVersionToken, "b".repeat(64));
  calls.length = 0;
  await assert.rejects(() => materializer.materialize(input, async () => { throw new RuntimeSecretOwnershipPersistenceError(); }), RuntimeSecretOwnershipPersistenceError);
  assert.deepEqual(calls, [], "intent persistence failure must precede every provider read/write");
  calls.length = 0;
  const wrongTags = description.tags;
  description.tags = { ...tags, DeployGuardProjectId: retryId };
  await assert.rejects(() => materializer.materialize(input, recorder), /ownership verification failed/);
  assert.deepEqual(calls, ["retain:intent", "describe"], "unowned identity must never be recorded as owned or mutated");
  description.tags = wrongTags;
  calls.length = 0;
  await materializer.materialize({ ...input, secretValues: {} }, recorder);
  assert.deepEqual(calls, [], "an empty secret map creates neither provider work nor fabricated evidence");

  // The service wrapper must preserve platform-vs-provider failure ownership.
  const wrapper = Object.create(GithubActionsRuntimeSecretService.prototype) as any;
  wrapper.port = () => port;
  let destroyed = 0;
  wrapper.client = { destroy: () => { destroyed += 1; } };
  wrapper.onModuleDestroy();
  assert.equal(destroyed, 1, "Nest shutdown must release the runtime-secret client's HTTP connections");
  calls.length = 0;
  await assert.rejects(() => wrapper.materialize(input), RuntimeSecretOwnershipPersistenceError);
  assert.deepEqual(calls, [], "the production service must reject an absent durable recorder before provider work");
  await assert.rejects(() => wrapper.materialize(input, async () => { throw new RuntimeSecretOwnershipPersistenceError(); }), RuntimeSecretOwnershipPersistenceError);
  const authority = Object.create(RailpackDeploymentService.prototype) as any;
  const failure = authority.dispatchFailure(new RuntimeSecretOwnershipPersistenceError(), "runtime_secret_materialization");
  assert.equal(failure.ownership.failureOwner, "DEPLOYGUARD_PLATFORM");
  assert.equal(failure.ownership.externalProvider, null);
  assert.equal(FAILURE_CONTRACT.DG_RUNTIME_SECRET_OWNERSHIP_PERSISTENCE_FAILED.owner, "DEPLOYGUARD_PLATFORM");
  assert.equal(FAILURE_CONTRACT.DG_RUNTIME_SECRET_OWNERSHIP_PERSISTENCE_FAILED.retryDecision, "NOT_SAFE_YET");
  assert.doesNotMatch(failure.message, /DO-NOT-PERSIST/);
  console.log("RUNTIME_SECRET_OWNERSHIP_UNIT=PASS INTENT_BEFORE_PROVIDER=1 OWNED_BEFORE_EXISTING_MUTATION=1 SECRET_VALUES_RETAINED=0 FAILURE_OWNER=PLATFORM");
}

async function verifyPostgresRetention() {
  const postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
  let database: DataSource | null = null;
  try {
    const env = { ...process.env, DATABASE_HOST: postgres.getHost(), DATABASE_PORT: String(postgres.getPort()), DATABASE_USERNAME: postgres.getUsername(), DATABASE_PASSWORD: postgres.getPassword(), DATABASE_NAME: postgres.getDatabase(), DATABASE_SSL: "false", AUTH_SESSION_SECRET: "m0-ownership-disposable-local-session-secret-32-characters", TYPEORM_SYNCHRONIZE: "false", NODE_ENV: "test" };
    const migration = spawnSync("npm", ["run", "migration:run"], { cwd: resolve(__dirname, ".."), env, encoding: "utf8", timeout: 120000 });
    assert.equal(migration.status, 0, "isolated zero-to-head PostgreSQL migrations must succeed");
    database = new DataSource({ ...AppDataSource.options, host: postgres.getHost(), port: postgres.getPort(), username: postgres.getUsername(), password: postgres.getPassword(), database: postgres.getDatabase(), ssl: false, synchronize: false, migrations: [] } as any);
    await database.initialize();
    assert.equal((await database.query("SELECT count(*)::int AS count FROM migrations"))[0].count, 111);
    const owner = (await database.query("INSERT INTO users (github_id,name,email,role) VALUES ('m0-ownership','Ownership fixture','ownership@example.invalid','developer') RETURNING id"))[0].id;
    await database.query("INSERT INTO projects (id,owner_user_id,name,repository_url,repository_full_name,target_branch,status,visibility) VALUES ($1,$2,'Ownership fixture','https://github.com/fixture/ownership','fixture/ownership','main','configured','private')", [projectId, owner]);
    const insertRun = async (id: string) => database!.query("INSERT INTO project_pipeline_runs (id,project_id,triggered_by_user_id,repository_url,repository_full_name,target_branch,status,current_stage,metadata) VALUES ($1,$2,$3,'https://github.com/fixture/ownership','fixture/ownership','main','failed','runtime_secret_materialization',$4::jsonb)", [id, projectId, owner, JSON.stringify({ executionEngine: "railpack", deploymentAction: "deploy" })]);
    await insertRun(operationId);
    await insertRun(retryId);
    const service = Object.create(RailpackDeploymentService.prototype) as any;
    service.dataSource = database;
    service.config = { get: (key: string, fallback: string) => key === "DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN" ? `arn:aws:iam::${accountId}:role/deployguard` : key === "AWS_REGION" ? "us-east-1" : fallback };
    const retain = (value: RuntimeSecretOwnershipEvent) => service.retainRuntimeSecretOwnership(projectId, value.operationId, "dev", value);

    // Simulate create accepted by AWS but its response lost. Only intent remains;
    // no arbitrary ARN, compensating delete, or false owned proof is invented.
    const ambiguous = new RuntimeSecretMaterializer({ describe: async () => null, create: async () => { throw new Error("provider response lost"); } } as any);
    await assert.rejects(() => ambiguous.materialize(input, retain), /provider response lost/);
    const intents = await database.getRepository(ProjectPipelineEvent).findBy({ pipelineRunId: operationId, source: RUNTIME_SECRET_OWNERSHIP_SOURCE });
    assert.equal(intents.length, 1);
    assert.equal(intents[0].status, "intent");
    assert.equal((intents[0].metadata!.evidence as any).secretArn, undefined);

    const owned = { arn: secretArn, name: secretName, tags, deletionDate: null, versions: { ["b".repeat(64)]: ["AWSCURRENT"] } };
    const candidates: RuntimeSecretMaterialization[] = [];
    let writes = 0;
    const materializer = new RuntimeSecretMaterializer({ describe: async () => owned, put: async () => { writes++; throw new Error("put response lost"); } } as any);
    await assert.rejects(() => materializer.materialize(input, async (value, candidate) => { if (candidate) candidates.push(candidate); await retain(value); }), /put response lost/);
    assert.equal(writes, 1);
    assert.equal(candidates[0].previousVersionToken, "b".repeat(64), "ambiguous writes retain a compensation candidate before the response");
    await database.query("UPDATE project_pipeline_runs SET metadata=$1::jsonb, status='failed' WHERE id=$2", [JSON.stringify({ failureCategory: "provider_failure" }), operationId]);
    const materializedVersion = createHash("sha256").update(`deployguard-runtime-secret:${projectId}:dev:${input.configurationFingerprint}`).digest("hex");
    const retry = new RuntimeSecretMaterializer({ describe: async () => ({ ...owned, versions: { [materializedVersion]: ["AWSCURRENT"] } }) } as any);
    await retry.materialize({ ...input, generationId: retryId }, retain);
    const receipts = await database.getRepository(ProjectPipelineEvent).find({ where: { projectId, source: RUNTIME_SECRET_OWNERSHIP_SOURCE }, order: { createdAt: "ASC" } });
    assert.equal(receipts.length, 6, "original intents/receipts survive mutable run metadata and an independent retry");
    for (const receipt of receipts) {
      assert.equal(receipt.metadata!.sha256, createHash("sha256").update(JSON.stringify(receipt.metadata!.evidence, Object.keys(receipt.metadata!.evidence as object).sort())).digest("hex"), "PostgreSQL JSONB key ordering must not invalidate ownership hashes");
      assert.doesNotMatch(JSON.stringify(receipt.metadata), /DO-NOT-PERSIST-SECRET-VALUE|secretValues/);
    }

    // Failed post-create receipt insertion still exposes the exact compensation
    // candidate before dispatch. The durable pre-create intent remains intact.
    const createdCandidates: RuntimeSecretMaterialization[] = [];
    await database.query("CREATE FUNCTION reject_fixture_owned_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source='runtime_secret_ownership' AND NEW.status='owned' THEN RAISE EXCEPTION 'PRIVATE_DATABASE_ERROR'; END IF; RETURN NEW; END $$");
    await database.query("CREATE TRIGGER reject_fixture_owned_receipt BEFORE INSERT ON project_pipeline_events FOR EACH ROW EXECUTE FUNCTION reject_fixture_owned_receipt()");
    let deleted = false;
    const port: any = { describe: async () => null, create: async () => secretArn, delete: async () => { deleted = true; } };
    const wrapper = Object.create(GithubActionsRuntimeSecretService.prototype) as any;
    wrapper.port = () => port;
    service.runtimeSecrets = wrapper;
    service.crypto = { decrypt: (value: string) => value };
    const admitted = { project: { id: projectId }, environmentName: "dev", services: [{ id: serviceId, name: "Web", serviceDirectory: ".", servicePort: 8080 }], variables: [{ serviceId, key: "TOKEN", isSecret: true, scope: "runtime", encryptedValue: input.secretValues.TOKEN }], managedDatabase: null };
    const construct = (candidates: RuntimeSecretMaterialization[]) => service.runtimeConfiguration({ id: projectId }, "dev", operationId, "a".repeat(40), "deploy", null, admitted, candidates, null, retain);
    await assert.rejects(() => construct(createdCandidates), (error: any) => error instanceof RuntimeSecretOwnershipPersistenceError && error.identityValidated);
    assert.equal(createdCandidates[0].provisionalChange, "created");
    port.describe = async () => owned;
    assert.deepEqual(await service.compensateProvisionalRuntimeSecrets(createdCandidates, true), { skipped: "remote_dispatch_possible" });
    assert.equal(deleted, false);
    assert.deepEqual(await service.compensateProvisionalRuntimeSecrets(createdCandidates, false), { cleaned: 1, failed: 0 });
    assert.equal(deleted, true, "exact owned compensation remains available after a receipt storage failure");
    const invalidCandidates: RuntimeSecretMaterialization[] = [];
    port.describe = async () => null;
    port.create = async () => secretArn.replace(accountId, "999999999999");
    await assert.rejects(() => construct(invalidCandidates), (error: any) => error instanceof RuntimeSecretOwnershipPersistenceError && !error.identityValidated);
    assert.equal(invalidCandidates.length, 0, "rejected cross-account identifiers must never become compensating-delete candidates");

    const failing = Object.create(RailpackDeploymentService.prototype) as any;
    failing.config = service.config;
    failing.dataSource = { getRepository: () => ({ insert: async () => { throw new Error("PRIVATE_DATABASE_ERROR"); } }) };
    await assert.rejects(() => failing.retainRuntimeSecretOwnership(projectId, operationId, "dev", event("intent")), (error: any) => error instanceof RuntimeSecretOwnershipPersistenceError && !error.message.includes("PRIVATE_DATABASE_ERROR"));
    console.log("RUNTIME_SECRET_OWNERSHIP_POSTGRES=PASS MIGRATIONS=111 APPEND_ONLY_ROWS=1 FAILURE_AND_RETRY_RETAINED=1 AMBIGUOUS_CREATE_INTENT_ONLY=1 POST_CREATE_COMPENSATION=1 AWS_EXECUTION=MOCKED");
  } finally {
    try { if (database?.isInitialized) await database.destroy(); }
    finally { await postgres.stop(); }
  }
}

void (async () => { await verifyUnitBoundaries(); await verifyPostgresRetention(); })().catch((error) => { console.error(error); process.exitCode = 1; });
