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
import {
  normalV1AllowsScope,
  normalV1IsShared,
} from "../release-lane/normal-v1-activation-policy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CIDR = /^([0-9]{1,3}\.){3}[0-9]{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/;
const AZ = /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*[a-z]$/;
const AWS_ACCOUNT = /^\d{12}$/;
const IAM_ROLE_ARN = /^arn:(aws[a-z-]*):iam::(\d{12}):role\/([A-Za-z0-9+=,.@_-]{1,64})$/;
const SECRET_ARN = /^arn:(aws[a-z-]*):secretsmanager:([a-z0-9-]+):(\d{12}):secret:[A-Za-z0-9/_+=.@-]+$/;
const execFileAsync = promisify(execFile);
const EXPECTED_FOUNDATION_TYPES = [
  "aws_cloudwatch_log_group", "aws_ecr_lifecycle_policy", "aws_ecr_repository",
  "aws_ecs_cluster", "aws_iam_role", "aws_iam_role_policy_attachment",
  "aws_internet_gateway", "aws_lb", "aws_lb_listener", "aws_lb_target_group",
  "aws_route_table", "aws_route_table_association", "aws_security_group",
  "aws_subnet", "aws_vpc",
];
const EXPECTED_MANAGED_DATABASE_TYPES = [
  "aws_backup_plan", "aws_backup_selection", "aws_backup_vault", "aws_cloudwatch_log_group",
  "aws_ecs_cluster", "aws_ecs_service", "aws_ecs_task_definition", "aws_efs_access_point",
  "aws_efs_file_system", "aws_efs_mount_target", "aws_iam_role", "aws_iam_role_policy",
  "aws_iam_role_policy_attachment", "aws_kms_key", "aws_secretsmanager_secret",
  "aws_secretsmanager_secret_version", "aws_security_group", "aws_service_discovery_service",
];
const DATABASE_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;
const DATABASE_USER = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;
const SECRET_REFERENCE = /^(?:terraform:\/\/database\/(?:password|url)|project_secret:[A-Z][A-Z0-9_]{0,127})$/;

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
  managedDatabase: ManagedDatabasePlanEvidence | null;
  secretAccess: SecretAccessPlanEvidence | null;
} | {
  kind: "replay" | "planning" | "failed";
  result: V1InfrastructurePlanResult;
};

type ManagedDatabasePlanEvidence = Readonly<{
  tierId: string;
  tierRevision: string;
  engine: "postgres";
  databaseName: string;
  databaseUser: string;
  internalHost: string;
  port: 5432;
  persistence: true;
  backupRequired: true;
  passwordSecretReference: "terraform://database/password";
  urlSecretReference: "terraform://database/url";
  applicationSecretReferences: string[];
  discoveryNamespace: string;
}>;

type PlannedVariables = Readonly<{
  variables: Record<string, unknown>;
  managedDatabase: ManagedDatabasePlanEvidence | null;
  secretAccess: SecretAccessPlanEvidence | null;
}>;

type SecretAccessPlanEvidence = Readonly<{
  boundary: "execution_role_exact_secret_read";
  executionRoleName: string;
  referenceCount: 3;
  referenceFingerprint: string;
  parentManifestId: string;
  parentOutputsHash: string;
}>;

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
      this.assertRemotePlan(show.stdout, prepared.backendMode, prepared.manifest, prepared.secretAccess);
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
    if (backendMode === "s3" && !this.remotePlanAllowed(manifest)) {
      manifest.status = "failed";
      manifest.failureCode = "REMOTE_CANARY_PLAN_NOT_ALLOWED";
      manifest.failureMessage = "Remote canary planning is disabled or outside its exact project/dev scope.";
      await manifests.save(manifest);
      return { kind: "failed", result: this.result(manifest, "failed", false, manifest.failureCode, null, workspaceRef) };
    }

    let planned: PlannedVariables;
    try {
      planned = await this.variables(manager, manifest);
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
      variables: planned.variables,
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
    return {
      kind: "execute", manifest, workspace: this.workspacePath(manifest), workspaceRef,
      variables: planned.variables, inputFingerprint, backendMode,
      managedDatabase: planned.managedDatabase, secretAccess: planned.secretAccess,
    };
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
        costPolicy: {
          state: "deferred",
          estimate: "unavailable",
          safeCode: "COST_ESTIMATE_DEFERRED",
        },
        managedDatabase: prepared.managedDatabase,
        secretAccess: prepared.secretAccess,
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
    const template = resolve(
      process.cwd(),
      this.isSecretAccessAddon(manifest)
        ? this.config.get<string>("TERRAFORM_IAM_SECRET_ACCESS_TEMPLATE_DIR", "terraform/iam-secret-access")
        : this.config.get<string>("TERRAFORM_NETWORK_TEMPLATE_DIR", "terraform/base-network"),
    );
    await cp(template, workspace, { recursive: true, force: true });
    if (!this.isSecretAccessAddon(manifest)) {
      await cp(resolve(template, "..", "modules"), join(workspace, "..", "modules"), { recursive: true, force: true });
    }
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

  private async variables(manager: EntityManager, manifest: InfrastructureManifest): Promise<PlannedVariables> {
    if (this.isSecretAccessAddon(manifest)) {
      return this.secretAccessVariables(manager, manifest);
    }
    const spec = manifest.desiredSpec;
    if (!spec.registry.managedEcrRepository || !spec.registry.immutableTags) {
      throw new Error("Plan-only canary foundations require a managed immutable ECR repository.");
    }
    if (!spec.ingress.enabled) {
      throw new Error("The plan-only canary supports only the minimum stateless ECS foundation.");
    }
    const managedDatabase = spec.database.mode === "managed"
      ? await this.managedDatabaseEvidence(manager, manifest)
      : null;
    if (spec.database.mode !== "none" && !managedDatabase) {
      throw new Error("The normal v1 foundation supports only a validated managed PostgreSQL database.");
    }
    if (spec.database.mode === "none" && (spec.storage.efsRequired || spec.discovery.cloudMapRequired)) {
      throw new Error("The stateless foundation cannot include storage or service discovery.");
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
    const publicEgress = managedDatabase ? false : spec.network.natMode === "none";
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
      cloud_map_namespace: managedDatabase?.discoveryNamespace || spec.discovery.namespace || `canary-${manifest.id.slice(0, 8)}.deployguard.local`,
      enable_cloud_map: Boolean(managedDatabase) || spec.discovery.cloudMapRequired,
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
      database_service: managedDatabase ? {
        enabled: true,
        engine: managedDatabase.engine,
        image: "postgres:16",
        port: managedDatabase.port,
        cpu: 512,
        memory: 1024,
        database_name: managedDatabase.databaseName,
        database_user: managedDatabase.databaseUser,
        efs_enabled: true,
        efs_mount_path: "/var/lib/postgresql/data",
        cloud_map_name: "db",
        persistence_enabled: managedDatabase.persistence,
        backup_enabled: managedDatabase.backupRequired,
      } : {
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
    return { variables: vars, managedDatabase, secretAccess: null };
  }

  private isSecretAccessAddon(manifest: InfrastructureManifest) {
    return Boolean(
      manifest.parentManifestId
      && manifest.changeSet.fromManifestId === manifest.parentManifestId
      && manifest.changeSet.changedPaths.length === 1
      && manifest.changeSet.changedPaths[0] === "iamPolicyRevision"
      && manifest.changeSet.categories.length === 1
      && manifest.changeSet.categories[0] === "iam"
      && manifest.changeSet.destructivePaths.length === 0,
    );
  }

  private async secretAccessVariables(
    manager: EntityManager,
    manifest: InfrastructureManifest,
  ): Promise<PlannedVariables> {
    if (!this.isSecretAccessAddon(manifest) || !manifest.parentManifestId) {
      throw new Error("Infrastructure IAM add-on boundary is invalid.");
    }
    const parent = await manager.getRepository(InfrastructureManifest).findOne({
      where: {
        id: manifest.parentManifestId,
        projectId: manifest.projectId,
        environmentName: manifest.environmentName,
        status: "applied",
      },
    });
    if (!parent?.terraformOutputs || !parent.terraformOutputsHash
      || canonicalSha256(parent.terraformOutputs) !== parent.terraformOutputsHash) {
      throw new Error("Applied infrastructure output evidence is invalid.");
    }
    const roleArn = parent.terraformOutputs.ecs_execution_role_arn;
    const roleMatch = typeof roleArn === "string" ? IAM_ROLE_ARN.exec(roleArn) : null;
    const account = this.expectedAwsAccount();
    if (!roleMatch || roleMatch[2] !== account || parent.desiredSpec.region !== manifest.desiredSpec.region
      || parent.desiredSpec.iamPolicyRevision === manifest.desiredSpec.iamPolicyRevision) {
      throw new Error("Execution-role lineage is invalid.");
    }
    const references = [
      parent.terraformOutputs.database_url_secret_arn,
      parent.terraformOutputs.database_password_secret_arn,
      parent.terraformOutputs.application_jwt_secret_arn,
    ];
    const secretArns = references.map((value) => typeof value === "string" ? value : "");
    if (new Set(secretArns).size !== 3 || secretArns.some((arn) => {
      const match = SECRET_ARN.exec(arn);
      return !match || match[2] !== manifest.desiredSpec.region || match[3] !== account;
    })) {
      throw new Error("Exact runtime secret-reference evidence is invalid.");
    }
    const sorted = [...secretArns].sort();
    const evidence: SecretAccessPlanEvidence = Object.freeze({
      boundary: "execution_role_exact_secret_read",
      executionRoleName: roleMatch[3],
      referenceCount: 3,
      referenceFingerprint: canonicalSha256(sorted),
      parentManifestId: parent.id,
      parentOutputsHash: parent.terraformOutputsHash,
    });
    return {
      variables: {
        aws_region: manifest.desiredSpec.region,
        aws_account_id: account,
        offline_plan_mode: manifest.stateBackend === "local_mock",
        execution_role_name: roleMatch[3],
        secret_arns: sorted,
      },
      managedDatabase: null,
      secretAccess: evidence,
    };
  }

  private async managedDatabaseEvidence(manager: EntityManager, manifest: InfrastructureManifest): Promise<ManagedDatabasePlanEvidence> {
    const spec = manifest.desiredSpec;
    if (spec.database.engine !== "postgres" || !spec.database.tierRevision || !spec.database.persistence
      || !spec.discovery.cloudMapRequired || !spec.discovery.namespace || !spec.network.privateSubnets
      || !["single", "per_az"].includes(spec.network.natMode)) {
      throw new Error("Managed PostgreSQL foundation contract is incomplete.");
    }
    const rows = await manager.query(
      `SELECT id, provider, engine, internal_host AS "internalHost", database_name AS "databaseName",
              database_user AS "databaseUser", persistence_enabled AS "persistenceEnabled",
              backup_enabled AS "backupEnabled", updated_at AS "updatedAt"
         FROM project_database_tiers WHERE project_id = $1 FOR UPDATE`,
      [manifest.projectId],
    ) as Array<{
      id: string; provider: string | null; engine: string | null; internalHost: string | null;
      databaseName: string | null; databaseUser: string | null; persistenceEnabled: boolean;
      backupEnabled: boolean; updatedAt: Date;
    }>;
    const tier = rows[0];
    const namespace = `project-${manifest.projectId}.deployguard.local`;
    const expectedHost = `db.${namespace}`;
    const revision = tier && canonicalSha256({
      id: tier.id, provider: tier.provider, engine: tier.engine, internalHost: tier.internalHost,
      databaseName: tier.databaseName, databaseUser: tier.databaseUser,
      persistenceEnabled: tier.persistenceEnabled, backupEnabled: tier.backupEnabled,
      updatedAt: new Date(tier.updatedAt).toISOString(),
    });
    if (!tier || tier.provider !== "managed" || tier.engine !== "postgres" || !tier.persistenceEnabled || !tier.backupEnabled
      || tier.internalHost !== expectedHost || spec.discovery.namespace !== namespace
      || !DATABASE_NAME.test(tier.databaseName || "") || !DATABASE_USER.test(tier.databaseUser || "")
      || revision !== spec.database.tierRevision) {
      throw new Error("Managed PostgreSQL identity changed or is unsafe.");
    }
    const drafts = await manager.query(
      `SELECT release_draft AS "releaseDraft" FROM initial_release_drafts
       WHERE infrastructure_manifest_id = $1 AND project_id = $2 AND environment_name = $3 LIMIT 1`,
      [manifest.id, manifest.projectId, manifest.environmentName],
    ) as Array<{ releaseDraft: { runtime?: { secretReferenceNames?: unknown } } }>;
    const names = Array.isArray(drafts[0]?.releaseDraft?.runtime?.secretReferenceNames)
      ? drafts[0].releaseDraft.runtime.secretReferenceNames.filter((value): value is string => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value))
      : [];
    const applicationSecretReferences = names.map((name) => `project_secret:${name}`);
    if (!applicationSecretReferences.every((reference) => SECRET_REFERENCE.test(reference))) {
      throw new Error("Application secret references are malformed.");
    }
    return Object.freeze({
      tierId: tier.id, tierRevision: revision, engine: "postgres", databaseName: tier.databaseName!,
      databaseUser: tier.databaseUser!, internalHost: expectedHost, port: 5432, persistence: true,
      backupRequired: true, passwordSecretReference: "terraform://database/password",
      urlSecretReference: "terraform://database/url", applicationSecretReferences, discoveryNamespace: namespace,
    });
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

  private assertRemotePlan(
    raw: string,
    backendMode: "local" | "s3",
    manifest: InfrastructureManifest,
    secretAccess: SecretAccessPlanEvidence | null,
  ) {
    if (backendMode !== "s3") return;
    let parsed: {
      variables?: Record<string, { value?: unknown }>;
      resource_changes?: Array<{
        address?: string;
        type?: string;
        mode?: string;
        change?: { actions?: string[]; after?: Record<string, unknown> };
      }>;
    };
    try { parsed = JSON.parse(raw || "{}"); } catch { throw new RemotePlanPreflightError("REMOTE_PLAN_SHOW_INVALID"); }
    if (parsed.variables?.offline_plan_mode?.value !== false) throw new RemotePlanPreflightError("REMOTE_PLAN_OFFLINE_PROVIDER_MODE_INVALID");
    if (secretAccess) {
      const managedChanges = (parsed.resource_changes || []).filter((change) =>
        change.mode !== "data" && (change.change?.actions || []).some((action) => action !== "no-op"),
      );
      const change = managedChanges[0];
      const actions = change?.change?.actions || [];
      const policy = change?.change?.after?.policy;
      let document: { Statement?: Array<{ Effect?: unknown; Action?: unknown; Resource?: unknown }> } = {};
      try { document = JSON.parse(typeof policy === "string" ? policy : "{}"); } catch {
        throw new RemotePlanPreflightError("REMOTE_PLAN_SECRET_POLICY_INVALID");
      }
      const statement = document.Statement?.[0];
      const plannedReferences = Array.isArray(statement?.Resource)
        ? statement.Resource.filter((value): value is string => typeof value === "string").sort()
        : [];
      const inputReferences = Array.isArray(parsed.variables?.secret_arns?.value)
        ? parsed.variables.secret_arns.value.filter((value): value is string => typeof value === "string").sort()
        : [];
      if (managedChanges.length !== 1
        || change?.address !== "aws_iam_role_policy.runtime_secret_access"
        || change.type !== "aws_iam_role_policy"
        || actions.length !== 1 || actions[0] !== "create"
        || statement?.Effect !== "Allow"
        || JSON.stringify(statement.Action) !== JSON.stringify(["secretsmanager:GetSecretValue"])
        || plannedReferences.length !== 3
        || canonicalSha256(plannedReferences) !== secretAccess.referenceFingerprint
        || canonicalSha256(inputReferences) !== secretAccess.referenceFingerprint) {
        throw new RemotePlanPreflightError("REMOTE_PLAN_SECRET_POLICY_SCOPE_MISMATCH");
      }
      return;
    }
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
    const managed = manifest.desiredSpec.database.mode === "managed";
    const hasUnexpectedApplicationService = (parsed.resource_changes || []).some((change) =>
      (change.type === "aws_ecs_task_definition" || change.type === "aws_ecs_service")
      && !String(change.address || "").startsWith("module.database_service."),
    );
    if (create <= 0 || update !== 0 || replace !== 0 || remove !== 0 || hasUnexpectedApplicationService
      || EXPECTED_FOUNDATION_TYPES.some((type) => !types.has(type))
      || (managed && EXPECTED_MANAGED_DATABASE_TYPES.some((type) => !types.has(type)))
      || (!managed && (types.has("aws_ecs_task_definition") || types.has("aws_ecs_service")))) {
      throw new RemotePlanPreflightError("REMOTE_PLAN_TOPOLOGY_MISMATCH");
    }
  }

  private async verifyRemotePlanScope(manifest: InfrastructureManifest) {
    const bucket = this.config.get<string>("TERRAFORM_STATE_BUCKET", "").trim();
    const region = this.config.get<string>("TERRAFORM_STATE_REGION", "").trim();
    const expectedAccount = this.expectedAwsAccount();
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
    if (this.isSecretAccessAddon(manifest)) {
      const planned = await this.dataSource.getRepository(InfrastructureManifest).findOneBy({ id: manifest.id });
      const reference = planned?.planArtifactReference?.secretAccess as SecretAccessPlanEvidence | undefined;
      const variables = await this.dataSource.transaction("READ COMMITTED", (manager) => this.secretAccessVariables(manager, manifest));
      const secretArns = variables.variables.secret_arns;
      const executionRoleName = variables.variables.execution_role_name;
      if (!Array.isArray(secretArns) || typeof executionRoleName !== "string"
        || (reference && reference.referenceFingerprint !== variables.secretAccess?.referenceFingerprint)) {
        throw new RemotePlanPreflightError("REMOTE_PLAN_SECRET_IDENTITY_INVALID");
      }
      await this.aws(["iam", "get-role", "--role-name", executionRoleName]);
      for (const secretArn of secretArns) {
        if (typeof secretArn !== "string") throw new RemotePlanPreflightError("REMOTE_PLAN_SECRET_IDENTITY_INVALID");
        await this.aws(["secretsmanager", "describe-secret", "--secret-id", secretArn, "--region", region]);
      }
    }
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

  /**
   * Shared normal-v1 execution is authorized by the durable envelope and the
   * common activation policy, not by the retired one-project canary identity.
   * Keep the remote backend, account and exact revision-key checks here so a
   * direct service invocation still fails closed before Terraform starts.
   */
  private sharedRemotePlanAllowed(manifest: InfrastructureManifest) {
    const enabled = (key: string) => this.config.get<string>(key, "").trim() === "true";
    if (!normalV1IsShared(this.config)
      || !enabled("TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_EXECUTION_ENABLED")
      || !normalV1AllowsScope(this.config, manifest.projectId, manifest.environmentName)
      || !AWS_ACCOUNT.test(this.expectedAwsAccount())
      || !enabled("TERRAFORM_STATE_USE_LOCKFILE")
      || !this.config.get<string>("TERRAFORM_STATE_BUCKET", "").trim()
      || !this.config.get<string>("TERRAFORM_STATE_REGION", "").trim()) {
      return false;
    }
    const prefix = this.config.get<string>("TERRAFORM_STATE_PREFIX", "projects").trim();
    const expectedStateKey = `${prefix}/${manifest.projectId}/dev/v1/${manifest.revision}.tfstate`;
    return manifest.stateBackend === "s3"
      && manifest.environmentName === "dev"
      && manifest.stateKey === expectedStateKey;
  }

  private remotePlanAllowed(manifest: InfrastructureManifest) {
    return normalV1IsShared(this.config)
      ? this.sharedRemotePlanAllowed(manifest)
      : this.remoteCanaryAllowed(manifest);
  }

  private expectedAwsAccount() {
    const key = normalV1IsShared(this.config)
      ? "TWO_LANE_EXPECTED_AWS_ACCOUNT_ID"
      : "TWO_LANE_CANARY_EXPECTED_AWS_ACCOUNT";
    return this.config.get<string>(key, "").trim();
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
