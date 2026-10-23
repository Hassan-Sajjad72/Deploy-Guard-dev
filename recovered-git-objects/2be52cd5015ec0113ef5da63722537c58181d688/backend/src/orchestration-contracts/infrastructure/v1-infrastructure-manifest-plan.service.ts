import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
import { promisify } from "node:util";
import { DataSource, EntityManager } from "typeorm";
import { TerraformRunnerService } from "../../infrastructure/terraform-runner.service";
import { canonicalSha256 } from "../contracts/canonical-json";
import { assertNoSecretMaterial, validateInfrastructureManifestCreate } from "../contracts/manifest.validator";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CIDR = /^([0-9]{1,3}\.){3}[0-9]{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/;
const AZ = /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*[a-z]$/;
const AWS_ACCOUNT = /^\d{12}$/;
const execFileAsync = promisify(execFile);
const EXPECTED_FOUNDATION_TYPES = [
  "aws_cloudwatch_log_group", "aws_ecr_lifecycle_policy", "aws_ecr_repository",
  "aws_ecs_cluster", "aws_iam_role", "aws_iam_role_policy_attachment",
  "aws_internet_gateway", "aws_lb", "aws_lb_listener", "aws_lb_target_group",
  "aws_route_table", "aws_route_table_association", "aws_security_group",
  "aws_subnet", "aws_vpc",
];

class RemotePlanPreflightError extends Error {
  constructor(readonly safeCode: string) {
    super(safeCode);
  }
}

export type V1InfrastructurePlanResult = Readonly<{
  state: "planned" | "planning" | "failed";
  manifestId: string;
  revision: string;
  replayed: boolean;
  safeCode: string | null;
  planSummary: Readonly<{ create: number; update: number; replace: number; delete: number; noOp: number; resourceTypes: string[] }> | null;
  workspaceRef: string | null;
  stateKey: string;
  destroyInstruction: Readonly<{ stateKey: string; workspaceRef: string; command: string; sharedStateBucketExcluded: true }> | null;
}>;

type PreparedPlan = {
  kind: "execute";
  manifest: InfrastructureManifest;
  workspace: string;
  workspaceRef: string;
  variables: Record<string, unknown>;
  inputFingerprint: string;
  backendMode: "local" | "s3";
} | {
  kind: "replay" | "planning" | "failed";
  result: V1InfrastructurePlanResult;
};

/**
 * Explicit, default-off infrastructure-manifest planner. It is not a worker,
 * endpoint, queue publisher, or Terraform apply path.
 */
@Injectable()
export class V1InfrastructureManifestPlanService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly terraform: TerraformRunnerService,
  ) {}

  async plan(manifestId: string): Promise<V1InfrastructurePlanResult> {
    if (!UUID.test(manifestId)) throw new Error("Invalid infrastructure manifest identifier.");
    const prepared = await this.withSerializableRetry(() => this.dataSource.transaction("SERIALIZABLE", (manager) => this.prepare(manager, manifestId)));
    if (prepared.kind !== "execute") return prepared.result;

    try {
      if (prepared.backendMode === "s3") await this.verifyRemotePlanScope(prepared.manifest);
      await this.prepareWorkspace(prepared.workspace, prepared.variables, prepared.manifest, prepared.backendMode);
      const offlineEnvironment = prepared.backendMode === "local" ? {
        AWS_ACCESS_KEY_ID: "offline-plan",
        AWS_SECRET_ACCESS_KEY: "offline-plan",
        AWS_SESSION_TOKEN: "",
      } : {};
      await this.terraform.runTerraformInit(prepared.workspace, offlineEnvironment, prepared.backendMode === "local" ? { mode: "local" } : { mode: "s3", configPath: join(prepared.workspace, "backend.hcl") });
      await this.terraform.runTerraformValidate(prepared.workspace, offlineEnvironment);
      await this.terraform.runTerraformPlan(prepared.workspace, offlineEnvironment);
      const show = await this.terraform.runTerraformShowJson(prepared.workspace, offlineEnvironment);
      const artifactSha256 = createHash("sha256").update(await readFile(join(prepared.workspace, "tfplan"))).digest("hex");
      const planSummary = this.planSummary(show.stdout);
      this.assertRemoteFoundationPlan(show.stdout, prepared.backendMode);
      return this.persistPlanned(prepared, artifactSha256, planSummary);
    } catch (error) {
      return this.persistFailed(prepared, error instanceof RemotePlanPreflightError ? error.safeCode : "TERRAFORM_PLAN_FAILED");
    }
  }

  private async prepare(manager: EntityManager, manifestId: string): Promise<PreparedPlan> {
    const manifests = manager.getRepository(InfrastructureManifest);
    const rows = await manager.query(
      `SELECT id FROM infrastructure_manifests WHERE id = $1 FOR UPDATE`,
      [manifestId],
    ) as Array<{ id: string }>;
    if (!rows.length) throw new Error("Infrastructure manifest not found.");
    const manifest = await manifests.findOneByOrFail({ id: manifestId });
    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`deployguard:v1-infrastructure-plan:${manifest.projectId}:${manifest.environmentName}:${manifest.revision}`],
    );
    this.validateManifest(manifest);

    const workspaceRef = this.workspaceRef(manifest);
    if (manifest.status === "planned" && manifest.planArtifactSha256 && manifest.planArtifactReference) {
      return {
        kind: "replay",
        result: this.result(manifest, "planned", true, null, this.summaryFromReference(manifest.planArtifactReference), workspaceRef),
      };
    }
    if (manifest.status === "planning") {
      return { kind: "planning", result: this.result(manifest, "planning", true, "PLAN_ALREADY_IN_PROGRESS", null, workspaceRef) };
    }
    if (!["desired", "failed"].includes(manifest.status)) {
      throw new Error("Infrastructure manifest is not eligible for planning.");
    }
    const backendMode = manifest.stateBackend === "local_mock" ? "local" : "s3";
    if (backendMode === "s3" && !this.remoteCanaryAllowed(manifest)) {
      manifest.status = "failed";
      manifest.failureCode = "REMOTE_CANARY_PLAN_NOT_ALLOWED";
      manifest.failureMessage = "Remote canary planning is disabled or outside its exact project/dev scope.";
      await manifests.save(manifest);
      return { kind: "failed", result: this.result(manifest, "failed", false, manifest.failureCode, null, workspaceRef) };
    }

    let variables: Record<string, unknown>;
    try {
      variables = this.variables(manifest);
    } catch {
      manifest.status = "failed";
      manifest.failureCode = "CANARY_PLAN_CONFIGURATION_INVALID";
      manifest.failureMessage = "Plan-only canary configuration is incomplete or invalid.";
      await manifests.save(manifest);
      return { kind: "failed", result: this.result(manifest, "failed", false, manifest.failureCode, null, workspaceRef) };
    }
    const inputFingerprint = canonicalSha256({
      manifestId: manifest.id,
      revision: manifest.revision,
      specHash: manifest.specHash,
      stateKey: manifest.stateKey,
      variables,
    });
    manifest.status = "planning";
    manifest.failureCode = null;
    manifest.failureMessage = null;
      manifest.planArtifactReference = {
        schemaVersion: 1,
        phase: "planning",
        workspaceRef,
        stateKey: manifest.stateKey,
        inputFingerprint,
    };
    manifest.planInputFingerprint = inputFingerprint;
    await manifests.save(manifest);
    return { kind: "execute", manifest, workspace: this.workspacePath(manifest), workspaceRef, variables, inputFingerprint, backendMode };
  }

  private async persistPlanned(
    prepared: Extract<PreparedPlan, { kind: "execute" }>,
    artifactSha256: string,
    planSummary: V1InfrastructurePlanResult["planSummary"],
  ) {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const manifests = manager.getRepository(InfrastructureManifest);
      const manifest = await manifests.findOneByOrFail({ id: prepared.manifest.id });
      if (manifest.status === "planned" && manifest.planArtifactSha256 === artifactSha256) {
        return this.result(manifest, "planned", true, null, this.summaryFromReference(manifest.planArtifactReference), prepared.workspaceRef);
      }
      if (manifest.status !== "planning" || manifest.planInputFingerprint !== prepared.inputFingerprint) {
        throw new Error("Infrastructure manifest planning ownership was lost.");
      }
      manifest.status = "planned";
      manifest.planArtifactSha256 = artifactSha256;
      manifest.planInputFingerprint = prepared.inputFingerprint;
      manifest.planArtifactReference = {
        schemaVersion: 1,
        phase: "planned",
        workspaceRef: prepared.workspaceRef,
        stateKey: manifest.stateKey,
        inputFingerprint: prepared.inputFingerprint,
        artifactSha256,
        planSummary,
        offlinePlanMode: prepared.backendMode === "local",
        providerMode: prepared.backendMode === "local" ? "offline_mock" : "real_aws",
      };
      manifest.plannedAt = new Date();
      manifest.failureCode = null;
      manifest.failureMessage = null;
      await manifests.save(manifest);
      return this.result(manifest, "planned", false, null, planSummary, prepared.workspaceRef);
    });
  }

  private async persistFailed(prepared: Extract<PreparedPlan, { kind: "execute" }>, code: string) {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const manifests = manager.getRepository(InfrastructureManifest);
      const manifest = await manifests.findOneByOrFail({ id: prepared.manifest.id });
      if (manifest.status === "planned") return this.result(manifest, "planned", true, null, this.summaryFromReference(manifest.planArtifactReference), prepared.workspaceRef);
      if (manifest.status === "planning" && manifest.planInputFingerprint === prepared.inputFingerprint) {
        manifest.status = "failed";
        manifest.failureCode = code;
        manifest.failureMessage = "Terraform plan did not complete. No infrastructure was applied.";
        manifest.planArtifactReference = {
          schemaVersion: 1,
          phase: "failed",
          workspaceRef: prepared.workspaceRef,
          stateKey: manifest.stateKey,
          inputFingerprint: prepared.inputFingerprint,
        };
        await manifests.save(manifest);
      }
      return this.result(manifest, "failed", false, manifest.failureCode || code, null, prepared.workspaceRef);
    });
  }

  private async prepareWorkspace(workspace: string, variables: Record<string, unknown>, manifest: InfrastructureManifest, backendMode: "local" | "s3") {
    const root = this.workspaceRoot();
    await mkdir(root, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await this.assertWorkspace(workspace, root);
    const template = resolve(process.cwd(), this.config.get<string>("TERRAFORM_NETWORK_TEMPLATE_DIR", "terraform/base-network"));
    await cp(template, workspace, { recursive: true, force: true });
    await cp(resolve(template, "..", "modules"), join(workspace, "..", "modules"), { recursive: true, force: true });
    await rm(join(workspace, ".terraform"), { recursive: true, force: true });
    await rm(join(workspace, "terraform.tfstate"), { force: true });
    await rm(join(workspace, "terraform.tfstate.backup"), { force: true });
    await rm(join(workspace, "tfplan"), { force: true });
    const versionsPath = join(workspace, "versions.tf");
    const versions = await readFile(versionsPath, "utf8");
    if (backendMode === "local") {
      await writeFile(versionsPath, versions.replace(/backend\s+"(?:s3|local)"\s*\{[^}]*\}/m, 'backend "local" {\n    path = "terraform.tfstate"\n  }'), "utf8");
    } else {
      await writeFile(join(workspace, "backend.hcl"), [
        `bucket = "${this.config.get<string>("TERRAFORM_STATE_BUCKET", "").trim()}"`,
        `key = "${manifest.stateKey}"`,
        `region = "${this.config.get<string>("TERRAFORM_STATE_REGION", "").trim()}"`,
        "encrypt = true",
        "use_lockfile = true",
      ].join("\n"), { encoding: "utf8", mode: 0o600 });
    }
    await writeFile(join(workspace, ".deployguard-backend-mode.json"), JSON.stringify({ mode: backendMode, version: 1 }), "utf8");
    await writeFile(join(workspace, "terraform.tfvars.json"), JSON.stringify(variables, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  private variables(manifest: InfrastructureManifest): Record<string, unknown> {
    const spec = manifest.desiredSpec;
    if (!spec.registry.managedEcrRepository || !spec.registry.immutableTags) {
      throw new Error("Plan-only canary foundations require a managed immutable ECR repository.");
    }
    if (!spec.ingress.enabled || spec.database.mode !== "none" || spec.storage.efsRequired || spec.discovery.cloudMapRequired) {
      throw new Error("The plan-only canary supports only the minimum stateless ECS foundation.");
    }
    const zones = this.csv("TWO_LANE_CANARY_PLAN_AVAILABILITY_ZONES", 2, AZ);
    const publicSubnets = this.csv("TWO_LANE_CANARY_PLAN_PUBLIC_SUBNET_CIDRS", 2, CIDR);
    const privateSubnets = this.csv("TWO_LANE_CANARY_PLAN_PRIVATE_SUBNET_CIDRS", 2, CIDR);
    const vpcCidr = this.required("TWO_LANE_CANARY_PLAN_VPC_CIDR", CIDR);
    const repositoryName = `deployguard-canary-${manifest.projectId.replace(/-/g, "").slice(0, 20)}`;
    const tags = {
      Project: "DeployGuard",
      ManagedBy: "DeployGuard",
      ProjectId: manifest.projectId,
      Environment: manifest.environmentName,
      "deployguard:project-id": manifest.projectId,
      "deployguard:environment": manifest.environmentName,
      "deployguard:infrastructure-manifest-id": manifest.id,
      "deployguard:infrastructure-revision": manifest.revision,
      "deployguard:infrastructure-input-hash": manifest.specHash,
    };
    const publicEgress = spec.network.natMode === "none";
    const foundationService = Boolean(spec.ingress.enabled);
    const vars = {
      project_id: manifest.projectId,
      project_name: `canary-${manifest.projectId.slice(0, 8)}`,
      environment_name: manifest.environmentName,
      aws_region: spec.region,
      offline_plan_mode: manifest.stateBackend === "local_mock",
      availability_zone_names: zones,
      vpc_cidr: vpcCidr,
      public_subnet_cidrs: publicSubnets,
      private_subnet_cidrs: privateSubnets,
      nat_mode: spec.network.natMode,
      single_nat_gateway: spec.network.natMode === "single",
      cloud_map_namespace: spec.discovery.namespace || `canary-${manifest.id.slice(0, 8)}.deployguard.local`,
      enable_cloud_map: spec.discovery.cloudMapRequired,
      enable_https: spec.ingress.protocol === "HTTPS",
      app_port: spec.ingress.containerPort,
      tags,
      manage_ecr_repository: true,
      ecr_repository_name: repositoryName,
      ecr_image_tag_mutability: spec.registry.immutableTags ? "IMMUTABLE" : "MUTABLE",
      enable_efs: false,
      enable_efs_backup: false,
      enable_ecs_service: false,
      enable_ecs_foundation: foundationService,
      ecs_egress_strategy: publicEgress ? "public_ip" : "nat",
      ecs_container_name: "canary-foundation",
      ecs_task_cpu: 256,
      ecs_task_memory: 512,
      database_service: {
        enabled: false,
        engine: "postgres",
        image: "postgres:16",
        port: 5432,
        cpu: 512,
        memory: 1024,
        database_name: "",
        database_user: "",
        efs_enabled: false,
        efs_mount_path: "/var/lib/postgresql/data",
        cloud_map_name: "db",
        persistence_enabled: false,
        backup_enabled: false,
      },
      ecs_use_fargate_spot: false,
      ecs_enable_fargate_fallback: false,
      ecs_desired_count: 0,
      ecs_min_tasks: 0,
      ecs_max_tasks: 0,
      ecs_cpu_target_percent: 60,
      ecs_healthcheck_grace_seconds: 60,
      ecs_container_insights: false,
      ecs_enable_autoscaling: false,
      alb_health_check_path: spec.ingress.healthCheckPath,
      enable_eventbridge_spot_rule: false,
    };
    assertNoSecretMaterial(manifest.desiredSpec, "v1InfrastructurePlan.desiredSpec");
    return vars;
  }

  private validateManifest(manifest: InfrastructureManifest) {
    validateInfrastructureManifestCreate({
      schemaVersion: manifest.schemaVersion,
      projectId: manifest.projectId,
      environmentName: manifest.environmentName,
      parentManifestId: manifest.parentManifestId,
      createdByUserId: manifest.createdByUserId,
      origin: manifest.origin,
      terraformTemplateVersion: manifest.terraformTemplateVersion,
      stateBackend: manifest.stateBackend,
      stateKey: manifest.stateKey,
      desiredSpec: manifest.desiredSpec,
      changeSet: manifest.changeSet,
      requiresTerraform: manifest.requiresTerraform,
      specHash: manifest.specHash,
    });
  }

  private result(
    manifest: InfrastructureManifest,
    state: V1InfrastructurePlanResult["state"],
    replayed: boolean,
    safeCode: string | null,
    planSummary: V1InfrastructurePlanResult["planSummary"],
    workspaceRef: string,
  ): V1InfrastructurePlanResult {
    return {
      state,
      manifestId: manifest.id,
      revision: manifest.revision,
      replayed,
      safeCode,
      planSummary,
      workspaceRef: state === "failed" && !manifest.planArtifactReference ? null : workspaceRef,
      stateKey: manifest.stateKey,
      destroyInstruction: state === "planned" ? {
        stateKey: manifest.stateKey,
        workspaceRef,
        command: `terraform -chdir=${workspaceRef} destroy -input=false -var-file=terraform.tfvars.json`,
        sharedStateBucketExcluded: true,
      } : null,
    };
  }

  private summaryFromReference(reference: Record<string, unknown> | null) {
    const summary = reference?.planSummary;
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
    const value = summary as Record<string, unknown>;
    const resourceTypes = Array.isArray(value.resourceTypes) ? value.resourceTypes.filter((item): item is string => typeof item === "string") : [];
    const number = (key: string) => typeof value[key] === "number" ? value[key] : 0;
    return { create: number("create"), update: number("update"), replace: number("replace"), delete: number("delete"), noOp: number("noOp"), resourceTypes };
  }

  private planSummary(raw: string) {
    const parsed = JSON.parse(raw || "{}") as { resource_changes?: Array<{ type?: string; change?: { actions?: string[] } }> };
    const result = { create: 0, update: 0, replace: 0, delete: 0, noOp: 0, resourceTypes: new Set<string>() };
    for (const change of parsed.resource_changes || []) {
      const actions = change.change?.actions || [];
      if (typeof change.type === "string") result.resourceTypes.add(change.type);
      if (actions.includes("create") && actions.includes("delete")) result.replace += 1;
      else if (actions.includes("create")) result.create += 1;
      else if (actions.includes("update")) result.update += 1;
      else if (actions.includes("delete")) result.delete += 1;
      else result.noOp += 1;
    }
    return { ...result, resourceTypes: [...result.resourceTypes].sort() };
  }

  private assertRemoteFoundationPlan(raw: string, backendMode: "local" | "s3") {
    if (backendMode !== "s3") return;
    let parsed: { variables?: Record<string, { value?: unknown }>; resource_changes?: Array<{ type?: string; mode?: string; change?: { actions?: string[] } }> };
    try { parsed = JSON.parse(raw || "{}"); } catch { throw new RemotePlanPreflightError("REMOTE_PLAN_SHOW_INVALID"); }
    if (parsed.variables?.offline_plan_mode?.value !== false) throw new RemotePlanPreflightError("REMOTE_PLAN_OFFLINE_PROVIDER_MODE_INVALID");
    let create = 0; let update = 0; let replace = 0; let remove = 0;
    const types = new Set<string>();
    for (const change of parsed.resource_changes || []) {
      const actions = change.change?.actions || [];
      if (change.mode !== "data" && change.type) types.add(change.type);
      if (actions.includes("create") && actions.includes("delete")) replace += 1;
      else if (actions.includes("create")) create += 1;
      else if (actions.includes("update")) update += 1;
      else if (actions.includes("delete")) remove += 1;
    }
    if (create !== 25 || update !== 0 || replace !== 0 || remove !== 0
      || types.has("aws_ecs_task_definition") || types.has("aws_ecs_service")
      || EXPECTED_FOUNDATION_TYPES.some((type) => !types.has(type))) {
      throw new RemotePlanPreflightError("REMOTE_PLAN_TOPOLOGY_MISMATCH");
    }
  }

  private async verifyRemotePlanScope(manifest: InfrastructureManifest) {
    const bucket = this.config.get<string>("TERRAFORM_STATE_BUCKET", "").trim();
    const region = this.config.get<string>("TERRAFORM_STATE_REGION", "").trim();
    const expectedAccount = this.config.get<string>("TWO_LANE_CANARY_EXPECTED_AWS_ACCOUNT", "").trim();
    if (!bucket || !region || !AWS_ACCOUNT.test(expectedAccount)) throw new RemotePlanPreflightError("REMOTE_PLAN_ACCOUNT_CONFIGURATION_INVALID");
    const identity = await this.awsJson(["sts", "get-caller-identity", "--output", "json", "--region", region]);
    if (identity.Account !== expectedAccount) throw new RemotePlanPreflightError("REMOTE_PLAN_ACCOUNT_MISMATCH");
    await this.aws(["s3api", "head-bucket", "--bucket", bucket, "--region", region]);
    const versioning = await this.awsJson(["s3api", "get-bucket-versioning", "--bucket", bucket, "--region", region]);
    if (versioning.Status !== "Enabled") throw new RemotePlanPreflightError("REMOTE_PLAN_STATE_VERSIONING_REQUIRED");
    await this.aws(["s3api", "get-bucket-encryption", "--bucket", bucket, "--region", region]);
    const block = await this.awsJson(["s3api", "get-public-access-block", "--bucket", bucket, "--region", region]);
    const flags = (block.PublicAccessBlockConfiguration || {}) as Record<string, unknown>;
    if (!["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"].every((key) => flags[key] === true)) {
      throw new RemotePlanPreflightError("REMOTE_PLAN_STATE_PUBLIC_ACCESS_BLOCK_REQUIRED");
    }
    if (await this.objectExists(bucket, manifest.stateKey, region)) throw new RemotePlanPreflightError("REMOTE_PLAN_STATE_KEY_COLLISION");
    if (await this.objectExists(bucket, `${manifest.stateKey}.tflock`, region)) throw new RemotePlanPreflightError("REMOTE_PLAN_STATE_LOCK_ACTIVE");
  }

  private async aws(args: string[]) {
    try { await execFileAsync("aws", args, { timeout: 30_000, maxBuffer: 128 * 1024, env: process.env }); }
    catch { throw new RemotePlanPreflightError("REMOTE_PLAN_AWS_SCOPE_UNVERIFIED"); }
  }

  private async awsJson(args: string[]) {
    try {
      const { stdout } = await execFileAsync("aws", args, { timeout: 30_000, maxBuffer: 128 * 1024, env: process.env });
      return JSON.parse(stdout || "{}") as Record<string, unknown>;
    } catch { throw new RemotePlanPreflightError("REMOTE_PLAN_AWS_SCOPE_UNVERIFIED"); }
  }

  private async objectExists(bucket: string, key: string, region: string) {
    try {
      await execFileAsync("aws", ["s3api", "head-object", "--bucket", bucket, "--key", key, "--region", region], { timeout: 30_000, maxBuffer: 128 * 1024, env: process.env });
      return true;
    } catch { return false; }
  }

  private workspaceRoot() {
    return resolve(process.cwd(), this.config.get<string>("TERRAFORM_WORKING_BASE_DIR", "./.deployguard/terraform-workspaces"));
  }

  private workspaceRef(manifest: InfrastructureManifest) {
    return `${manifest.stateBackend === "s3" ? "v1-remote-plan" : "v1-plan"}/${manifest.projectId}/${manifest.id}/terraform`;
  }

  private workspacePath(manifest: InfrastructureManifest) {
    return join(this.workspaceRoot(), manifest.stateBackend === "s3" ? "v1-remote-plan" : "v1-plan", manifest.projectId, manifest.id, "terraform");
  }

  private remoteCanaryAllowed(manifest: InfrastructureManifest) {
    const enabled = (key: string) => this.config.get<string>(key, "").trim() === "true";
    const expectedStateKey = `projects/${manifest.projectId}/dev/v1/${manifest.revision}.tfstate`;
    return enabled("TWO_LANE_REMOTE_CANARY_PLAN_ENABLED")
      && enabled("TWO_LANE_CANARY_COST_DEFERRED_ACKNOWLEDGED")
      && this.config.get<string>("TWO_LANE_CANARY_COST_MODE", "") === "deferred_canary"
      && this.config.get<string>("TWO_LANE_CANARY_PROJECT_ID", "") === manifest.projectId
      && this.config.get<string>("TWO_LANE_CANARY_ENVIRONMENT", "") === "dev"
      && manifest.environmentName === "dev"
      && manifest.stateKey === expectedStateKey
      && this.config.get<string>("STATE_MOCK_MODE", "true") === "false"
      && enabled("TERRAFORM_STATE_USE_LOCKFILE")
      && Boolean(this.config.get<string>("TERRAFORM_STATE_BUCKET", "").trim())
      && Boolean(this.config.get<string>("TERRAFORM_STATE_REGION", "").trim());
  }

  private async assertWorkspace(workspace: string, root: string) {
    const realRoot = await realpath(root);
    const realWorkspace = await realpath(workspace);
    const fromRoot = relative(realRoot, realWorkspace);
    if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("Plan workspace escaped the configured root.");
  }

  private required(key: string, pattern: RegExp) {
    const value = this.config.get<string>(key, "").trim();
    if (!pattern.test(value)) throw new Error(`${key} is required for an isolated canary plan.`);
    return value;
  }

  private csv(key: string, minimum: number, pattern: RegExp) {
    const values = this.config.get<string>(key, "").split(",").map((value) => value.trim()).filter(Boolean);
    if (values.length < minimum || values.some((value) => !pattern.test(value))) {
      throw new Error(`${key} must contain at least ${minimum} valid values for an isolated canary plan.`);
    }
    return values;
  }

  private async withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const code = (error as { driverError?: { code?: string }; code?: string }).driverError?.code
          || (error as { code?: string }).code;
        if (code !== "40001" || attempt >= 2) throw error;
      }
    }
  }
}
