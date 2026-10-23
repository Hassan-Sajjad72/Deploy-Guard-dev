import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { DataSource, EntityManager } from "typeorm";
import { TerraformRunnerService } from "../../infrastructure/terraform-runner.service";
import { canonicalSha256 } from "../contracts/canonical-json";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { InactiveReleaseLaneOwnershipService } from "../release-lane/inactive-release-lane-ownership.service";
import type { ReleaseLaneOwnershipSnapshot } from "../release-lane/inactive-release-lane-ownership.types";
import { DeterministicLocalInfrastructureApplyStateAdapter } from "./deterministic-local-infrastructure-apply-state.adapter";

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const REVISION = /^[1-9][0-9]*$/;
const AWS_ACCOUNT = /^\d{12}$/;
const EXPECTED_MANAGED_TYPES = [
  "aws_cloudwatch_log_group", "aws_ecr_lifecycle_policy", "aws_ecr_repository",
  "aws_ecs_cluster", "aws_iam_role", "aws_iam_role_policy_attachment",
  "aws_internet_gateway", "aws_lb", "aws_lb_listener", "aws_lb_target_group",
  "aws_route_table", "aws_route_table_association", "aws_security_group",
  "aws_subnet", "aws_vpc",
];
const OUTPUT_KEYS = [
  "vpc_id", "public_subnet_ids", "private_subnet_ids", "internet_gateway_id",
  "public_route_table_id", "private_route_table_id", "alb_security_group_id",
  "app_security_group_id", "internal_security_group_id", "ecr_repository_name",
  "ecr_repository_url", "alb_arn", "alb_dns_name", "alb_target_group_arn",
  "alb_listener_arn", "alb_health_check_path", "ecs_cluster_arn",
  "ecs_cluster_name", "ecs_execution_role_arn", "ecs_task_role_arn",
  "ecs_log_group_name", "canary_nat_gateway_count", "canary_ecs_assign_public_ip",
  "database_enabled", "database_internal_host", "database_port", "database_service_arn",
  "database_cloud_map_service_arn", "database_security_group_id",
  "database_password_secret_arn", "database_url_secret_arn",
] as const;

export type V1InfrastructureApplyResult = Readonly<{
  state: "applied" | "failed" | "uncertain";
  manifestId: string;
  revision: string;
  safeCodes: readonly string[];
  resourceCount: number | null;
  stateStatus: "active" | "absent" | "unverified";
  lockStatus: "released" | "active" | "unverified";
  ownershipStatus: "released" | "retained" | "unverified";
}>;

type PreparedApply = {
  manifest: InfrastructureManifest;
  workspace: string;
  ownership: ReleaseLaneOwnershipSnapshot;
};

/**
 * Explicit, default-off, one-shot canary foundation apply. It has no controller,
 * queue, consumer, release-manifest, image, task-definition, or ECS-service path.
 */
@Injectable()
export class V1InfrastructureManifestApplyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly terraform: TerraformRunnerService,
    private readonly ownership: InactiveReleaseLaneOwnershipService,
    @Optional() private readonly localState?: DeterministicLocalInfrastructureApplyStateAdapter,
  ) {}

  async apply(manifestId: string, approvedPlanHash: string): Promise<V1InfrastructureApplyResult> {
    if (!UUID.test(manifestId) || !HASH.test(approvedPlanHash)) {
      throw new Error("CANARY_APPLY_INPUT_INVALID");
    }

    const manifest = await this.loadAndValidate(manifestId, approvedPlanHash);
    const workspace = await this.workspace(manifest);
    await this.verifyArtifactAndPlan(manifest, workspace, approvedPlanHash);
    await this.verifyRemoteStatePreconditions(manifest);

    const leaseId = this.deterministicUuid(`canary-foundation-apply:${manifest.id}:${approvedPlanHash}`);
    const actorId = `canary-foundation-apply:${manifest.id}`;
    const identity = canonicalSha256({
      operation: "v1_canary_foundation_apply",
      projectId: manifest.projectId,
      environmentName: manifest.environmentName,
      manifestId: manifest.id,
      approvedPlanHash,
    });
    const acquired = await this.ownership.acquire({
      projectId: manifest.projectId,
      environmentName: manifest.environmentName,
      lane: "v1",
      leaseId,
      actorId,
      idempotencyKey: identity,
      requestFingerprint: approvedPlanHash,
      leaseTtlMs: 5 * 60_000,
    });
    if (acquired.disposition !== "acquired" && acquired.disposition !== "already_owned") {
      throw new Error(`CANARY_APPLY_${acquired.disposition.toUpperCase()}`);
    }

    const prepared: PreparedApply = { manifest, workspace, ownership: acquired.ownership };
    let trusted = true;
    let stopped = false;
    let renewal: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      if (stopped || !trusted) return;
      renewal = renewal.then(async () => {
        const result = await this.ownership.renew({
          projectId: manifest.projectId,
          environmentName: manifest.environmentName,
          lane: "v1",
          leaseId: acquired.ownership.leaseId,
          actorId,
          fencingToken: acquired.ownership.fencingToken,
          leaseTtlMs: 5 * 60_000,
        });
        trusted = result.disposition === "acquired" || result.disposition === "already_owned";
      }).catch(() => { trusted = false; });
    }, 60_000);
    timer.unref?.();

    let result: V1InfrastructureApplyResult;
    try {
      await this.markApplying(prepared.manifest.id, approvedPlanHash);
      try {
        await this.terraform.assertBackendMode(workspace, "s3");
        await this.terraform.runTerraformApply(workspace, {}, "tfplan");
        result = await this.verifyAndPersist(prepared, trusted);
      } catch {
        result = await this.reconcileFailure(prepared, trusted);
      }
    } finally {
      stopped = true;
      clearInterval(timer);
      await renewal;
    }

    if (result.state !== "uncertain") {
      const released = await this.ownership.release({
        projectId: manifest.projectId,
        environmentName: manifest.environmentName,
        lane: "v1",
        leaseId: acquired.ownership.leaseId,
        actorId,
        fencingToken: acquired.ownership.fencingToken,
      });
      const ok = released.disposition === "acquired" || released.disposition === "already_owned";
      if (!ok) {
        return { ...result, ownershipStatus: "unverified", safeCodes: [...result.safeCodes, "OWNERSHIP_RELEASE_UNVERIFIED"] };
      }
      return { ...result, ownershipStatus: "released" };
    }
    return result;
  }

  /**
   * Consumer-only fenced entry point. The worker owns the cross-lane scope and
   * operation lease; this method therefore never acquires a second ownership
   * lease. Local-mock execution is deliberately available only to isolated
   * fixtures, while normal runtime use remains exact-gated and remote-only.
   */
  async applyFromFencedInvocation(manifestId: string, approvedPlanHash: string): Promise<V1InfrastructureApplyResult> {
    if (!UUID.test(manifestId) || !HASH.test(approvedPlanHash)) throw new Error("NORMAL_INFRASTRUCTURE_APPLY_INPUT_INVALID");
    const manifest = await this.dataSource.getRepository(InfrastructureManifest).findOneByOrFail({ id: manifestId });
    if (!this.normalInvocationEnabled(manifest) || !["planned", "manual_review"].includes(manifest.status)
      || manifest.planArtifactSha256 !== approvedPlanHash
      || manifest.planArtifactReference?.artifactSha256 !== approvedPlanHash) {
      throw new Error("NORMAL_INFRASTRUCTURE_APPLY_CONFIGURATION_INVALID");
    }
    const workspace = await this.fencedWorkspace(manifest);
    await this.verifyFencedArtifact(manifest, workspace, approvedPlanHash);
    if (manifest.status === "manual_review" && manifest.stateBackend === "local_mock" && this.localState) {
      const identity = canonicalSha256({ manifestId: manifest.id, revision: manifest.revision, planHash: approvedPlanHash, input: manifest.planInputFingerprint });
      const recovered = await this.localState.inspect(workspace);
      if (!recovered || recovered.planHash !== approvedPlanHash || recovered.inputIdentity !== identity) {
        return this.result(manifest, "uncertain", ["TERRAFORM_APPLY_OUTCOME_UNCERTAIN"]);
      }
      this.assertManagedDatabaseOutputs(manifest, recovered.outputs);
      return this.persistApplied(manifest.id, {
        outputs: recovered.outputs, outputsHash: canonicalSha256(recovered.outputs), resourceCount: recovered.resourceCount,
        stateVersionId: recovered.stateVersionId,
      }, "INFRASTRUCTURE_APPLY_RECONCILED_FROM_LOCAL_STATE", true);
    }
    if (manifest.stateBackend === "s3") {
      try {
        await this.verifyRemoteStatePreconditions(manifest);
        await this.terraform.assertBackendMode(workspace, "s3");
      } catch {
        return this.result(manifest, "failed", ["INFRASTRUCTURE_APPLY_PREFLIGHT_FAILED"]);
      }
    }
    await this.markApplying(manifest.id, approvedPlanHash);
    try {
      if (manifest.stateBackend === "local_mock") {
        if (!this.localState) throw new Error("NORMAL_INFRASTRUCTURE_APPLY_LOCAL_ADAPTER_UNAVAILABLE");
        const identity = canonicalSha256({ manifestId: manifest.id, revision: manifest.revision, planHash: approvedPlanHash, input: manifest.planInputFingerprint });
        const evidence = await this.localState.apply(workspace, { planHash: approvedPlanHash, inputIdentity: identity });
        this.assertManagedDatabaseOutputs(manifest, evidence.outputs);
        return this.persistApplied(manifest.id, {
          outputs: evidence.outputs, outputsHash: canonicalSha256(evidence.outputs), resourceCount: evidence.resourceCount,
          stateVersionId: evidence.stateVersionId,
        }, "INFRASTRUCTURE_APPLY_LOCAL_VERIFIED");
      }
      await this.terraform.runTerraformApply(workspace, {}, "tfplan");
      return this.verifyAndPersist({ manifest, workspace, ownership: {} as ReleaseLaneOwnershipSnapshot }, true);
    } catch {
      if (manifest.stateBackend === "local_mock") return this.persistUncertain(manifest.id, "TERRAFORM_APPLY_OUTCOME_UNCERTAIN", null);
      return this.reconcileFailure({ manifest, workspace, ownership: {} as ReleaseLaneOwnershipSnapshot }, true);
    }
  }

  private normalInvocationEnabled(manifest: InfrastructureManifest) {
    const enabled = (key: string) => this.config.get<string>(key, "") === "true";
    if (!enabled("TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_ENABLED")
      || this.config.get<string>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST", "") !== manifest.projectId
      || this.config.get<string>("TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST", "") !== "dev"
      || manifest.environmentName !== "dev") return false;
    return manifest.stateBackend === "s3" || (manifest.stateBackend === "local_mock" && Boolean(this.localState));
  }

  private async fencedWorkspace(manifest: InfrastructureManifest) {
    const ref = manifest.planArtifactReference?.workspaceRef;
    const expected = manifest.stateBackend === "s3"
      ? `v1-remote-plan/${manifest.projectId}/${manifest.id}/terraform`
      : `v1-plan/${manifest.projectId}/${manifest.id}/terraform`;
    if (typeof ref !== "string" || !ref.startsWith(expected)) throw new Error("NORMAL_INFRASTRUCTURE_APPLY_WORKSPACE_INVALID");
    const root = resolve(this.config.get<string>("TERRAFORM_WORKING_BASE_DIR", "./.deployguard/terraform-workspaces"));
    const workspace = await realpath(join(root, ref));
    const realRoot = await realpath(root);
    const fromRoot = relative(realRoot, workspace);
    if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("NORMAL_INFRASTRUCTURE_APPLY_WORKSPACE_INVALID");
    return workspace;
  }

  private async verifyFencedArtifact(manifest: InfrastructureManifest, workspace: string, planHash: string) {
    const actual = createHash("sha256").update(await readFile(join(workspace, "tfplan"))).digest("hex");
    if (actual !== planHash) throw new Error("NORMAL_INFRASTRUCTURE_APPLY_PLAN_HASH_MISMATCH");
    if (manifest.stateBackend === "s3") await this.verifyArtifactAndPlan(manifest, workspace, planHash);
  }

  /** Read-only reconciliation for an uncertain invocation. It never calls Terraform apply. */
  async reconcile(manifestId: string, approvedPlanHash: string): Promise<V1InfrastructureApplyResult> {
    if (!UUID.test(manifestId) || !HASH.test(approvedPlanHash)) throw new Error("CANARY_APPLY_INPUT_INVALID");
    const manifest = await this.loadAndValidate(manifestId, approvedPlanHash, "manual_review");
    if (manifest.failureCode !== "TERRAFORM_APPLY_OUTCOME_UNCERTAIN") throw new Error("CANARY_RECONCILIATION_NOT_REQUIRED");
    const workspace = await this.workspace(manifest);
    await this.verifyArtifactAndPlan(manifest, workspace, approvedPlanHash);
    const ownership = await this.acquireOwnership(manifest, approvedPlanHash);
    try {
      const evidence = await this.collectVerifiedEvidence(manifest, workspace);
      const result = await this.persistApplied(manifest.id, evidence, "APPLY_RECONCILED_FROM_VERIFIED_STATE", true);
      const released = await this.ownership.release({
        projectId: manifest.projectId,
        environmentName: manifest.environmentName,
        lane: "v1",
        leaseId: ownership.ownership.leaseId,
        actorId: ownership.actorId,
        fencingToken: ownership.ownership.fencingToken,
      });
      const ok = released.disposition === "acquired" || released.disposition === "already_owned";
      return { ...result, ownershipStatus: ok ? "released" : "unverified", safeCodes: ok ? result.safeCodes : [...result.safeCodes, "OWNERSHIP_RELEASE_UNVERIFIED"] };
    } catch {
      return this.result(manifest, "uncertain", ["TERRAFORM_APPLY_OUTCOME_UNCERTAIN"]);
    }
  }

  private async loadAndValidate(manifestId: string, approvedPlanHash: string, expectedStatus: "planned" | "manual_review" = "planned") {
    const manifest = await this.dataSource.getRepository(InfrastructureManifest).findOneByOrFail({ id: manifestId });
    const enabled = (key: string) => this.config.get<string>(key, "") === "true";
    const approvedRevision = this.config.get<string>("TWO_LANE_CANARY_APPLY_REVISION", "").trim();
    const expectedKey = `projects/${manifest.projectId}/dev/v1/${manifest.revision}.tfstate`;
    if (!enabled("TWO_LANE_CANARY_APPLY_ENABLED")
      || !enabled("TWO_LANE_CANARY_COST_DEFERRED_ACKNOWLEDGED")
      || this.config.get<string>("TWO_LANE_CANARY_COST_MODE", "") !== "deferred_canary"
      || this.config.get<string>("TWO_LANE_CANARY_PROJECT_ID", "") !== manifest.projectId
      || this.config.get<string>("TWO_LANE_CANARY_ENVIRONMENT", "") !== "dev"
      || this.config.get<string>("TWO_LANE_CANARY_APPLY_MANIFEST_ID", "") !== manifest.id
      || this.config.get<string>("TWO_LANE_CANARY_APPLY_PLAN_HASH", "") !== approvedPlanHash
      || !REVISION.test(approvedRevision) || manifest.environmentName !== "dev" || manifest.revision !== approvedRevision
      || manifest.stateBackend !== "s3" || manifest.stateKey !== expectedKey
      || manifest.status !== expectedStatus || manifest.planArtifactSha256 !== approvedPlanHash
      || (manifest.planArtifactReference?.artifactSha256 !== approvedPlanHash)
      || this.config.get<string>("STATE_MOCK_MODE", "true") !== "false"
      || !enabled("TERRAFORM_STATE_USE_LOCKFILE")) {
      throw new Error("CANARY_APPLY_CONFIGURATION_INVALID");
    }
    const summary = manifest.planArtifactReference?.planSummary as Record<string, unknown> | undefined;
    if (!summary || summary.create !== 25 || summary.update !== 0 || summary.replace !== 0 || summary.delete !== 0) {
      throw new Error("CANARY_APPLY_PLAN_SUMMARY_MISMATCH");
    }
    return manifest;
  }

  private async workspace(manifest: InfrastructureManifest) {
    const ref = manifest.planArtifactReference?.workspaceRef;
    if (typeof ref !== "string" || !ref.startsWith(`v1-remote-plan/${manifest.projectId}/${manifest.id}/terraform`)) {
      throw new Error("CANARY_APPLY_WORKSPACE_INVALID");
    }
    const root = resolve(this.config.get<string>("TERRAFORM_WORKING_BASE_DIR", "./.deployguard/terraform-workspaces"));
    const workspace = await realpath(join(root, ref));
    const realRoot = await realpath(root);
    const fromRoot = relative(realRoot, workspace);
    if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("CANARY_APPLY_WORKSPACE_INVALID");
    return workspace;
  }

  private async verifyArtifactAndPlan(manifest: InfrastructureManifest, workspace: string, approvedPlanHash: string) {
    const backendMetadata = JSON.parse(await readFile(join(workspace, ".terraform", "terraform.tfstate"), "utf8")) as {
      backend?: { type?: string; config?: Record<string, unknown> };
    };
    const backend = backendMetadata.backend;
    if (backend?.type !== "s3"
      || backend.config?.bucket !== this.required("TERRAFORM_STATE_BUCKET")
      || backend.config?.key !== manifest.stateKey
      || backend.config?.region !== this.required("TERRAFORM_STATE_REGION")
      || backend.config?.use_lockfile !== true) {
      throw new Error("CANARY_APPLY_BACKEND_SCOPE_MISMATCH");
    }
    const actual = createHash("sha256").update(await readFile(join(workspace, "tfplan"))).digest("hex");
    if (actual !== approvedPlanHash) throw new Error("CANARY_APPLY_PLAN_HASH_MISMATCH");
    const show = await this.terraform.runTerraformShowJson(workspace);
    const parsed = JSON.parse(show.stdout || "{}") as {
      variables?: Record<string, { value?: unknown }>;
      resource_changes?: Array<{ type?: string; mode?: string; change?: { actions?: string[] } }>;
    };
    if (parsed.variables?.offline_plan_mode?.value !== false) {
      throw new Error("CANARY_APPLY_OFFLINE_PROVIDER_PLAN");
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
    const managedDatabase = manifest.desiredSpec.database.mode === "managed";
    const databaseTypes = ["aws_ecs_service", "aws_ecs_task_definition", "aws_efs_file_system", "aws_efs_access_point", "aws_secretsmanager_secret", "aws_secretsmanager_secret_version", "aws_service_discovery_service"];
    if (create <= 0 || update !== 0 || replace !== 0 || remove !== 0
      || EXPECTED_MANAGED_TYPES.some((type) => !types.has(type))
      || (managedDatabase && databaseTypes.some((type) => !types.has(type)))
      || (!managedDatabase && (types.has("aws_ecs_task_definition") || types.has("aws_ecs_service")))) {
      throw new Error("CANARY_APPLY_PLAN_CHANGED");
    }
  }

  private async verifyRemoteStatePreconditions(manifest: InfrastructureManifest) {
    const bucket = this.required("TERRAFORM_STATE_BUCKET");
    const region = this.required("TERRAFORM_STATE_REGION");
    const expectedAccount = this.required("TWO_LANE_CANARY_EXPECTED_AWS_ACCOUNT");
    if (!AWS_ACCOUNT.test(expectedAccount)) throw new Error("CANARY_APPLY_CONFIGURATION_INVALID");
    const identity = await this.awsJson(["sts", "get-caller-identity", "--region", region]);
    if (identity.Account !== expectedAccount) throw new Error("CANARY_APPLY_ACCOUNT_MISMATCH");
    await this.aws(["s3api", "head-bucket", "--bucket", bucket, "--region", region]);
    const versioning = await this.awsJson(["s3api", "get-bucket-versioning", "--bucket", bucket, "--region", region]);
    if (versioning.Status !== "Enabled") throw new Error("CANARY_STATE_VERSIONING_REQUIRED");
    await this.aws(["s3api", "get-bucket-encryption", "--bucket", bucket, "--region", region]);
    const block = await this.awsJson(["s3api", "get-public-access-block", "--bucket", bucket, "--region", region]);
    const flags = (block.PublicAccessBlockConfiguration || {}) as Record<string, unknown>;
    if (!["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"].every((key) => flags[key] === true)) {
      throw new Error("CANARY_STATE_PUBLIC_ACCESS_BLOCK_REQUIRED");
    }
    if (await this.objectExists(bucket, manifest.stateKey, region)) throw new Error("CANARY_STATE_KEY_COLLISION");
    if (await this.objectExists(bucket, `${manifest.stateKey}.tflock`, region)) throw new Error("CANARY_STATE_LOCK_ACTIVE");
  }

  private async markApplying(manifestId: string, approvedPlanHash: string) {
    await this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const manifest = await this.lockManifest(manager, manifestId);
      if (manifest.status !== "planned" || manifest.planArtifactSha256 !== approvedPlanHash) throw new Error("CANARY_APPLY_MANIFEST_CHANGED");
      manifest.status = "applying";
      manifest.approvedAt = new Date();
      manifest.applyStartedAt = new Date();
      manifest.failureCode = null;
      manifest.failureMessage = null;
      await manager.getRepository(InfrastructureManifest).save(manifest);
    });
  }

  private async verifyAndPersist(prepared: PreparedApply, trusted: boolean) {
    if (!trusted) return this.persistUncertain(prepared.manifest.id, "INFRASTRUCTURE_OWNERSHIP_LOST", null);
    const evidence = await this.collectVerifiedEvidence(prepared.manifest, prepared.workspace);
    return this.persistApplied(prepared.manifest.id, evidence);
  }

  private async reconcileFailure(prepared: PreparedApply, trusted: boolean) {
    try {
      const evidence = await this.collectVerifiedEvidence(prepared.manifest, prepared.workspace);
      if (!trusted) return this.persistUncertain(prepared.manifest.id, "INFRASTRUCTURE_OWNERSHIP_LOST", evidence.resourceCount);
      return this.persistApplied(prepared.manifest.id, evidence, "APPLY_RECONCILED_FROM_VERIFIED_STATE");
    } catch {
      const bucket = this.required("TERRAFORM_STATE_BUCKET");
      const region = this.required("TERRAFORM_STATE_REGION");
      await this.objectExists(bucket, prepared.manifest.stateKey, region).catch(() => false);
      return this.persistUncertain(prepared.manifest.id, "TERRAFORM_APPLY_OUTCOME_UNCERTAIN", null);
    }
  }

  private async collectVerifiedEvidence(manifest: InfrastructureManifest, workspace: string) {
    const state = JSON.parse((await this.terraform.runTerraformShowStateJson(workspace)).stdout || "{}") as {
      values?: { root_module?: TerraformStateModule };
    };
    const resources = this.stateResources(state.values?.root_module);
    const managed = resources.filter((item) => item.mode === "managed");
    const managedDatabase = manifest.desiredSpec.database.mode === "managed";
    if ((!managedDatabase && (managed.length !== 25 || managed.some((item) => item.type === "aws_ecs_service" || item.type === "aws_ecs_task_definition")))
      || (managedDatabase && !["aws_ecs_service", "aws_ecs_task_definition", "aws_efs_file_system", "aws_secretsmanager_secret"].every((type) => managed.some((item) => item.type === type)))) {
      throw new Error("CANARY_FOUNDATION_STATE_MISMATCH");
    }
    const outputs = await this.terraform.parseOutputs(workspace);
    if (outputs.ecs_service_arn || outputs.ecs_service_name || outputs.ecs_task_definition_arn) {
      throw new Error("CANARY_RELEASE_RESOURCE_PRESENT");
    }
    const sanitized = Object.fromEntries(OUTPUT_KEYS.map((key) => [key, outputs[key] ?? null]));
    for (const key of ["vpc_id", "ecr_repository_name", "alb_arn", "alb_target_group_arn", "alb_listener_arn", "ecs_cluster_arn", "ecs_execution_role_arn", "ecs_task_role_arn", "ecs_log_group_name"] as const) {
      if (!sanitized[key]) throw new Error("CANARY_FOUNDATION_OUTPUT_MISSING");
    }
    this.assertManagedDatabaseOutputs(manifest, sanitized);
    await this.verifyAwsFoundation(sanitized);
    const bucket = this.required("TERRAFORM_STATE_BUCKET");
    const region = this.required("TERRAFORM_STATE_REGION");
    const head = await this.awsJson(["s3api", "head-object", "--bucket", bucket, "--key", manifest.stateKey, "--region", region]);
    if (await this.objectExists(bucket, `${manifest.stateKey}.tflock`, region)) throw new Error("CANARY_STATE_LOCK_NOT_RELEASED");
    const versionId = typeof head.VersionId === "string" && head.VersionId !== "null" ? head.VersionId : null;
    if (!versionId) throw new Error("CANARY_STATE_VERSION_UNVERIFIED");
    return { outputs: sanitized, outputsHash: canonicalSha256(sanitized), resourceCount: managed.length, stateVersionId: versionId };
  }

  private async verifyAwsFoundation(outputs: Record<string, unknown>) {
    const region = this.required("TERRAFORM_STATE_REGION");
    const exact = (key: string) => {
      const value = outputs[key];
      if (typeof value !== "string" || !value) throw new Error("CANARY_FOUNDATION_OUTPUT_MISSING");
      return value;
    };
    await this.aws(["ecr", "describe-repositories", "--repository-names", exact("ecr_repository_name"), "--region", region]);
    const cluster = exact("ecs_cluster_arn");
    await this.aws(["ecs", "describe-clusters", "--clusters", cluster, "--include", "TAGS", "--region", region]);
    const services = await this.awsJson(["ecs", "list-services", "--cluster", cluster, "--region", region]);
    if (Array.isArray(services.serviceArns) && services.serviceArns.length > 0) throw new Error("CANARY_RELEASE_RESOURCE_PRESENT");
    await this.aws(["elbv2", "describe-load-balancers", "--load-balancer-arns", exact("alb_arn"), "--region", region]);
    await this.aws(["elbv2", "describe-target-groups", "--target-group-arns", exact("alb_target_group_arn"), "--region", region]);
    await this.aws(["elbv2", "describe-listeners", "--listener-arns", exact("alb_listener_arn"), "--region", region]);
    await this.aws(["ec2", "describe-vpcs", "--vpc-ids", exact("vpc_id"), "--region", region]);
    const subnets = [...(Array.isArray(outputs.public_subnet_ids) ? outputs.public_subnet_ids : []), ...(Array.isArray(outputs.private_subnet_ids) ? outputs.private_subnet_ids : [])];
    if (subnets.length !== 4 || subnets.some((value) => typeof value !== "string")) throw new Error("CANARY_FOUNDATION_OUTPUT_MISSING");
    await this.aws(["ec2", "describe-subnets", "--subnet-ids", ...(subnets as string[]), "--region", region]);
    const groups = [exact("alb_security_group_id"), exact("app_security_group_id"), exact("internal_security_group_id")];
    await this.aws(["ec2", "describe-security-groups", "--group-ids", ...groups, "--region", region]);
    for (const roleKey of ["ecs_execution_role_arn", "ecs_task_role_arn"]) {
      const roleName = exact(roleKey).split("/").pop();
      if (!roleName) throw new Error("CANARY_FOUNDATION_OUTPUT_MISSING");
      await this.aws(["iam", "get-role", "--role-name", roleName]);
    }
    const logs = await this.awsJson(["logs", "describe-log-groups", "--log-group-name-prefix", exact("ecs_log_group_name"), "--region", region]);
    if (!Array.isArray(logs.logGroups) || !logs.logGroups.some((item) => item?.logGroupName === outputs.ecs_log_group_name)) {
      throw new Error("CANARY_FOUNDATION_LOG_GROUP_MISSING");
    }
  }

  private assertManagedDatabaseOutputs(manifest: InfrastructureManifest, outputs: Record<string, unknown>) {
    if (manifest.desiredSpec.database.mode !== "managed") return;
    const namespace = manifest.desiredSpec.discovery.namespace;
    const host = typeof outputs.database_internal_host === "string" ? outputs.database_internal_host : "";
    const port = outputs.database_port;
    const validReference = (value: unknown) => typeof value === "string" && value.length > 0
      && !/(?:password|jwt|secret)[=:][^:/\s]{8,}/i.test(value);
    if (manifest.desiredSpec.database.engine !== "postgres" || !manifest.desiredSpec.database.persistence
      || !manifest.desiredSpec.discovery.cloudMapRequired || !namespace || host !== `db.${namespace}`
      || port !== 5432 || outputs.database_enabled !== true
      || !validReference(outputs.database_password_secret_arn)
      || !validReference(outputs.database_url_secret_arn)
      || !validReference(outputs.database_cloud_map_service_arn)
      || !validReference(outputs.database_security_group_id)) {
      throw new Error("MANAGED_DATABASE_OUTPUT_CONTRACT_INVALID");
    }
  }

  private async persistApplied(manifestId: string, evidence: { outputs: Record<string, unknown>; outputsHash: string; resourceCount: number; stateVersionId: string }, safeCode?: string, reconciliation = false) {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const manifest = await this.lockManifest(manager, manifestId);
      if (manifest.status !== "applying" && !(reconciliation && manifest.status === "manual_review")) throw new Error("CANARY_APPLY_MANIFEST_CHANGED");
      manifest.status = "applied";
      manifest.terraformOutputs = evidence.outputs;
      manifest.terraformOutputsHash = evidence.outputsHash;
      manifest.resourceCount = evidence.resourceCount;
      manifest.stateVersionId = evidence.stateVersionId;
      manifest.appliedAt = new Date();
      manifest.failureCode = null;
      manifest.failureMessage = null;
      manifest.planArtifactReference = { ...(manifest.planArtifactReference || {}), phase: "applied", verifiedResourceCount: evidence.resourceCount };
      await manager.getRepository(InfrastructureManifest).save(manifest);
      return this.result(manifest, "applied", safeCode ? [safeCode] : []);
    });
  }

  private async persistUncertain(manifestId: string, code: string, resourceCount: number | null) {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const manifest = await this.lockManifest(manager, manifestId);
      manifest.status = "manual_review";
      manifest.resourceCount = resourceCount;
      manifest.failureCode = code;
      manifest.failureMessage = "The apply outcome requires reconciliation from the exact state key before any retry.";
      await manager.getRepository(InfrastructureManifest).save(manifest);
      return this.result(manifest, "uncertain", [code]);
    });
  }

  private async lockManifest(manager: EntityManager, manifestId: string) {
    await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`deployguard:v1-infrastructure-apply:${manifestId}`]);
    const rows = await manager.query("SELECT id FROM infrastructure_manifests WHERE id = $1 FOR UPDATE", [manifestId]);
    if (rows.length !== 1) throw new Error("CANARY_APPLY_MANIFEST_NOT_FOUND");
    return manager.getRepository(InfrastructureManifest).findOneByOrFail({ id: manifestId });
  }

  private result(manifest: InfrastructureManifest, state: V1InfrastructureApplyResult["state"], safeCodes: string[]): V1InfrastructureApplyResult {
    return {
      state, manifestId: manifest.id, revision: manifest.revision, safeCodes,
      resourceCount: manifest.resourceCount,
      stateStatus: manifest.stateVersionId ? "active" : state === "failed" ? "absent" : "unverified",
      lockStatus: state === "applied" ? "released" : "unverified",
      ownershipStatus: state === "uncertain" ? "retained" : "unverified",
    };
  }

  private required(key: string) {
    const value = this.config.get<string>(key, "").trim();
    if (!value) throw new Error("CANARY_APPLY_CONFIGURATION_INVALID");
    return value;
  }

  private deterministicUuid(value: string) {
    const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
    hex[12] = "4";
    hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
  }

  private async acquireOwnership(manifest: InfrastructureManifest, approvedPlanHash: string) {
    const leaseId = this.deterministicUuid(`canary-foundation-apply:${manifest.id}:${approvedPlanHash}`);
    const actorId = `canary-foundation-apply:${manifest.id}`;
    const acquired = await this.ownership.acquire({
      projectId: manifest.projectId,
      environmentName: manifest.environmentName,
      lane: "v1",
      leaseId,
      actorId,
      idempotencyKey: canonicalSha256({ operation: "v1_canary_foundation_apply", projectId: manifest.projectId, environmentName: manifest.environmentName, manifestId: manifest.id, approvedPlanHash }),
      requestFingerprint: approvedPlanHash,
      leaseTtlMs: 5 * 60_000,
    });
    if (acquired.disposition !== "acquired" && acquired.disposition !== "already_owned") throw new Error(`CANARY_APPLY_${acquired.disposition.toUpperCase()}`);
    return { ownership: acquired.ownership, actorId };
  }

  private stateResources(root: TerraformStateModule | undefined): TerraformStateResource[] {
    if (!root) return [];
    return [...(root.resources || []), ...(root.child_modules || []).flatMap((child) => this.stateResources(child))];
  }

  private async objectExists(bucket: string, key: string, region: string) {
    try {
      await this.aws(["s3api", "head-object", "--bucket", bucket, "--key", key, "--region", region]);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "AWS_OBJECT_NOT_FOUND") return false;
      throw error;
    }
  }

  private async awsJson(args: string[]) {
    const result = await this.aws([...args, "--output", "json"]);
    return JSON.parse(result || "{}") as Record<string, any>;
  }

  private async aws(args: string[]) {
    try {
      const result = await execFileAsync("aws", args, { env: process.env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      return String(result.stdout || "");
    } catch (error) {
      const value = error as { stderr?: string; stdout?: string };
      const detail = `${value.stderr || ""} ${value.stdout || ""}`;
      if (/Not Found|NoSuchKey|\b404\b/i.test(detail)) throw new Error("AWS_OBJECT_NOT_FOUND");
      throw new Error("CANARY_AWS_READ_FAILED");
    }
  }
}

type TerraformStateResource = { mode?: "managed" | "data"; type?: string };
type TerraformStateModule = { resources?: TerraformStateResource[]; child_modules?: TerraformStateModule[] };
