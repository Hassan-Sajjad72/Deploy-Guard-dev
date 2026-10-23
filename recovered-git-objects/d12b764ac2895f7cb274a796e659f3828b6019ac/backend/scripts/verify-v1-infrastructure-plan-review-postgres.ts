import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { InfrastructureSpecV1 } from "../src/orchestration-contracts/contracts/infrastructure-manifest.types";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { V1InfrastructurePlanReviewService } from "../src/orchestration-contracts/infrastructure/v1-infrastructure-plan-review.service";
import { CreateTwoLaneManifestsAndStateRevisions1760000034000 } from "../src/migrations/1760000034000-CreateTwoLaneManifestsAndStateRevisions";

const schema = `v1_plan_review_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const projectId = "11111111-1111-4111-8111-111111111111";
const manifestId = "22222222-2222-4222-8222-222222222222";
const checkpointId = "33333333-3333-4333-8333-333333333333";
const digest = `sha256:${"a".repeat(64)}`;
const image = `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-canary@${digest}`;
let root = "";

const base = AppDataSource.options as DataSourceOptions & { extra?: Record<string, unknown> };
const admin = new DataSource({ ...base, entities: [], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
const dataSource = new DataSource({ ...base, schema, entities: [InfrastructureManifest], migrations: [], synchronize: false, logging: false, extra: { ...(base.extra || {}), options: `-c search_path=${schema},public` } } as DataSourceOptions);

const spec = (): InfrastructureSpecV1 => ({
  region: "us-east-1", terraformTemplateVersion: "v1",
  network: { topology: "managed_vpc", availabilityZoneCount: 2, publicSubnets: true, privateSubnets: true, natMode: "none" },
  registry: { managedEcrRepository: true, immutableTags: true, lifecyclePolicyHash: null },
  ecsFoundation: { clusterMode: "shared_project", serviceName: "canary", launchType: "fargate", capacityProviders: ["FARGATE"] },
  ingress: { enabled: true, protocol: "HTTP", containerPort: 8080, targetGroupPort: 8080, healthCheckPath: "/", healthCheckProtocol: "HTTP" },
  database: { mode: "none", engine: null, tierRevision: null, persistence: false, externalTlsRequired: null },
  storage: { efsRequired: false, accessPointRequired: false, encrypted: true, backupRequired: false },
  discovery: { cloudMapRequired: false, namespace: null },
  observability: { cloudWatchLogs: true, cloudWatchMetrics: true, prometheus: false }, iamPolicyRevision: "v1",
  tags: { Environment: "dev", ManagedBy: "DeployGuard", ProjectId: projectId },
});

async function setup() {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query(`CREATE TABLE users (id integer PRIMARY KEY)`);
    await runner.query(`CREATE TABLE projects (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE project_pipeline_runs (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE project_deployment_contracts (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE project_configuration_snapshots (id uuid PRIMARY KEY)`);
    await new CreateTwoLaneManifestsAndStateRevisions1760000034000().up(runner);
    await runner.query(`CREATE TABLE project_stage_checkpoints (id uuid PRIMARY KEY, project_id uuid NOT NULL, pipeline_run_id uuid NOT NULL, stage varchar NOT NULL, status varchar NOT NULL, image_digest varchar, artifact_reference jsonb)`);
  } finally { await runner.release(); }
}

async function plannedManifest(id = manifestId, revision = "1") {
  const desiredSpec = spec();
  const workspaceRef = `v1-plan/${projectId}/${id}/terraform`;
  const workspace = join(root, workspaceRef);
  await mkdir(workspace, { recursive: true });
  const plan = `fixture-plan-${revision}`;
  await writeFile(join(workspace, "tfplan"), plan);
  const planHash = createHash("sha256").update(plan).digest("hex");
  return dataSource.getRepository(InfrastructureManifest).save({
    id, schemaVersion: 1, projectId, environmentName: "dev", revision, parentManifestId: null, createdByIntentId: null, createdByUserId: null,
    origin: "planner", status: "planned", specHash: canonicalSha256(desiredSpec), terraformTemplateVersion: "v1", stateBackend: "local_mock",
    stateKey: `projects/${projectId}/dev/v1/${revision}.tfstate`, stateVersionId: null, desiredSpec,
    changeSet: { fromManifestId: null, changedPaths: [], categories: [], destructivePaths: [], requiresApproval: true, reasonCodes: ["CANARY_PLAN_ONLY"] }, requiresTerraform: true,
    planArtifactSha256: planHash, planInputFingerprint: "b".repeat(64), planConfigurationFingerprint: null,
    planArtifactReference: { schemaVersion: 1, phase: "planned", workspaceRef, stateKey: `projects/${projectId}/dev/v1/${revision}.tfstate`, inputFingerprint: "b".repeat(64), artifactSha256: planHash, baselineImageReferenceHash: canonicalSha256({ image }), planSummary: { create: 8, update: 0, replace: 0, delete: 0, noOp: 0, resourceTypes: ["aws_ecr_repository"] } },
    terraformOutputs: null, terraformOutputsHash: null, resourceCount: null, failureCode: null, failureMessage: null, plannedAt: new Date(), approvedAt: null, applyStartedAt: null, appliedAt: null, supersededAt: null, destroyedAt: null,
  });
}

function config(real = true) {
  const values: Record<string, string> = { TERRAFORM_WORKING_BASE_DIR: root, INFRACOST_ENABLED: real ? "true" : "false", FINOPS_MOCK_MODE: real ? "false" : "true", COST_GATE_MODE: "enforce", INFRACOST_CURRENCY: "USD" };
  return { get: <T>(key: string, fallback?: T): T => (values[key] ?? fallback) as T } as ConfigService;
}

async function main() {
  await admin.initialize(); await admin.query(`CREATE SCHEMA "${schema}"`); root = await mkdtemp(join(tmpdir(), "deployguard-v1-review-"));
  try {
    await dataSource.initialize(); await setup(); await dataSource.query(`INSERT INTO projects (id) VALUES ($1)`, [projectId]);
    await dataSource.query(`INSERT INTO project_stage_checkpoints (id, project_id, pipeline_run_id, stage, status, image_digest, artifact_reference) VALUES ($1, $2, $3, 'ecr_push', 'passed', $4, $5::jsonb)`, [checkpointId, projectId, "44444444-4444-4444-8444-444444444444", digest, JSON.stringify({ ecrImageUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-canary:fixture" })]);
    const terraform = { runTerraformShowJson: async () => ({ stdout: "{}", stderr: "" }) };
    let breakdowns = 0;
    const infracost = { runInfracostBreakdown: async () => { breakdowns += 1; return "{}"; }, parseInfracostResponse: () => ({}), normalizeCostBreakdown: () => [{ resourceType: "load_balancer", resourceName: "hidden", monthlyCost: 18.75 }] };
    const manifest = await plannedManifest();
    const service = new V1InfrastructurePlanReviewService(dataSource, config(true), terraform as never, infracost as never);
    const reviewed = await service.review(manifest.id, { kind: "checkpoint", immutableImage: image, checkpointId });
    assert.equal(reviewed.approvalReady, true);
    assert.equal(reviewed.costEstimate.state, "real");
    assert.equal(reviewed.costEstimate.monthlyCost, 18.75);
    assert.equal(breakdowns, 1);
    const persisted = await dataSource.getRepository(InfrastructureManifest).findOneByOrFail({ id: manifest.id });
    assert.doesNotMatch(JSON.stringify(persisted.planArtifactReference?.review), /deployguard-canary|sha256:/);
    const replay = await service.review(manifest.id, { kind: "checkpoint", immutableImage: image, checkpointId });
    assert.equal(replay.approvalReady, true); assert.equal(breakdowns, 1);
    const invalid = await service.review(manifest.id, { kind: "checkpoint", immutableImage: image.replace(/@sha256:.+$/, ":mutable"), checkpointId });
    assert.equal(invalid.safeCodes.includes("BASELINE_IMAGE_PROVENANCE_INVALID"), true);
    const unavailableManifest = await plannedManifest("55555555-5555-4555-8555-555555555555", "2");
    const unavailable = await new V1InfrastructurePlanReviewService(dataSource, config(false), terraform as never, infracost as never).review(unavailableManifest.id, { kind: "checkpoint", immutableImage: image, checkpointId });
    assert.equal(unavailable.costEstimate.state, "unavailable");
    const operatorManifest = await plannedManifest("77777777-7777-4777-8777-777777777777", "4");
    const operator = await service.review(operatorManifest.id, { kind: "operator_frozen", immutableImage: image, contractId: "88888888-8888-4888-8888-888888888888", evidenceSha256: "c".repeat(64), attestedAt: "2026-07-25T00:00:00.000Z" });
    assert.equal(operator.approvalReady, true);
    await writeFile(join(root, `v1-plan/${projectId}/${manifest.id}/terraform`, "tfplan"), "changed");
    const mismatchManifest = await plannedManifest("66666666-6666-4666-8666-666666666666", "3");
    await writeFile(join(root, `v1-plan/${projectId}/${mismatchManifest.id}/terraform`, "tfplan"), "changed");
    const mismatch = await service.review(mismatchManifest.id, { kind: "checkpoint", immutableImage: image, checkpointId });
    assert.equal(mismatch.safeCodes.includes("PLAN_ARTIFACT_HASH_MISMATCH"), true);
    console.log("v1 infrastructure plan review PostgreSQL verification passed");
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.destroy(); if (root) await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "verification failed"); process.exitCode = 1; });
