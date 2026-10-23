import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { InfrastructureSpecV1 } from "../src/orchestration-contracts/contracts/infrastructure-manifest.types";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { V1InfrastructureManifestPlanService } from "../src/orchestration-contracts/infrastructure/v1-infrastructure-manifest-plan.service";
import { CreateTwoLaneManifestsAndStateRevisions1760000034000 } from "../src/migrations/1760000034000-CreateTwoLaneManifestsAndStateRevisions";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `v1_infra_plan_${suffix}`;
const projectId = "11111111-1111-4111-8111-111111111111";
const manifestId = "22222222-2222-4222-8222-222222222222";
const template = join(process.cwd(), "terraform", "base-network");
let workspaceRoot = "";

const baseOptions = AppDataSource.options as DataSourceOptions & { extra?: Record<string, unknown> };
const admin = new DataSource({ ...baseOptions, entities: [], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
const dataSource = new DataSource({
  ...baseOptions,
  schema,
  entities: [InfrastructureManifest],
  migrations: [],
  synchronize: false,
  logging: false,
  extra: { ...(baseOptions.extra || {}), options: `-c search_path=${schema},public` },
} as DataSourceOptions);

const spec = (): InfrastructureSpecV1 => ({
  region: "us-east-1",
  terraformTemplateVersion: "v1",
  network: { topology: "managed_vpc", availabilityZoneCount: 2, publicSubnets: true, privateSubnets: true, natMode: "none" },
  registry: { managedEcrRepository: true, immutableTags: true, lifecyclePolicyHash: null },
  ecsFoundation: { clusterMode: "shared_project", serviceName: "deployguard-canary", launchType: "fargate", capacityProviders: ["FARGATE"] },
  ingress: { enabled: true, protocol: "HTTP", containerPort: 8080, targetGroupPort: 8080, healthCheckPath: "/", healthCheckProtocol: "HTTP" },
  database: { mode: "none", engine: null, tierRevision: null, persistence: false, externalTlsRequired: null },
  storage: { efsRequired: false, accessPointRequired: false, encrypted: true, backupRequired: false },
  discovery: { cloudMapRequired: false, namespace: null },
  observability: { cloudWatchLogs: true, cloudWatchMetrics: true, prometheus: false },
  iamPolicyRevision: "v1",
  tags: { Environment: "dev", ManagedBy: "DeployGuard", ProjectId: projectId },
});

async function createLegacyShape() {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query(`CREATE TABLE users (id integer PRIMARY KEY)`);
    await runner.query(`CREATE TABLE projects (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE project_pipeline_runs (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE project_deployment_contracts (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE project_configuration_snapshots (id uuid PRIMARY KEY)`);
    await new CreateTwoLaneManifestsAndStateRevisions1760000034000().up(runner);
  } finally {
    await runner.release();
  }
}

async function seed(id: string, revision: string, backend: "local_mock" | "s3" = "local_mock") {
  const desiredSpec = spec();
  if (revision === "4") {
    desiredSpec.ingress.containerPort = 8081;
    desiredSpec.ingress.targetGroupPort = 8081;
  }
  return dataSource.getRepository(InfrastructureManifest).save({
    id,
    schemaVersion: 1,
    projectId,
    environmentName: "dev",
    revision,
    parentManifestId: null,
    createdByIntentId: null,
    createdByUserId: null,
    origin: "planner",
    status: "desired",
    specHash: canonicalSha256(desiredSpec),
    terraformTemplateVersion: "v1",
    stateBackend: backend,
    stateKey: `projects/${projectId}/dev/v1/${revision}.tfstate`,
    stateVersionId: null,
    desiredSpec,
    changeSet: {
      fromManifestId: null,
      changedPaths: [],
      categories: [],
      destructivePaths: [],
      requiresApproval: true,
      reasonCodes: ["CANARY_PLAN_ONLY"],
    },
    requiresTerraform: true,
    planArtifactReference: null,
    planArtifactSha256: null,
    planInputFingerprint: null,
    planConfigurationFingerprint: null,
    terraformOutputs: null,
    terraformOutputsHash: null,
    resourceCount: null,
    failureCode: null,
    failureMessage: null,
    plannedAt: null,
    approvedAt: null,
    applyStartedAt: null,
    appliedAt: null,
    supersededAt: null,
    destroyedAt: null,
  });
}

async function main() {
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  workspaceRoot = await mkdtemp(join(tmpdir(), "deployguard-v1-plan-"));
  try {
    await dataSource.initialize();
    await createLegacyShape();
    await dataSource.query(`INSERT INTO projects (id) VALUES ($1)`, [projectId]);

    let plans = 0;
    let failPlan = false;
    const runner = {
      runTerraformInit: async () => ({ stdout: "", stderr: "" }),
      runTerraformValidate: async () => ({ stdout: "", stderr: "" }),
      runTerraformPlan: async (workspace: string) => {
        plans += 1;
        if (failPlan) throw new Error("fixture failure");
        await writeFile(join(workspace, "tfplan"), `fixture-plan-${plans}`);
        return { stdout: "", stderr: "" };
      },
      runTerraformShowJson: async () => ({ stdout: JSON.stringify({ resource_changes: [{ type: "aws_ecr_repository", change: { actions: ["create"] } }] }), stderr: "" }),
    };
    const values: Record<string, string> = {
      TERRAFORM_WORKING_BASE_DIR: workspaceRoot,
      TERRAFORM_NETWORK_TEMPLATE_DIR: template,
      TWO_LANE_CANARY_PLAN_AVAILABILITY_ZONES: "us-east-1a,us-east-1b",
      TWO_LANE_CANARY_PLAN_PUBLIC_SUBNET_CIDRS: "10.254.1.0/24,10.254.2.0/24",
      TWO_LANE_CANARY_PLAN_PRIVATE_SUBNET_CIDRS: "10.254.101.0/24,10.254.102.0/24",
      TWO_LANE_CANARY_PLAN_VPC_CIDR: "10.254.0.0/16",
    };
    const config = { get: <T>(key: string, fallback?: T): T => (values[key] ?? fallback) as T } as ConfigService;
    const service = new V1InfrastructureManifestPlanService(dataSource, config, runner as never);

    await seed(manifestId, "1");
    const [first, duplicate] = await Promise.all([service.plan(manifestId), service.plan(manifestId)]);
    assert.equal(plans, 1, "concurrent planning must execute Terraform once");
    assert.equal([first.state, duplicate.state].includes("planned"), true);
    const persisted = await dataSource.getRepository(InfrastructureManifest).findOneByOrFail({ id: manifestId });
    assert.equal(persisted.status, "planned");
    assert.equal(persisted.appliedAt, null);
    assert.equal(Boolean(persisted.planArtifactSha256), true);
    assert.equal(first.destroyInstruction?.stateKey, persisted.stateKey);
    assert.equal((await dataSource.query(`SELECT count(*)::integer AS count FROM release_manifests`))[0].count, 0);
    const tfvars = await readFile(join(workspaceRoot, "v1-plan", projectId, manifestId, "terraform", "terraform.tfvars.json"), "utf8");
    assert.match(tfvars, /deployguard:infrastructure-manifest-id/);
    assert.equal(JSON.parse(tfvars).offline_plan_mode, true, "isolated local plans retain offline provider mode");
    assert.doesNotMatch(tfvars, /release-manifest|release_revision/i);

    const replay = await service.plan(manifestId);
    assert.equal(replay.replayed, true);
    assert.equal(plans, 1);

    const changed = await seed("55555555-5555-4555-8555-555555555555", "4");
    const changedResult = await service.plan(changed.id);
    assert.equal(changedResult.state, "planned");
    assert.equal(plans, 2, "a changed manifest revision needs a distinct plan execution");
    assert.notEqual(changedResult.workspaceRef, first.workspaceRef);
    assert.notEqual(changedResult.destroyInstruction?.stateKey, first.destroyInstruction?.stateKey);

    const remote = await seed("33333333-3333-4333-8333-333333333333", "2", "s3");
    const remoteResult = await service.plan(remote.id);
    assert.equal(remoteResult.safeCode, "REMOTE_CANARY_PLAN_NOT_ALLOWED");
    assert.equal((await dataSource.getRepository(InfrastructureManifest).findOneByOrFail({ id: remote.id })).status, "failed");
    assert.equal(plans, 2);

    failPlan = true;
    const failed = await seed("44444444-4444-4444-8444-444444444444", "3");
    const failure = await service.plan(failed.id);
    assert.equal(failure.state, "failed");
    assert.equal((await dataSource.getRepository(InfrastructureManifest).findOneByOrFail({ id: failed.id })).status, "failed");
    assert.equal((await dataSource.getRepository(InfrastructureManifest).findOneByOrFail({ id: failed.id })).appliedAt, null);
    console.log("v1 infrastructure manifest plan PostgreSQL verification passed");
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.destroy();
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "verification failed");
  process.exitCode = 1;
});
