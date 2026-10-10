import "reflect-metadata";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ConfigService } from "@nestjs/config";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { DataSource } from "typeorm";
import AppDataSource from "../src/data-source";
import { AWS_RESOURCE_COLLECTION_CONTRACT, awsOwnershipCollectionContext, buildAwsOwnershipJournal, retainAwsOwnershipCollection } from "../src/projects/aws-resource-ownership-ingestion";
import { AWS_RESOURCE_OWNERSHIP_SOURCE, DestroyOwnershipIncompleteError, freezeDestroyOwnership, ownershipSha256 } from "../src/projects/aws-resource-ownership";
import { ProjectPipelineEvent } from "../src/projects/project-pipeline-event.entity";
import { ProjectPipelineRun } from "../src/projects/project-pipeline-run.entity";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { immutableRailpackDispatchFingerprint, RAILPACK_WORKFLOW_INPUTS, servicesBase64 } from "../src/projects/railpack-workflow-contract";
import { RUNTIME_SECRET_OWNERSHIP_SOURCE, runtimeSecretOwnershipRecord } from "../src/projects/runtime-secret-ownership";
import { DEPLOYGUARD_OWNERSHIP_ARTIFACT_ENTRY, GithubActionsService } from "../src/projects/pipeline/github-actions.service";
import { buildDeterministicZip } from "../src/terraform-export/zip-builder";
import { destroyProofFixture } from "./fixtures/destroy-proof";

const projectId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const destroyId = "33333333-3333-4333-8333-333333333333";
const proof = destroyProofFixture(projectId, destroyId, [operationId]);
const serviceId = proof.revisions[0].serviceId;
const inputs: any = Object.fromEntries(RAILPACK_WORKFLOW_INPUTS.map(({ name }) => [name, "fixture"]));
Object.assign(inputs, { deployment_action: "deploy", deployment_operation_id: operationId, project_id: projectId, environment_name: "dev",
  repository_full_name: "fixture/ownership", repository_branch: "main", commit_sha: "a".repeat(40), control_plane_sha: "d".repeat(40),
  aws_region: "us-east-1", aws_role_arn: "arn:aws:iam::123456789012:role/deployguard", terraform_state_bucket: "m0-disposable-state",
  services_base64: servicesBase64({ schemaVersion: 3, projectId, operationId, environmentName: "dev", sourceSha: "a".repeat(40), services: [{
    serviceId, serviceName: "Web", serviceDirectory: ".", servicePort: 3000, runtimeConfigRevisionId: proof.configurations[0].id,
    buildEnvironment: {}, buildSecretReferences: {}, environment: { PORT: "3000", HOST: "0.0.0.0" }, secretReferences: {}, databaseAttached: false,
    managedDatabase: { engine: null, aliases: [] },
  }] }) });
const operation: any = { ...proof.operations[0], repositoryFullName: inputs.repository_full_name, targetBranch: "main", githubWorkflowRunId: "123",
  status: "running", triggeredByUserId: 7, metadata: { ...proof.operations[0].metadata, configuredControlPlaneSha: inputs.control_plane_sha,
    immutableDispatchInputs: inputs, immutableDispatchFingerprint: immutableRailpackDispatchFingerprint(inputs) } };
const collection = { ...structuredClone(proof.journals[0]), contractVersion: AWS_RESOURCE_COLLECTION_CONTRACT,
  coverage: ["terraform", "ecr", "ecs", "state"], resources: [...proof.journals[0].resources, ...proof.ownership.manifest.resources.filter((row) => row.type === "s3_state_object")] };
const scope = proof.journals[0].scope;
const secretName = `deployguard/${projectId}/dev/services/${serviceId}/runtime`;
const secretArn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${secretName}-abcdef`;
const runtimeEvents = (["intent", "owned"] as const).map((phase) => runtimeSecretOwnershipRecord({ phase, projectId, operationId, serviceId, environmentName: "dev",
  secretName, versionToken: "e".repeat(64), ...(phase === "owned" ? { secretArn } : {}) }, scope));

async function verifyUnitAndTransport() {
  const { initializeOwnership, beginOwnershipWrite, resolveOwnershipWrite, completedOwnership } = require("../../infrastructure/railpack-runtime/collect-ownership.mjs");
  const started = initializeOwnership(scope, operation.commitSha, inputs.terraform_state_bucket);
  const pending = beginOwnershipWrite(started, "fixture/terraform");
  assert.throws(() => buildAwsOwnershipJournal(pending, operation, runtimeEvents as ProjectPipelineEvent[]), DestroyOwnershipIncompleteError,
    "an actual interrupted producer cannot pass the existing strict intake");
  const resolved = resolveOwnershipWrite(pending, "fixture/terraform", proof.journals[0].resources);
  assert.deepEqual(buildAwsOwnershipJournal(completedOwnership(resolved), operation, runtimeEvents as ProjectPipelineEvent[]),
    buildAwsOwnershipJournal(collection, operation, runtimeEvents as ProjectPipelineEvent[]), "real producer identifiers round-trip through server-secret intake");
  const journal = buildAwsOwnershipJournal(collection, operation, runtimeEvents as ProjectPipelineEvent[]);
  assert.deepEqual(journal.coverage, ["terraform", "ecr", "ecs", "runtime_secrets", "state"]);
  assert.ok(journal.resources.some((row) => row.type === "aws_secretsmanager_secret" && row.id === secretArn));
  const original = structuredClone(collection);
  const reordered = structuredClone(collection); reordered.resources.reverse(); reordered.coverage.reverse();
  assert.deepEqual(buildAwsOwnershipJournal(reordered, operation, runtimeEvents as ProjectPipelineEvent[]), journal);
  assert.deepEqual(collection, original, "ingestion cannot mutate provider evidence");
  for (const mutate of [
    (row: any) => { row.scope.projectId = destroyId; }, (row: any) => { row.scope.operationId = destroyId; },
    (row: any) => { row.scope.environmentName = "prod"; }, (row: any) => { row.scope.accountId = "999999999999"; },
    (row: any) => { row.scope.region = "us-west-2"; }, (row: any) => { row.sourceSha = "b".repeat(40); },
    (row: any) => { row.coverage.push("runtime_secrets"); }, (row: any) => { row.coverage.pop(); },
    (row: any) => { row.unresolvedIntents.push("registration-response-lost"); }, (row: any) => { row.secretValue = "DO-NOT-RETAIN"; },
    (row: any) => { row.resources = row.resources.filter((resource: any) => !resource.id.endsWith(".tflock")); },
    (row: any) => { row.resources.find((resource: any) => resource.type === "s3_state_object").parent = "another-bucket"; },
    (row: any) => { row.resources.push({ type: "aws_secretsmanager_secret", id: secretArn, parent: "unrelated" }); },
  ]) {
    const invalid = structuredClone(collection); mutate(invalid);
    assert.throws(() => buildAwsOwnershipJournal(invalid, operation, runtimeEvents as ProjectPipelineEvent[]), DestroyOwnershipIncompleteError);
  }
  for (const mutate of [
    (row: any) => { row.githubWorkflowRunId = "../other"; }, (row: any) => { row.commitSha = "b".repeat(40); },
    (row: any) => { row.metadata.configuredControlPlaneSha = "c".repeat(40); }, (row: any) => { row.metadata.immutableDispatchFingerprint = "f".repeat(64); },
    (row: any) => { row.metadata.immutableDispatchInputs.aws_region = "us-west-2"; },
    (row: any) => { row.metadata.immutableDispatchInputs.services_base64 = "not-base64"; row.metadata.immutableDispatchFingerprint = immutableRailpackDispatchFingerprint(row.metadata.immutableDispatchInputs); },
  ]) { const invalid = structuredClone(operation); mutate(invalid); assert.throws(() => awsOwnershipCollectionContext(invalid), DestroyOwnershipIncompleteError); }
  for (const rows of [[runtimeEvents[0]], [runtimeEvents[1]]]) assert.throws(() => buildAwsOwnershipJournal(collection, operation, rows as ProjectPipelineEvent[]), DestroyOwnershipIncompleteError);
  const corrupt = structuredClone(runtimeEvents); corrupt[0].metadata!.sha256 = "f".repeat(64);
  assert.throws(() => buildAwsOwnershipJournal(collection, operation, corrupt as ProjectPipelineEvent[]), DestroyOwnershipIncompleteError);
  const pinned = structuredClone(operation);
  const intended = JSON.parse(Buffer.from(pinned.metadata.immutableDispatchInputs.services_base64, "base64").toString("utf8"));
  intended.services[0].buildSecretReferences = { TOKEN: `${secretArn}:TOKEN::${"e".repeat(64)}` };
  pinned.metadata.immutableDispatchInputs.services_base64 = servicesBase64(intended);
  pinned.metadata.immutableDispatchFingerprint = immutableRailpackDispatchFingerprint(pinned.metadata.immutableDispatchInputs);
  assert.throws(() => buildAwsOwnershipJournal(collection, pinned, []), DestroyOwnershipIncompleteError,
    "missing all secret rows cannot certify an operation that explicitly pinned build-only secret materialization");
  assert.deepEqual(buildAwsOwnershipJournal(collection, pinned, runtimeEvents as ProjectPipelineEvent[]), journal);
  const otherArn = secretArn.replace(/abcdef$/, "ghijkl");
  intended.services[0].secretReferences = { TOKEN: `${otherArn}:TOKEN::${"f".repeat(64)}` };
  pinned.metadata.immutableDispatchInputs.services_base64 = servicesBase64(intended);
  pinned.metadata.immutableDispatchFingerprint = immutableRailpackDispatchFingerprint(pinned.metadata.immutableDispatchInputs);
  assert.throws(() => buildAwsOwnershipJournal(collection, pinned, runtimeEvents as ProjectPipelineEvent[]), DestroyOwnershipIncompleteError,
    "runtime keys cannot shadow a distinct build-secret physical identity");
  const otherEvents = (["intent", "owned"] as const).map((phase) => runtimeSecretOwnershipRecord({ phase, projectId, operationId, serviceId, environmentName: "dev",
    secretName, versionToken: "f".repeat(64), ...(phase === "owned" ? { secretArn: otherArn } : {}) }, scope));
  assert.throws(() => buildAwsOwnershipJournal(collection, pinned, otherEvents as ProjectPipelineEvent[]), DestroyOwnershipIncompleteError,
    "even matching runtime receipts cannot hide a missing same-key build-secret receipt");
  const both = buildAwsOwnershipJournal(collection, pinned, [...runtimeEvents, ...otherEvents] as ProjectPipelineEvent[]);
  assert.ok(both.resources.some((row) => row.id === secretArn) && both.resources.some((row) => row.id === otherArn));

  const actions = new GithubActionsService(new ConfigService({}));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let listed = { artifacts: [{ id: 1, name: `deployguard-ownership-${operationId}`, expired: false }] };
  let archive = buildDeterministicZip([{ path: DEPLOYGUARD_OWNERSHIP_ARTIFACT_ENTRY, content: Buffer.from(JSON.stringify(collection)) }]);
  globalThis.fetch = async (url, options) => {
    requests++; assert.ok(options?.signal, "ownership requests retain bounded transport timeouts");
    if (String(url).includes("/artifacts?")) {
      assert.equal(new URL(String(url)).searchParams.get("name"), `deployguard-ownership-${operationId}`);
      assert.ok(String(url).includes("/runs/123/"), "only the exact correlated workflow can supply ownership");
      return new Response(JSON.stringify(listed));
    }
    return new Response(archive);
  };
  try {
    assert.equal(await actions.getOwnershipArtifact(inputs.repository_full_name, "123", operationId, "fixture-token"), JSON.stringify(collection));
    listed = { artifacts: [{ id: 1, name: `deployguard-result-${operationId}`, expired: false }] };
    assert.equal(await actions.getOwnershipArtifact(inputs.repository_full_name, "123", operationId, "fixture-token"), null,
      "release results cannot substitute for exact ownership artifact identity");
    listed = { artifacts: [{ id: 1, name: `deployguard-ownership-${operationId}`, expired: false }] };
    archive = buildDeterministicZip([{ path: DEPLOYGUARD_OWNERSHIP_ARTIFACT_ENTRY, content: Buffer.alloc(512 * 1024 + 1, 65) }]);
    await assert.rejects(() => actions.getOwnershipArtifact(inputs.repository_full_name, "123", operationId, "fixture-token"));
    assert.ok(requests >= 5);
  } finally { globalThis.fetch = originalFetch; }
  const lifecycle: any = Object.create(RailpackDeploymentService.prototype);
  let reads = 0;
  lifecycle.actions = { getOwnershipArtifact: async () => { reads++; return null; } };
  const missing = structuredClone(operation);
  await lifecycle.retainWorkflowAwsOwnership(missing, "fixture-token");
  assert.equal(missing.metadata.awsOwnershipCollectionStatus, "missing");
  lifecycle.actions.getOwnershipArtifact = async () => "{DO-NOT-RETAIN";
  const invalid = structuredClone(operation);
  await lifecycle.retainWorkflowAwsOwnership(invalid, "fixture-token");
  assert.equal(invalid.metadata.awsOwnershipCollectionStatus, "invalid");
  assert.doesNotMatch(JSON.stringify(invalid.metadata), /DO-NOT-RETAIN|fixture-token/);
  const unbound = structuredClone(operation); unbound.metadata.immutableDispatchFingerprint = "f".repeat(64);
  await lifecycle.retainWorkflowAwsOwnership(unbound, "fixture-token");
  assert.equal(reads, 1, "unbound operations fail before artifact/provider work");
  const terminal: any = structuredClone(operation);
  terminal.status = "completed";
  terminal.metadata = { ...terminal.metadata, awsOwnershipCollectionStatus: "unavailable", awsOwnershipCollectionAttempts: 1,
    awsOwnershipCollectionReadAfter: new Date(0).toISOString(), terminalWorkflowStagesUnavailable: false,
    workflowStages: [{ key: "runtime", status: "passed" }] };
  const recovery: any = Object.create(RailpackDeploymentService.prototype);
  let ownershipReads = 0;
  let persistedPatches = 0;
  let parameters: Record<string, unknown> = {};
  const query: any = { update: () => query, set: (fields: any) => { assert.deepEqual(Object.keys(fields), ["metadata"]); return query; },
    where: (_where: string, values: any) => { parameters = values; return query; },
    setParameters: (values: any) => { parameters = { ...parameters, ...values }; return query; }, execute: async () => {
      assert.equal(parameters.id, terminal.id); assert.equal(parameters.projectId, terminal.projectId);
      assert.equal(parameters.workflowRunId, terminal.githubWorkflowRunId);
      const patch = JSON.parse(String(parameters.ownershipPatch));
      assert.deepEqual(Object.keys(patch).sort(), ["awsOwnershipCollectionAttempts", "awsOwnershipCollectionReadAfter", "awsOwnershipCollectionStatus"]);
      assert.equal(patch.awsOwnershipCollectionStatus, "missing");
      persistedPatches++; return { affected: 1 };
    } };
  recovery.projects = { findOne: async () => ({ id: projectId, repositoryFullName: "fixture/moved" }) };
  recovery.users = { findOne: async () => ({ id: 7 }) };
  recovery.githubApp = { tokenForRepository: async (_id: number, repository: string) => {
    assert.equal(repository, inputs.repository_full_name, "ownership backfill uses immutable historical repository, not current project settings");
    return { token: "fixture-token" };
  } };
  recovery.actions = { getOwnershipArtifact: async (repository: string) => { ownershipReads++; assert.equal(repository, inputs.repository_full_name); return null; } };
  recovery.runs = { createQueryBuilder: () => query, save: async () => assert.fail("terminal backfill must never save/reinsert a stale deleted operation") };
  await recovery.reconcileTerminalWorkflowStages(terminal);
  assert.equal(ownershipReads, 1, "a settled terminal stage snapshot must not prevent retry of transient ownership transport failure");
  assert.equal(terminal.metadata.awsOwnershipCollectionAttempts, 2);
  assert.equal(terminal.status, "completed", "ownership recovery cannot change release outcome");
  await recovery.reconcileTerminalWorkflowStages(terminal);
  assert.equal(ownershipReads, 1, "retry remains throttled even under repeated polling");
  terminal.metadata.awsOwnershipCollectionReadAfter = new Date(0).toISOString();
  await recovery.reconcileTerminalWorkflowStages(terminal);
  assert.equal(ownershipReads, 2); assert.equal(terminal.metadata.awsOwnershipCollectionAttempts, 3);
  terminal.metadata.awsOwnershipCollectionReadAfter = new Date(0).toISOString();
  await recovery.reconcileTerminalWorkflowStages(terminal);
  assert.equal(ownershipReads, 2, "retry budget cannot become unlimited provider polling");
  assert.equal(persistedPatches, 2, "bounded terminal retries persist metadata-only updates, never overwrite immutable release authority");
  console.log("AWS_OWNERSHIP_INTAKE=PASS IMMUTABLE_IDENTITY=1 EXACT_BOUNDED_ARTIFACT=1 SERVER_SECRET_COVERAGE=1 INCOMPLETE_REJECTED=1 RAW_VALUES_RETAINED=0 AWS_EXECUTION=NONE");
}

async function verifyPostgresRetention() {
  const postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
  let database: DataSource | null = null;
  try {
    const env = { ...process.env, DATABASE_HOST: postgres.getHost(), DATABASE_PORT: String(postgres.getPort()), DATABASE_USERNAME: postgres.getUsername(),
      DATABASE_PASSWORD: postgres.getPassword(), DATABASE_NAME: postgres.getDatabase(), DATABASE_SSL: "false",
      AUTH_SESSION_SECRET: "m0-aws-intake-disposable-local-session-secret-32-characters", TYPEORM_SYNCHRONIZE: "false", NODE_ENV: "test" };
    const migrated = spawnSync("npm", ["run", "migration:run"], { cwd: resolve(__dirname, ".."), env, encoding: "utf8", timeout: 120000 });
    assert.equal(migrated.status, 0, "owned PostgreSQL must migrate from zero without synchronize");
    database = new DataSource({ ...AppDataSource.options, host: postgres.getHost(), port: postgres.getPort(), username: postgres.getUsername(), password: postgres.getPassword(),
      database: postgres.getDatabase(), ssl: false, synchronize: false, migrations: [] } as any);
    await database.initialize();
    assert.equal((await database.query("SELECT count(*)::int AS count FROM migrations"))[0].count, 112);
    assert.equal((await database.query("SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1"))[0].name, "OrganizationAwsAccountBindings1791580000000");
    const owner = (await database.query("INSERT INTO users (github_id,name,email,role) VALUES ('m0-aws-intake','Intake fixture','intake@example.invalid','developer') RETURNING id"))[0].id;
    await database.query("INSERT INTO projects (id,owner_user_id,name,repository_url,repository_full_name,target_branch,status,visibility) VALUES ($1,$2,'Intake fixture','https://github.com/fixture/ownership','fixture/ownership','main','configured','private')", [projectId, owner]);
    await database.query("INSERT INTO project_pipeline_runs (id,project_id,triggered_by_user_id,repository_url,repository_full_name,target_branch,status,current_stage,commit_sha,github_workflow_run_id,metadata) VALUES ($1,$2,$3,'https://github.com/fixture/ownership','fixture/ownership','main','failed','aws_runtime_verification',$4,'123',$5::jsonb)", [operationId, projectId, owner, operation.commitSha, JSON.stringify(operation.metadata)]);
    const events = database.getRepository(ProjectPipelineEvent);
    await events.save(runtimeEvents as Partial<ProjectPipelineEvent>[]);
    assert.deepEqual(await Promise.all(Array.from({ length: 3 }, () => retainAwsOwnershipCollection(database!, operation, collection))), ["retained", "retained", "retained"]);
    let retained = await events.findBy({ projectId, pipelineRunId: operationId, source: AWS_RESOURCE_OWNERSHIP_SOURCE });
    assert.equal(retained.length, 1, "concurrent collection must publish one append-only receipt");
    const journal = buildAwsOwnershipJournal(collection, operation, runtimeEvents as ProjectPipelineEvent[]);
    assert.deepEqual(retained[0].metadata!.evidence, journal, "JSONB key order cannot change retained ownership");
    assert.equal(retained[0].metadata!.sha256, ownershipSha256(journal));
    assert.doesNotMatch(JSON.stringify(retained), /secret_string|DO-NOT-RETAIN|fixture-token/);
    const historicalScope = { ...scope, operationId: destroyId, generationIds: [operationId] };
    const frozen = freezeDestroyOwnership(historicalScope, [operation], retained, inputs.terraform_state_bucket);
    assert.ok(frozen.manifest.resources.some((row) => row.id === secretArn));

    const recovery: any = Object.create(RailpackDeploymentService.prototype);
    recovery.dataSource = database;
    recovery.projects = { findOne: async () => ({ id: projectId, repositoryFullName: "fixture/moved" }) };
    recovery.users = { findOne: async () => ({ id: owner }) };
    recovery.githubApp = { tokenForRepository: async (_id: number, repository: string) => {
      assert.equal(repository, inputs.repository_full_name); return { token: "fixture-token" };
    } };
    recovery.actions = { getOwnershipArtifact: async () => JSON.stringify(collection) };
    recovery.runs = database.getRepository(ProjectPipelineRun);
    const terminal = await recovery.runs.findOneByOrFail({ id: operationId });
    terminal.metadata = { ...terminal.metadata, awsOwnershipCollectionStatus: "unavailable", awsOwnershipCollectionAttempts: 1,
      awsOwnershipCollectionReadAfter: new Date(0).toISOString(), workflowStages: [{ key: "runtime", status: "failed" }] };
    await recovery.runs.update({ id: operationId }, { metadata: terminal.metadata });
    await recovery.reconcileTerminalWorkflowStages(terminal);
    const backfilled = await recovery.runs.findOneByOrFail({ id: operationId });
    assert.equal(backfilled.metadata.awsOwnershipCollectionStatus, "retained");
    assert.equal(backfilled.metadata.awsOwnershipCollectionAttempts, 2);
    assert.equal(backfilled.status, "failed", "real PostgreSQL backfill cannot promote a failed release");
    assert.equal(backfilled.commitSha, operation.commitSha);
    assert.deepEqual(backfilled.metadata.immutableDispatchInputs, inputs);
    assert.equal(await events.countBy({ pipelineRunId: operationId, source: AWS_RESOURCE_OWNERSHIP_SOURCE }), 1);

    // A terminal stage-only refresh racing cascade deletion cannot resurrect a
    // stale operation. Exercise the actual TypeORM UPDATE against PostgreSQL.
    const deletedId = "44444444-4444-4444-8444-444444444444";
    const deleted = recovery.runs.create({ ...backfilled, id: deletedId, metadata: { workflowStages: [{ key: "runtime", status: "running" }] } });
    await recovery.runs.save(deleted);
    recovery.terminalWorkflowStages = async () => {
      await database!.query("DELETE FROM project_pipeline_runs WHERE id=$1", [deletedId]);
      return { stages: [{ key: "runtime", status: "failed" }], unavailable: false };
    };
    await recovery.reconcileTerminalWorkflowStages(deleted);
    assert.equal(await recovery.runs.countBy({ id: deletedId }), 0, "metadata-only refresh never reinserts a concurrently deleted terminal row");

    await database.query("UPDATE project_pipeline_runs SET github_workflow_run_id='456' WHERE id=$1", [operationId]);
    await assert.rejects(() => retainAwsOwnershipCollection(database!, operation, collection), DestroyOwnershipIncompleteError,
      "persisted transport drift must fail under the operation lock");
    assert.equal(await events.countBy({ pipelineRunId: operationId, source: AWS_RESOURCE_OWNERSHIP_SOURCE }), 1);
    await database.query("UPDATE project_pipeline_runs SET github_workflow_run_id='123' WHERE id=$1", [operationId]);
    for (const conclusion of ["success", "failure"]) {
      const order: string[] = [];
      const lifecycle: any = Object.create(RailpackDeploymentService.prototype);
      lifecycle.dataSource = database;
      lifecycle.projects = { findOne: async () => ({ id: projectId, repositoryFullName: inputs.repository_full_name, environmentName: "dev" }) };
      lifecycle.users = { findOne: async () => ({ id: owner }) };
      lifecycle.githubApp = { tokenForRepository: async () => ({ token: "fixture-token" }) };
      lifecycle.actions = { getWorkflowRun: async () => ({ status: "completed", conclusion }),
        getOwnershipArtifact: async () => { order.push("ownership"); return JSON.stringify(collection); } };
      lifecycle.terminalWorkflowStages = async () => ({ stages: [], unavailable: false });
      lifecycle.releaseEvidence = async () => { order.push("release"); return { simulatedVerifiedRelease: true }; };
      lifecycle.finalizeVerifiedRelease = async (_project: unknown, row: any) => {
        assert.equal(row.metadata.awsOwnershipCollectionStatus, "retained");
        assert.equal(await events.countBy({ pipelineRunId: operationId, source: AWS_RESOURCE_OWNERSHIP_SOURCE }), 1);
        order.push("success");
      };
      lifecycle.terminalFailureEvidence = async () => null;
      lifecycle.captureTerminalFailure = async (row: any) => { assert.equal(row.metadata.awsOwnershipCollectionStatus, "retained"); order.push("failure"); };
      lifecycle.costEvidence = { capture: async () => null };
      lifecycle.runs = { save: async (row: unknown) => row };
      await lifecycle.reconcile(structuredClone(operation));
      assert.deepEqual(order, conclusion === "success" ? ["ownership", "release", "success"] : ["ownership", "failure"],
        "ownership intake precedes either terminal lifecycle path; simulated release evidence is not AWS certification");
    }
    const contradictory = structuredClone(collection); contradictory.resources.push({ type: "aws_ecs_task_definition", id: "arn:aws:ecs:us-east-1:123456789012:task-definition/fixture:99" });
    assert.equal(await retainAwsOwnershipCollection(database, operation, contradictory), "conflict");
    retained = await events.findBy({ pipelineRunId: operationId, source: AWS_RESOURCE_OWNERSHIP_SOURCE });
    assert.equal(retained.length, 2, "contradictory receipts must survive, not overwrite or silently union authority");
    assert.throws(() => freezeDestroyOwnership(historicalScope, [operation], retained, inputs.terraform_state_bucket), DestroyOwnershipIncompleteError);
    assert.equal(await retainAwsOwnershipCollection(database, operation, contradictory), "conflict");
    assert.equal(await events.countBy({ pipelineRunId: operationId, source: AWS_RESOURCE_OWNERSHIP_SOURCE }), 2, "ambiguous retries must remain bounded");
    assert.equal(await database.getRepository(ProjectPipelineRun).countBy({ id: operationId }), 1, "failed attempt authority remains available");
    console.log("AWS_OWNERSHIP_POSTGRES=PASS MIGRATIONS=112 CONCURRENT_IDEMPOTENCY=1 LOCKED_TRANSPORT=1 FAILED_ATTEMPT_RETAINED=1 CONFLICT_APPEND_ONLY=1 AWS_EXECUTION=NONE");
  } finally { try { if (database?.isInitialized) await database.destroy(); } finally { await postgres.stop(); } }
}

void (async () => { await verifyUnitAndTransport(); await verifyPostgresRetention(); })().catch((error) => { console.error(error); process.exitCode = 1; });
