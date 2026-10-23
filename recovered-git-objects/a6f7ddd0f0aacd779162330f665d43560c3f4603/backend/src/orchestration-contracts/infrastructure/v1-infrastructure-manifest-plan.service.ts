import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
import { DataSource, EntityManager } from "typeorm";
import { TerraformRunnerService } from "../../infrastructure/terraform-runner.service";
import { canonicalSha256 } from "../contracts/canonical-json";
import { assertNoSecretMaterial, validateInfrastructureManifestCreate } from "../contracts/manifest.validator";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_IMAGE = /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;
const CIDR = /^([0-9]{1,3}\.){3}[0-9]{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/;
const AZ = /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*[a-z]$/;

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
      await this.prepareWorkspace(prepared.workspace, prepared.variables);
      const offlineEnvironment = {
        AWS_ACCESS_KEY_ID: "offline-plan",
        AWS_SECRET_ACCESS_KEY: "offline-plan",
        AWS_SESSION_TOKEN: "",
      };
      await this.terraform.runTerraformInit(prepared.workspace, offlineEnvironment, { mode: "local" });
      await this.terraform.runTerraformValidate(prepared.workspace, offlineEnvironment);
      await this.terraform.runTerraformPlan(prepared.workspace, offlineEnvironment);
      const show = await this.terraform.runTerraformShowJson(prepared.workspace, offlineEnvironment);
      const artifactSha256 = createHash("sha256").update(await readFile(join(prepared.workspace, "tfplan"))).digest("hex");
      const planSummary = this.planSummary(show.stdout);
      return this.persistPlanned(prepared, artifactSha256, planSummary);
    } catch {
      return this.persistFailed(prepared, "TERRAFORM_PLAN_FAILED");
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
    if (manifest.stateBackend !== "local_mock") {
      manifest.status = "failed";
      manifest.failureCode = "REMOTE_STATE_PLAN_NOT_ALLOWED";
      manifest.failureMessage = "Plan-only canary planning requires isolated local state.";
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
        baselineImageReferenceHash: canonicalSha256({ image: String(variables.ecs_baseline_container_image || "") }),
    };
    manifest.planInputFingerprint = inputFingerprint;
    await manifests.save(manifest);
    return { kind: "execute", manifest, workspace: this.workspacePath(manifest), workspaceRef, variables, inputFingerprint };
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
        baselineImageReferenceHash: canonicalSha256({ image: String(prepared.variables.ecs_baseline_container_image || "") }),
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

  private async prepareWorkspace(workspace: string, variables: Record<string, unknown>) {
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
    await writeFile(versionsPath, versions.replace(/backend\s+"(?:s3|local)"\s*\{[^}]*\}/m, 'backend "local" {\n    path = "terraform.tfstate"\n  }'), "utf8");
    await writeFile(join(workspace, ".deployguard-backend-mode.json"), JSON.stringify({ mode: "local", version: 1 }), "utf8");
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
    const baselineImage = this.required("TWO_LANE_CANARY_PLAN_BASELINE_IMAGE", SHA256_IMAGE);
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
      offline_plan_mode: true,
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
      enable_ecs_foundation_service: foundationService,
      ecs_baseline_container_image: baselineImage,
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

  private workspaceRoot() {
    return resolve(process.cwd(), this.config.get<string>("TERRAFORM_WORKING_BASE_DIR", "./.deployguard/terraform-workspaces"));
  }

  private workspaceRef(manifest: InfrastructureManifest) {
    return `v1-plan/${manifest.projectId}/${manifest.id}/terraform`;
  }

  private workspacePath(manifest: InfrastructureManifest) {
    return join(this.workspaceRoot(), "v1-plan", manifest.projectId, manifest.id, "terraform");
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
