import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  normalV1AllowsScope,
  normalV1IsShared,
} from "../release-lane/normal-v1-activation-policy";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { DataSource, EntityManager } from "typeorm";
import { TerraformRunnerService } from "../../infrastructure/terraform-runner.service";
import { canonicalSha256 } from "../contracts/canonical-json";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { TerminalOutboxPolicyService } from "../outbox/terminal-outbox-policy.service";
import { InactiveReleaseLaneOwnershipService } from "../release-lane/inactive-release-lane-ownership.service";
import type { ReleaseLaneOwnershipSnapshot } from "../release-lane/inactive-release-lane-ownership.types";
import { DeterministicLocalInfrastructureApplyStateAdapter } from "./deterministic-local-infrastructure-apply-state.adapter";

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const REVISION = /^[1-9][0-9]*$/;
const AWS_ACCOUNT = /^\d{12}$/;
const IAM_ROLE_ARN = /^arn:(aws[a-z-]*):iam::(\d{12}):role\/([A-Za-z0-9+=,.@_-]{1,64})$/;
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

type AddonApplyOperation = Readonly<{
  intentId: string;
  leaseId: string;
  operationId: string;
  ownerWorkerId: string;
  fencingToken: string;
}>;

/**
 * Explicit, default-off, one-shot canary foundation apply. It has no controller,
 * queue, consumer, release-manifest, image, task-definition, or ECS-service path.
 */
@Injectable()
export class V1InfrastructureManifestApplyService {
  private readonly terminalOutbox = new TerminalOutboxPolicyService();

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
      ownV1IntentId: manifest.createdByIntentId || undefined,
    });
    if (acquired.disposition !== "acquired" && acquired.disposition !== "already_owned") {
      throw new Error(`CANARY_APPLY_${acquired.disposition.toUpperCase()}`);
    }

    const prepared: PreparedApply = { manifest, workspace, ownership: acquired.ownership };
    const addonOperation = this.isSecretAccessAddon(manifest)
      ? await this.acquireAddonApplyOperation(manifest, approvedPlanHash, acquired.ownership)
      : null;
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

    if (addonOperation) {
      await this.finalizeAddonApplyOperation(
        manifest,
        approvedPlanHash,
        addonOperation,
        result,
      );
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
  async applyFromFencedInvocation(
    manifestId: string,
    approvedPlanHash: string,
    options: { allowReconciledPreflightRestart?: boolean } = {},
  ): Promise<V1InfrastructureApplyResult> {
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
    if (manifest.status === "manual_review" && !options.allowReconciledPreflightRestart) {
      return this.result(manifest, "uncertain", ["TERRAFORM_APPLY_OUTCOME_UNCERTAIN"]);
    }
    await this.markApplying(
      manifest.id,
      approvedPlanHash,
      options.allowReconciledPreflightRestart ? ["planned", "manual_review"] : ["planned"],
    );
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

  /**
   * Read-only recovery for a normal fenced invocation whose Terraform process
   * has already returned but whose durable verification was interrupted. This
   * path deliberately never calls `terraform apply`.
   */
  async reconcileNormalAppliedState(
    manifestId: string,
    approvedPlanHash: string,
    options: { recoveryIntentId?: string } = {},
  ): Promise<V1InfrastructureApplyResult> {
    if (!UUID.test(manifestId) || !HASH.test(approvedPlanHash)) throw new Error("NORMAL_INFRASTRUCTURE_APPLY_INPUT_INVALID");
    if (options.recoveryIntentId && !UUID.test(options.recoveryIntentId)) throw new Error("NORMAL_INFRASTRUCTURE_APPLY_INPUT_INVALID");
    const manifest = await this.dataSource.getRepository(InfrastructureManifest).findOneByOrFail({ id: manifestId });
    if (!this.normalInvocationEnabled(manifest)
      || !["applying", "manual_review"].includes(manifest.status)
      || manifest.planArtifactSha256 !== approvedPlanHash
      || manifest.planArtifactReference?.artifactSha256 !== approvedPlanHash) {
      throw new Error("NORMAL_INFRASTRUCTURE_APPLY_RECONCILIATION_INVALID");
    }
    const workspace = await this.fencedWorkspace(manifest);
    await this.verifyFencedArtifact(manifest, workspace, approvedPlanHash);
    const ownership = await this.acquireOwnership(manifest, approvedPlanHash);
    let result: V1InfrastructureApplyResult;
    try {
      const evidence = await this.collectVerifiedEvidence(manifest, workspace);
      try {
        result = await this.persistApplied(
          manifest.id,
          evidence,
          "INFRASTRUCTURE_APPLY_RECONCILED_FROM_VERIFIED_STATE",
          true,
          options.recoveryIntentId ? {
            intentId: options.recoveryIntentId,
            leaseId: ownership.ownership.leaseId,
            ownerWorkerId: ownership.actorId,
            fencingToken: ownership.ownership.fencingToken,
            planHash: approvedPlanHash,
          } : undefined,
        );
      } catch (error) {
        result = this.result(manifest, "uncertain", [options.recoveryIntentId
          ? this.recoveryPersistenceSafeCode(error)
          : this.reconciliationSafeCode(error)]);
      }
    } catch (error) {
      result = this.result(manifest, "uncertain", [this.reconciliationSafeCode(error)]);
    }
    try {
      const released = await this.ownership.release({
        projectId: manifest.projectId,
        environmentName: manifest.environmentName,
        lane: "v1",
        leaseId: ownership.ownership.leaseId,
        actorId: ownership.actorId,
        fencingToken: ownership.ownership.fencingToken,
      });
      return released.disposition === "acquired" || released.disposition === "already_owned"
        ? result
        : { ...result, safeCodes: [...result.safeCodes, "OWNERSHIP_RELEASE_UNVERIFIED"] };
    } catch {
      return { ...result, safeCodes: [...result.safeCodes, "OWNERSHIP_RELEASE_UNVERIFIED"] };
    }
  }

  private normalInvocationEnabled(manifest: InfrastructureManifest) {
    const enabled = (key: string) => this.config.get<string>(key, "") === "true";
    if (!enabled("TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_ENABLED")
      || !normalV1AllowsScope(
        this.config,
        manifest.projectId,
        manifest.environmentName,
      )) return false;
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

  /**
   * Read-only external-state reconciliation for the narrowly scoped IAM
   * secret-access add-on. Terraform apply is never invoked here. This closes
   * only the operation that the one-shot path already fenced and journaled.
   */
  async reconcileSecretAccessAddonAppliedState(
    manifestId: string,
    approvedPlanHash: string,
  ): Promise<V1InfrastructureApplyResult> {
    if (!UUID.test(manifestId) || !HASH.test(approvedPlanHash)) {
      throw new Error("CANARY_APPLY_INPUT_INVALID");
    }
    const manifest = await this.loadAndValidate(manifestId, approvedPlanHash, "applying");
    if (!this.isSecretAccessAddon(manifest)) {
      throw new Error("CANARY_SECRET_ACCESS_RECOVERY_NOT_APPLICABLE");
    }
    const workspace = await this.workspace(manifest);
    await this.verifyArtifactAndPlan(manifest, workspace, approvedPlanHash);
    const evidence = await this.collectVerifiedEvidence(manifest, workspace);
    await this.expireAbandonedSecretAccessApplyFences(manifest, approvedPlanHash);
    const recoveryLeaseId = this.deterministicUuid(
      `iam-secret-access-apply-recovery-owner:${manifest.id}:${approvedPlanHash}`,
    );
    const recoveryActorId = `iam-secret-access-apply-recovery:${manifest.id}`;
    const acquired = await this.ownership.acquire({
      projectId: manifest.projectId,
      environmentName: manifest.environmentName,
      lane: "v1",
      leaseId: recoveryLeaseId,
      actorId: recoveryActorId,
      idempotencyKey: canonicalSha256({
        operation: "iam_secret_access_apply_recovery",
        manifestId: manifest.id,
        approvedPlanHash,
        stateVersionId: evidence.stateVersionId,
      }),
      requestFingerprint: approvedPlanHash,
      leaseTtlMs: 5 * 60_000,
      ownV1IntentId: manifest.createdByIntentId || undefined,
    });
    if (acquired.disposition !== "acquired" && acquired.disposition !== "already_owned") {
      throw new Error("CANARY_SECRET_ACCESS_RECOVERY_OWNERSHIP_BLOCKED");
    }
    try {
      return await this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const locked = await this.lockManifest(manager, manifest.id);
      if (locked.status !== "applying"
        || locked.planArtifactSha256 !== approvedPlanHash
        || !this.isSecretAccessAddon(locked)) {
        throw new Error("CANARY_SECRET_ACCESS_RECOVERY_EVIDENCE_CHANGED");
      }
      const operations = this.rows<{
        operationId: string;
        intentId: string;
        operationLeaseId: string;
        operationWorkerId: string;
        operationFencingToken: string;
      }>(await manager.query(
        `SELECT effect.id AS "operationId",
                effect.intent_id AS "intentId",
                lease.id AS "operationLeaseId",
                lease.owner_worker_id AS "operationWorkerId",
                lease.fencing_token::text AS "operationFencingToken"
           FROM deployment_side_effects effect
           JOIN project_operation_leases lease
             ON lease.id = effect.lease_id
          WHERE effect.intent_id = $1
            AND effect.effect_type = 'infrastructure_terraform_apply'
            AND effect.request_fingerprint = $2
            AND effect.status = 'started'
            AND lease.status = 'expired'
          FOR UPDATE OF effect, lease`,
        [locked.createdByIntentId, approvedPlanHash],
      ));
      if (operations.length !== 1) {
        throw new Error("CANARY_SECRET_ACCESS_RECOVERY_FENCE_INVALID");
      }
      const operation = operations[0];
      const owners = this.rows<{ id: string }>(await manager.query(
        `SELECT id
           FROM project_release_lane_ownerships
          WHERE project_id = $1 AND environment_name = $2
            AND owner_lane = 'v1' AND lease_id = $3 AND actor_id = $4
            AND fencing_token = $5::bigint
            AND status IN ('acquired','heartbeat_active')
            AND expires_at > clock_timestamp()
          FOR UPDATE`,
        [
          locked.projectId,
          locked.environmentName,
          acquired.ownership.leaseId,
          recoveryActorId,
          acquired.ownership.fencingToken,
        ],
      ));
      if (owners.length !== 1) {
        throw new Error("CANARY_SECRET_ACCESS_RECOVERY_OWNERSHIP_LOST");
      }
      const recoveryOperationLeaseId = this.deterministicUuid(
        `iam-secret-access-apply-recovery-operation:${locked.id}:${approvedPlanHash}`,
      );
      const recoveryOperationWorkerId = `iam-secret-access-apply-recovery:${locked.id}`;
      const tokenRows = this.rows<{ token: string }>(await manager.query(
        `SELECT (COALESCE(MAX(fencing_token), 0) + 1)::text AS token
           FROM project_operation_leases
          WHERE project_id = $1 AND environment_name = $2`,
        [locked.projectId, locked.environmentName],
      ));
      const recoveryOperationToken = tokenRows[0]?.token;
      if (!recoveryOperationToken) {
        throw new Error("CANARY_SECRET_ACCESS_RECOVERY_FENCE_INVALID");
      }
      await manager.query(
        `INSERT INTO project_operation_leases
           (id, project_id, environment_name, lane, scope, intent_id,
            pipeline_run_id, destroy_operation_id, owner_worker_id,
            fencing_token, status, acquired_at, heartbeat_at, expires_at,
            released_at, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, 'infrastructure', 'apply', $4,
                 NULL, NULL, $5, $6::bigint, 'acquired',
                 clock_timestamp(), clock_timestamp(),
                 clock_timestamp() + interval '5 minutes', NULL,
                 $7::jsonb, clock_timestamp(), clock_timestamp())`,
        [
          recoveryOperationLeaseId,
          locked.projectId,
          locked.environmentName,
          operation.intentId,
          recoveryOperationWorkerId,
          recoveryOperationToken,
          JSON.stringify({
            operation: "iam_secret_access_apply_recovery",
            manifestId: locked.id,
            planHash: approvedPlanHash,
            stateVersionId: evidence.stateVersionId,
          }),
        ],
      );
      await this.supersedeSecretAccessParent(manager, locked);
      locked.status = "applied";
      locked.terraformOutputs = evidence.outputs;
      locked.terraformOutputsHash = evidence.outputsHash;
      locked.resourceCount = evidence.resourceCount;
      locked.stateVersionId = evidence.stateVersionId;
      locked.appliedAt = new Date();
      locked.failureCode = null;
      locked.failureMessage = null;
      locked.planArtifactReference = {
        ...(locked.planArtifactReference || {}),
        phase: "applied",
        verifiedResourceCount: evidence.resourceCount,
      };
      await manager.getRepository(InfrastructureManifest).save(locked);
      const effectRows = this.rows<{ id: string }>(await manager.query(
        `UPDATE deployment_side_effects
            SET status = 'reconciled',
                safe_result_code = 'IAM_SECRET_ACCESS_PLAN_APPLIED_RECONCILED',
                result_fingerprint = $2,
                external_reference_hash = $3,
                failure_code = NULL,
                reconciliation_required = false,
                completed_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE id = $1 AND status = 'started'
          RETURNING id`,
        [
          operation.operationId,
          evidence.outputsHash,
          canonicalSha256({
            stateKey: locked.stateKey,
            stateVersionId: evidence.stateVersionId,
          }),
        ],
      ));
      if (effectRows.length !== 1) {
        throw new Error("CANARY_SECRET_ACCESS_RECOVERY_JOURNAL_CONFLICT");
      }
      const transitioned = await this.terminalOutbox.transitionIntentToTerminal(manager, {
        intentId: operation.intentId,
        expectedStatus: "planned",
        status: "completed",
        failureCode: null,
        failureMessage: null,
      });
      if (!transitioned) {
        throw new Error("CANARY_SECRET_ACCESS_RECOVERY_INTENT_CONFLICT");
      }
      const operationLeaseRows = this.rows<{ id: string }>(await manager.query(
        `UPDATE project_operation_leases
            SET status = 'released', released_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE id = $1 AND owner_worker_id = $2
            AND fencing_token = $3::bigint
            AND status = 'acquired'
          RETURNING id`,
        [
          recoveryOperationLeaseId,
          recoveryOperationWorkerId,
          recoveryOperationToken,
        ],
      ));
      const ownershipRows = this.rows<{ id: string }>(await manager.query(
        `UPDATE project_release_lane_ownerships
            SET status = 'released', released_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE id = $1 AND lease_id = $2 AND actor_id = $3
            AND fencing_token = $4::bigint
            AND status IN ('acquired','heartbeat_active')
          RETURNING id`,
        [
          owners[0].id,
          acquired.ownership.leaseId,
          recoveryActorId,
          acquired.ownership.fencingToken,
        ],
      ));
      if (operationLeaseRows.length !== 1 || ownershipRows.length !== 1) {
        throw new Error("CANARY_SECRET_ACCESS_RECOVERY_RELEASE_FAILED");
      }
      return {
        ...this.result(
          locked,
          "applied",
          ["IAM_SECRET_ACCESS_PLAN_APPLIED_RECONCILED"],
        ),
        ownershipStatus: "released" as const,
      };
      });
    } catch (error) {
      await this.ownership.release({
        projectId: manifest.projectId,
        environmentName: manifest.environmentName,
        lane: "v1",
        leaseId: acquired.ownership.leaseId,
        actorId: recoveryActorId,
        fencingToken: acquired.ownership.fencingToken,
      }).catch(() => undefined);
      throw error;
    }
  }

  private async expireAbandonedSecretAccessApplyFences(
    manifest: InfrastructureManifest,
    approvedPlanHash: string,
  ) {
    await this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const locked = await this.lockManifest(manager, manifest.id);
      if (locked.status !== "applying"
        || locked.planArtifactSha256 !== approvedPlanHash
        || !locked.createdByIntentId) {
        throw new Error("CANARY_SECRET_ACCESS_RECOVERY_EVIDENCE_CHANGED");
      }
      const alreadyExpired = this.rows<{ id: string }>(await manager.query(
        `SELECT effect.id
           FROM deployment_side_effects effect
           JOIN project_operation_leases lease ON lease.id = effect.lease_id
          WHERE effect.intent_id = $1
            AND effect.effect_type = 'infrastructure_terraform_apply'
            AND effect.request_fingerprint = $2
            AND effect.status = 'started'
            AND lease.status = 'expired'
            AND NOT EXISTS (
              SELECT 1 FROM project_release_lane_ownerships owner
               WHERE owner.project_id = effect.project_id
                 AND owner.environment_name = effect.environment_name
                 AND owner.status IN ('acquired','heartbeat_active')
                 AND owner.expires_at > clock_timestamp()
            )
          FOR UPDATE OF effect, lease`,
        [locked.createdByIntentId, approvedPlanHash],
      ));
      if (alreadyExpired.length === 1) return;
      const rows = this.rows<{
        operationLeaseId: string;
        operationWorkerId: string;
        operationFencingToken: string;
        ownershipId: string;
      }>(await manager.query(
        `SELECT lease.id AS "operationLeaseId",
                lease.owner_worker_id AS "operationWorkerId",
                lease.fencing_token::text AS "operationFencingToken",
                owner.id AS "ownershipId"
           FROM deployment_side_effects effect
           JOIN project_operation_leases lease ON lease.id = effect.lease_id
           JOIN project_release_lane_ownerships owner
             ON owner.project_id = effect.project_id
            AND owner.environment_name = effect.environment_name
          WHERE effect.intent_id = $1
            AND effect.effect_type = 'infrastructure_terraform_apply'
            AND effect.request_fingerprint = $2
            AND effect.status = 'started'
            AND lease.status IN ('acquired','heartbeat_active')
            AND owner.owner_lane = 'v1'
            AND owner.status IN ('acquired','heartbeat_active')
            AND owner.expires_at <= clock_timestamp()
          FOR UPDATE OF effect, lease, owner`,
        [locked.createdByIntentId, approvedPlanHash],
      ));
      if (rows.length !== 1) {
        throw new Error("CANARY_SECRET_ACCESS_RECOVERY_ABANDONED_FENCE_INVALID");
      }
      const row = rows[0];
      const leaseRows = this.rows<{ id: string }>(await manager.query(
        `UPDATE project_operation_leases
            SET status = 'expired', released_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE id = $1 AND owner_worker_id = $2
            AND fencing_token = $3::bigint
            AND status IN ('acquired','heartbeat_active')
          RETURNING id`,
        [
          row.operationLeaseId,
          row.operationWorkerId,
          row.operationFencingToken,
        ],
      ));
      const ownerRows = this.rows<{ id: string }>(await manager.query(
        `UPDATE project_release_lane_ownerships
            SET status = 'expired', released_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE id = $1 AND status IN ('acquired','heartbeat_active')
            AND expires_at <= clock_timestamp()
          RETURNING id`,
        [row.ownershipId],
      ));
      if (leaseRows.length !== 1 || ownerRows.length !== 1) {
        throw new Error("CANARY_SECRET_ACCESS_RECOVERY_ABANDONED_FENCE_CONFLICT");
      }
    });
  }

  private async loadAndValidate(
    manifestId: string,
    approvedPlanHash: string,
    expectedStatus: "planned" | "applying" | "manual_review" = "planned",
  ) {
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
    const summaryMatches = this.isSecretAccessAddon(manifest)
      ? summary?.create === 1 && summary?.update === 0 && summary?.replace === 0
        && summary?.delete === 0
        && Array.isArray(summary?.resourceTypes)
        && summary.resourceTypes.length === 1
        && summary.resourceTypes[0] === "aws_iam_role_policy"
      : summary?.create === 25 && summary?.update === 0 && summary?.replace === 0
        && summary?.delete === 0;
    if (!summaryMatches) {
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
      resource_changes?: Array<{
        address?: string;
        type?: string;
        mode?: string;
        change?: { actions?: string[]; after?: Record<string, unknown> };
      }>;
    };
    if (parsed.variables?.offline_plan_mode?.value !== false) {
      throw new Error("CANARY_APPLY_OFFLINE_PROVIDER_PLAN");
    }
    if (this.isSecretAccessAddon(manifest)) {
      this.assertSecretAccessPlan(manifest, parsed);
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
    const expectedAccount = this.expectedAwsAccount();
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

  private async markApplying(
    manifestId: string,
    approvedPlanHash: string,
    allowedStatuses: readonly InfrastructureManifest["status"][] = ["planned"],
  ) {
    await this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const manifest = await this.lockManifest(manager, manifestId);
      if (!allowedStatuses.includes(manifest.status) || manifest.planArtifactSha256 !== approvedPlanHash) throw new Error("CANARY_APPLY_MANIFEST_CHANGED");
      manifest.status = "applying";
      manifest.approvedAt = new Date();
      manifest.applyStartedAt = new Date();
      manifest.failureCode = null;
      manifest.failureMessage = null;
      await manager.getRepository(InfrastructureManifest).save(manifest);
    });
  }

  private expectedAwsAccount() {
    const key = normalV1IsShared(this.config)
      ? "TWO_LANE_EXPECTED_AWS_ACCOUNT_ID"
      : "TWO_LANE_CANARY_EXPECTED_AWS_ACCOUNT";
    return this.required(key);
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
    if (this.isSecretAccessAddon(manifest)) {
      return this.collectSecretAccessEvidence(manifest, workspace, managed);
    }
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
    // Older approved managed-database plans may contain the Terraform provider
    // service ID under the historical `database_service_arn` output. State is
    // authoritative after apply, so reconcile that one sanitized identity from
    // the exact managed resource without refreshing or changing Terraform.
    const databaseServiceResource = managedDatabase
      ? managed.find((item) => item.type === "aws_ecs_service")
      : null;
    const databaseServiceNameValue = databaseServiceResource?.values?.name;
    const databaseServiceName = typeof databaseServiceNameValue === "string" ? databaseServiceNameValue : null;
    const databaseClusterValue = databaseServiceResource?.values?.cluster;
    const databaseCluster = typeof databaseClusterValue === "string" ? databaseClusterValue : null;
    const databaseTaskDefinitionValue = databaseServiceResource?.values?.task_definition;
    const databaseTaskDefinition = typeof databaseTaskDefinitionValue === "string" ? databaseTaskDefinitionValue : null;
    if (managedDatabase && (!databaseServiceName || !databaseCluster || !databaseTaskDefinition)) {
      throw new Error("CANARY_MANAGED_DATABASE_SERVICE_MISSING");
    }
    for (const key of ["vpc_id", "ecr_repository_name", "alb_arn", "alb_target_group_arn", "alb_listener_arn", "ecs_cluster_arn", "ecs_execution_role_arn", "ecs_task_role_arn", "ecs_log_group_name"] as const) {
      if (!sanitized[key]) throw new Error("CANARY_FOUNDATION_OUTPUT_MISSING");
    }
    this.assertManagedDatabaseOutputs(manifest, sanitized);
    const verifiedDatabaseServiceArn = await this.verifyAwsFoundation(sanitized, databaseServiceName && databaseCluster && databaseTaskDefinition
      ? { name: databaseServiceName, cluster: databaseCluster, taskDefinition: databaseTaskDefinition }
      : null);
    if (verifiedDatabaseServiceArn) sanitized.database_service_arn = verifiedDatabaseServiceArn;
    const bucket = this.required("TERRAFORM_STATE_BUCKET");
    const region = this.required("TERRAFORM_STATE_REGION");
    const head = await this.awsJson(["s3api", "head-object", "--bucket", bucket, "--key", manifest.stateKey, "--region", region]);
    if (await this.objectExists(bucket, `${manifest.stateKey}.tflock`, region)) throw new Error("CANARY_STATE_LOCK_NOT_RELEASED");
    const versionId = typeof head.VersionId === "string" && head.VersionId !== "null" ? head.VersionId : null;
    if (!versionId) throw new Error("CANARY_STATE_VERSION_UNVERIFIED");
    return { outputs: sanitized, outputsHash: canonicalSha256(sanitized), resourceCount: managed.length, stateVersionId: versionId };
  }

  private async verifyAwsFoundation(
    outputs: Record<string, unknown>,
    databaseService: { name: string; cluster: string; taskDefinition: string } | null = null,
  ) {
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
    if (Array.isArray(services.serviceArns) && services.serviceArns.length > 0) {
      throw new Error("CANARY_RELEASE_RESOURCE_PRESENT");
    }
    let verifiedDatabaseServiceArn: string | null = null;
    if (databaseService) {
      const databaseCluster = await this.awsJson(["ecs", "describe-clusters", "--clusters", databaseService.cluster, "--include", "TAGS", "--region", region]);
      if (!Array.isArray(databaseCluster.clusters) || databaseCluster.clusters.length !== 1
        || databaseCluster.clusters[0]?.status !== "ACTIVE") throw new Error("CANARY_MANAGED_DATABASE_SERVICE_MISSING");
      const databaseServices = await this.awsJson(["ecs", "list-services", "--cluster", databaseService.cluster, "--region", region]);
      if (!Array.isArray(databaseServices.serviceArns) || databaseServices.serviceArns.length !== 1) {
        throw new Error("CANARY_MANAGED_DATABASE_SERVICE_MISSING");
      }
      const described = await this.awsJson(["ecs", "describe-services", "--cluster", databaseService.cluster, "--services", databaseService.name, "--include", "TAGS", "--region", region]);
      const serviceArn = Array.isArray(described.services) && described.services.length === 1
        ? described.services[0]?.serviceArn : null;
      const service = described.services?.[0];
      const primary = Array.isArray(service?.deployments)
        ? service.deployments.find((deployment: Record<string, unknown>) => deployment.status === "PRIMARY")
        : null;
      if (typeof serviceArn !== "string" || !serviceArn || service.status !== "ACTIVE"
        || service.desiredCount !== 1 || service.runningCount !== 1 || service.pendingCount !== 0
        || service.taskDefinition !== databaseService.taskDefinition
        || service.networkConfiguration?.awsvpcConfiguration?.assignPublicIp !== "DISABLED"
        || !Array.isArray(service.serviceRegistries) || service.serviceRegistries.length !== 1
        || primary?.rolloutState !== "COMPLETED") throw new Error("CANARY_MANAGED_DATABASE_SERVICE_MISSING");
      const taskDefinition = await this.awsJson(["ecs", "describe-task-definition", "--task-definition", databaseService.taskDefinition, "--include", "TAGS", "--region", region]);
      if (taskDefinition.taskDefinition?.status !== "ACTIVE") throw new Error("CANARY_MANAGED_DATABASE_SERVICE_MISSING");
      verifiedDatabaseServiceArn = serviceArn;
    }
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
    return verifiedDatabaseServiceArn;
  }

  private isSecretAccessAddon(manifest: InfrastructureManifest) {
    const metadata = manifest.planArtifactReference?.secretAccess as Record<string, unknown> | undefined;
    return Boolean(
      manifest.parentManifestId
      && manifest.changeSet.fromManifestId === manifest.parentManifestId
      && manifest.changeSet.changedPaths.length === 1
      && manifest.changeSet.changedPaths[0] === "iamPolicyRevision"
      && manifest.changeSet.categories.length === 1
      && manifest.changeSet.categories[0] === "iam"
      && manifest.changeSet.destructivePaths.length === 0
      && metadata?.boundary === "execution_role_exact_secret_read",
    );
  }

  private secretAccessMetadata(manifest: InfrastructureManifest) {
    const metadata = manifest.planArtifactReference?.secretAccess as Record<string, unknown> | undefined;
    const roleName = metadata?.executionRoleName;
    const fingerprint = metadata?.referenceFingerprint;
    const parentOutputsHash = metadata?.parentOutputsHash;
    if (!this.isSecretAccessAddon(manifest)
      || metadata?.parentManifestId !== manifest.parentManifestId
      || metadata?.referenceCount !== 3
      || typeof roleName !== "string" || !/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(roleName)
      || typeof fingerprint !== "string" || !HASH.test(fingerprint)
      || typeof parentOutputsHash !== "string" || !HASH.test(parentOutputsHash)) {
      throw new Error("CANARY_SECRET_ACCESS_EVIDENCE_INVALID");
    }
    return { roleName, fingerprint, parentOutputsHash };
  }

  private assertSecretAccessPlan(
    manifest: InfrastructureManifest,
    parsed: {
      variables?: Record<string, { value?: unknown }>;
      resource_changes?: Array<{
        address?: string;
        type?: string;
        mode?: string;
        change?: { actions?: string[]; after?: Record<string, unknown> };
      }>;
    },
  ) {
    const metadata = this.secretAccessMetadata(manifest);
    const changes = (parsed.resource_changes || []).filter((change) =>
      change.mode !== "data"
      && (change.change?.actions || []).some((action) => action !== "no-op"),
    );
    const change = changes[0];
    const actions = change?.change?.actions || [];
    const role = change?.change?.after?.role;
    const document = this.policyDocument(change?.change?.after?.policy);
    const statement = document.Statement?.[0];
    const resources = this.stringArray(statement?.Resource).sort();
    const inputResources = this.stringArray(parsed.variables?.secret_arns?.value).sort();
    if (changes.length !== 1
      || change?.address !== "aws_iam_role_policy.runtime_secret_access"
      || change.type !== "aws_iam_role_policy"
      || actions.length !== 1 || actions[0] !== "create"
      || role !== metadata.roleName
      || statement?.Effect !== "Allow"
      || JSON.stringify(statement.Action) !== JSON.stringify(["secretsmanager:GetSecretValue"])
      || resources.length !== 3
      || resources.includes("*")
      || canonicalSha256(resources) !== metadata.fingerprint
      || canonicalSha256(inputResources) !== metadata.fingerprint) {
      throw new Error("CANARY_APPLY_PLAN_CHANGED");
    }
  }

  private async collectSecretAccessEvidence(
    manifest: InfrastructureManifest,
    workspace: string,
    managed: TerraformStateResource[],
  ) {
    const metadata = this.secretAccessMetadata(manifest);
    if (managed.length !== 1 || managed[0].type !== "aws_iam_role_policy") {
      throw new Error("CANARY_SECRET_ACCESS_STATE_MISMATCH");
    }
    const stateRole = managed[0].values?.role;
    const stateName = managed[0].values?.name;
    const stateDocument = this.policyDocument(managed[0].values?.policy);
    this.assertExactSecretPolicy(
      stateDocument,
      metadata.fingerprint,
      stateRole,
      stateName,
      metadata.roleName,
    );
    const outputs = await this.terraform.parseOutputs(workspace);
    const outputReferences = this.stringArray(outputs.secret_reference_fingerprint_input).sort();
    if (outputs.execution_role_name !== metadata.roleName
      || outputReferences.length !== 3
      || canonicalSha256(outputReferences) !== metadata.fingerprint) {
      throw new Error("CANARY_SECRET_ACCESS_OUTPUT_MISMATCH");
    }
    const live = await this.awsJson([
      "iam", "get-role-policy",
      "--role-name", metadata.roleName,
      "--policy-name", "deployguard-runtime-secret-access",
    ]);
    this.assertExactSecretPolicy(
      this.policyDocument(live.PolicyDocument),
      metadata.fingerprint,
      live.RoleName,
      live.PolicyName,
      metadata.roleName,
    );
    const parent = await this.dataSource.getRepository(InfrastructureManifest).findOneBy({
      id: manifest.parentManifestId!,
      projectId: manifest.projectId,
      environmentName: manifest.environmentName,
      status: "applied",
    });
    if (!parent?.terraformOutputs || parent.terraformOutputsHash !== metadata.parentOutputsHash
      || canonicalSha256(parent.terraformOutputs) !== parent.terraformOutputsHash) {
      throw new Error("CANARY_SECRET_ACCESS_PARENT_CHANGED");
    }
    const executionRoleArn = parent.terraformOutputs.ecs_execution_role_arn;
    const roleMatch = typeof executionRoleArn === "string" ? IAM_ROLE_ARN.exec(executionRoleArn) : null;
    if (!roleMatch || roleMatch[3] !== metadata.roleName) {
      throw new Error("CANARY_SECRET_ACCESS_PARENT_CHANGED");
    }
    const sanitized = {
      ...parent.terraformOutputs,
      runtime_secret_access_policy_name: "deployguard-runtime-secret-access",
      runtime_secret_access_reference_fingerprint: metadata.fingerprint,
    };
    const bucket = this.required("TERRAFORM_STATE_BUCKET");
    const region = this.required("TERRAFORM_STATE_REGION");
    const head = await this.awsJson([
      "s3api", "head-object", "--bucket", bucket, "--key", manifest.stateKey,
      "--region", region,
    ]);
    if (await this.objectExists(bucket, `${manifest.stateKey}.tflock`, region)) {
      throw new Error("CANARY_STATE_LOCK_NOT_RELEASED");
    }
    const versionId = typeof head.VersionId === "string" && head.VersionId !== "null"
      ? head.VersionId : null;
    if (!versionId) throw new Error("CANARY_STATE_VERSION_UNVERIFIED");
    return {
      outputs: sanitized,
      outputsHash: canonicalSha256(sanitized),
      resourceCount: (parent.resourceCount || 0) + 1,
      stateVersionId: versionId,
    };
  }

  private assertExactSecretPolicy(
    document: { Statement?: Array<{ Effect?: unknown; Action?: unknown; Resource?: unknown }> },
    fingerprint: string,
    role: unknown,
    policyName: unknown,
    expectedRole: string,
  ) {
    const statements = Array.isArray(document.Statement) ? document.Statement : [];
    const statement = statements[0];
    const resources = this.stringArray(statement?.Resource).sort();
    if (statements.length !== 1
      || statement?.Effect !== "Allow"
      || JSON.stringify(statement.Action) !== JSON.stringify(["secretsmanager:GetSecretValue"])
      || resources.length !== 3 || resources.includes("*")
      || canonicalSha256(resources) !== fingerprint
      || role !== expectedRole
      || policyName !== "deployguard-runtime-secret-access") {
      throw new Error("CANARY_SECRET_ACCESS_POLICY_MISMATCH");
    }
  }

  private policyDocument(value: unknown) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as { Statement?: Array<{ Effect?: unknown; Action?: unknown; Resource?: unknown }> };
    }
    if (typeof value !== "string") return {};
    try {
      return JSON.parse(value) as { Statement?: Array<{ Effect?: unknown; Action?: unknown; Resource?: unknown }> };
    } catch {
      try {
        return JSON.parse(decodeURIComponent(value)) as { Statement?: Array<{ Effect?: unknown; Action?: unknown; Resource?: unknown }> };
      } catch {
        return {};
      }
    }
  }

  private stringArray(value: unknown) {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : typeof value === "string" ? [value] : [];
  }

  private assertManagedDatabaseOutputs(manifest: InfrastructureManifest, outputs: Record<string, unknown>) {
    if (manifest.desiredSpec.database.mode !== "managed") return;
    const namespace = manifest.desiredSpec.discovery.namespace;
    const host = typeof outputs.database_internal_host === "string" ? outputs.database_internal_host : "";
    const port = outputs.database_port;
    const validReference = (value: unknown) => typeof value === "string" && value.length > 0
      && !/(?:password|jwt|secret)\s*=\s*[^\s]{8,}/i.test(value);
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

  private async persistApplied(
    manifestId: string,
    evidence: { outputs: Record<string, unknown>; outputsHash: string; resourceCount: number; stateVersionId: string },
    safeCode?: string,
    reconciliation = false,
    recovery?: { intentId: string; leaseId: string; ownerWorkerId: string; fencingToken: string; planHash: string },
  ) {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const manifest = await this.lockManifest(manager, manifestId);
      if (manifest.status !== "applying" && !(reconciliation && manifest.status === "manual_review")) throw new Error("CANARY_APPLY_MANIFEST_CHANGED");
      if (recovery) {
        const rows = await manager.query(
          `SELECT child.id
             FROM deployment_intents child
             JOIN orchestration_outbox outbox ON outbox.intent_id = child.id AND outbox.event_type = 'intent.infrastructure.apply'
             JOIN deployment_side_effects original ON original.intent_id = child.id
               AND original.effect_type = 'infrastructure_terraform_apply'
            WHERE child.id = $1 AND child.infrastructure_manifest_id = $2
              AND child.status = 'failed' AND child.failure_code = 'INFRASTRUCTURE_APPLY_CONTEXT_INVALID'
              AND outbox.status = 'published' AND outbox.attempt_count = 1
              AND original.status = 'uncertain' AND original.reconciliation_required = true
              AND original.failure_code = 'SIDE_EFFECT_OUTCOME_UNKNOWN'
            FOR UPDATE`,
          [recovery.intentId, manifestId],
        );
        if (rows.length !== 1) throw new Error("NORMAL_INFRASTRUCTURE_APPLY_RECOVERY_EVIDENCE_CHANGED");
        const recoveryId = this.deterministicUuid(`managed-database-identity-reconciliation:${recovery.intentId}:${recovery.planHash}`);
        const recoveryLeaseId = this.deterministicUuid(`managed-database-identity-reconciliation-lease:${recovery.intentId}:${recovery.planHash}`);
        const ownershipRows = await manager.query(
          `SELECT 1 FROM project_release_lane_ownerships
            WHERE project_id = $1 AND environment_name = $2 AND owner_lane = 'v1'
              AND lease_id = $3 AND actor_id = $4 AND fencing_token = $5::bigint
              AND status IN ('acquired','heartbeat_active') AND expires_at > clock_timestamp()
            FOR UPDATE`,
          [manifest.projectId, manifest.environmentName, recovery.leaseId,
            recovery.ownerWorkerId, recovery.fencingToken],
        );
        if (ownershipRows.length !== 1) throw new Error("NORMAL_INFRASTRUCTURE_APPLY_RECOVERY_OWNERSHIP_LOST");
        const [tokenRow] = await manager.query(
          `SELECT COALESCE(MAX(fencing_token), 0)::bigint + 1 AS token
             FROM project_operation_leases
            WHERE project_id = $1 AND environment_name = $2`,
          [manifest.projectId, manifest.environmentName],
        );
        const operationFencingToken = String(tokenRow.token);
        await manager.query(
          `INSERT INTO project_operation_leases
             (id, project_id, environment_name, lane, scope, intent_id,
              pipeline_run_id, destroy_operation_id, owner_worker_id, fencing_token,
              status, acquired_at, heartbeat_at, expires_at, released_at, metadata,
              created_at, updated_at)
           VALUES ($1, $2, $3, 'infrastructure', 'apply', $4,
                   NULL, NULL, $5, $6::bigint, 'acquired', clock_timestamp(),
                   clock_timestamp(), clock_timestamp() + interval '5 minutes', NULL,
                   $7::jsonb, clock_timestamp(), clock_timestamp())`,
          [recoveryLeaseId, manifest.projectId, manifest.environmentName,
            recovery.intentId, recovery.ownerWorkerId, operationFencingToken,
            JSON.stringify({ operation: "managed_database_identity_reconciliation", manifestId })],
        );
        const idempotencyKey = canonicalSha256({
          operation: "managed_database_identity_reconciliation",
          intentId: recovery.intentId,
          manifestId,
          planHash: recovery.planHash,
          outputsHash: evidence.outputsHash,
          stateVersionId: evidence.stateVersionId,
        });
        await manager.query(
          `INSERT INTO deployment_side_effects
             (id, intent_id, project_id, environment_name, operation_id, effect_type,
              idempotency_key, request_fingerprint, lease_id, owner_worker_id, fencing_token,
              status, safe_result_code, result_fingerprint, reconciliation_required,
              attempt_started_at, completed_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $1,
                   'infrastructure_managed_database_identity_reconciliation', $5, $6,
                   $7, $8, $9::bigint, 'succeeded',
                   'MANAGED_DATABASE_IDENTITY_RECONCILED', $10, false,
                   clock_timestamp(), clock_timestamp(), clock_timestamp(), clock_timestamp())
           ON CONFLICT (intent_id, operation_id) DO NOTHING`,
          [recoveryId, recovery.intentId, manifest.projectId, manifest.environmentName,
            idempotencyKey, recovery.planHash, recoveryLeaseId, recovery.ownerWorkerId,
            operationFencingToken, evidence.outputsHash],
        );
        const recoveryRows = await manager.query(
          `SELECT id FROM deployment_side_effects
            WHERE id = $1 AND intent_id = $2
              AND effect_type = 'infrastructure_managed_database_identity_reconciliation'
              AND status = 'succeeded' AND safe_result_code = 'MANAGED_DATABASE_IDENTITY_RECONCILED'
              AND request_fingerprint = $3 AND result_fingerprint = $4
            FOR UPDATE`,
          [recoveryId, recovery.intentId, recovery.planHash, evidence.outputsHash],
        );
        if (recoveryRows.length !== 1) throw new Error("NORMAL_INFRASTRUCTURE_APPLY_RECOVERY_JOURNAL_CONFLICT");
        const releasedLease = await manager.query(
          `UPDATE project_operation_leases
              SET status = 'released', released_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE id = $1 AND owner_worker_id = $2 AND fencing_token = $3::bigint
              AND status = 'acquired' AND expires_at > clock_timestamp()
            RETURNING id`,
          [recoveryLeaseId, recovery.ownerWorkerId, operationFencingToken],
        );
        const releasedLeaseRows = Array.isArray(releasedLease) && releasedLease.length === 2
          && Array.isArray(releasedLease[0]) ? releasedLease[0] : releasedLease;
        if (!Array.isArray(releasedLeaseRows) || releasedLeaseRows.length !== 1) {
          throw new Error("NORMAL_INFRASTRUCTURE_APPLY_RECOVERY_LEASE_RELEASE_FAILED");
        }
      }
      if (this.isSecretAccessAddon(manifest)) {
        await this.supersedeSecretAccessParent(manager, manifest);
      }
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

  private async supersedeSecretAccessParent(
    manager: EntityManager,
    manifest: InfrastructureManifest,
  ) {
    const metadata = this.secretAccessMetadata(manifest);
    if (!manifest.parentManifestId) {
      throw new Error("CANARY_SECRET_ACCESS_PARENT_CHANGED");
    }
    const rows = this.rows<{ id: string }>(await manager.query(
      `SELECT id
         FROM infrastructure_manifests
        WHERE id = $1 AND project_id = $2 AND environment_name = $3
          AND status = 'applied' AND terraform_outputs_hash = $4
        FOR UPDATE`,
      [
        manifest.parentManifestId,
        manifest.projectId,
        manifest.environmentName,
        metadata.parentOutputsHash,
      ],
    ));
    if (rows.length !== 1) {
      throw new Error("CANARY_SECRET_ACCESS_PARENT_CHANGED");
    }
    const updated = this.rows<{ id: string }>(await manager.query(
      `UPDATE infrastructure_manifests
          SET status = 'superseded', updated_at = clock_timestamp()
        WHERE id = $1 AND status = 'applied'
        RETURNING id`,
      [manifest.parentManifestId],
    ));
    if (updated.length !== 1) {
      throw new Error("CANARY_SECRET_ACCESS_PARENT_CHANGED");
    }
  }

  private async acquireAddonApplyOperation(
    manifest: InfrastructureManifest,
    planHash: string,
    ownership: ReleaseLaneOwnershipSnapshot,
  ): Promise<AddonApplyOperation> {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const locked = await this.lockManifest(manager, manifest.id);
      const metadata = this.secretAccessMetadata(locked);
      const intentId = locked.createdByIntentId;
      if (!intentId) throw new Error("CANARY_SECRET_ACCESS_INTENT_MISSING");
      const intents = this.rows<{ id: string }>(await manager.query(
        `SELECT intent.id
           FROM deployment_intents intent
           JOIN orchestration_outbox outbox ON outbox.intent_id = intent.id
          WHERE intent.id = $1 AND intent.project_id = $2
            AND intent.environment_name = $3
            AND intent.kind = 'plan'
            AND intent.classification = 'infrastructure_change'
            AND intent.status = 'planned'
            AND intent.infrastructure_manifest_id = $4
            AND outbox.event_type = 'intent.infrastructure.plan'
            AND outbox.status = 'pending'
            AND outbox.attempt_count = 0
            AND outbox.published_at IS NULL
            AND outbox.published_job_id IS NULL
            AND outbox.claimed_by IS NULL
          FOR UPDATE OF intent, outbox`,
        [intentId, locked.projectId, locked.environmentName, locked.id],
      ));
      const owners = this.rows<{ fencingToken: string }>(await manager.query(
        `SELECT fencing_token::text AS "fencingToken"
           FROM project_release_lane_ownerships
          WHERE project_id = $1 AND environment_name = $2
            AND owner_lane = 'v1' AND lease_id = $3
            AND fencing_token = $4::bigint
            AND status IN ('acquired','heartbeat_active')
            AND expires_at > clock_timestamp()
          FOR UPDATE`,
        [locked.projectId, locked.environmentName, ownership.leaseId, ownership.fencingToken],
      ));
      if (intents.length !== 1 || owners.length !== 1
        || locked.status !== "planned" || locked.planArtifactSha256 !== planHash) {
        throw new Error("CANARY_SECRET_ACCESS_APPLY_FENCE_INVALID");
      }
      const leaseId = this.deterministicUuid(`iam-secret-access-apply-lease:${locked.id}:${planHash}`);
      const operationId = this.deterministicUuid(`iam-secret-access-apply-operation:${locked.id}:${planHash}`);
      const ownerWorkerId = `iam-secret-access-apply:${locked.id}`;
      const tokenRows = this.rows<{ token: string }>(await manager.query(
        `SELECT (COALESCE(MAX(fencing_token), 0) + 1)::text AS token
           FROM project_operation_leases
          WHERE project_id = $1 AND environment_name = $2`,
        [locked.projectId, locked.environmentName],
      ));
      const fencingToken = tokenRows[0]?.token;
      if (!fencingToken) throw new Error("CANARY_SECRET_ACCESS_APPLY_FENCE_INVALID");
      await manager.query(
        `INSERT INTO project_operation_leases
           (id, project_id, environment_name, lane, scope, intent_id,
            pipeline_run_id, destroy_operation_id, owner_worker_id,
            fencing_token, status, acquired_at, heartbeat_at, expires_at,
            released_at, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, 'infrastructure', 'apply', $4,
                 NULL, NULL, $5, $6::bigint, 'acquired',
                 clock_timestamp(), clock_timestamp(),
                 clock_timestamp() + interval '15 minutes', NULL,
                 $7::jsonb, clock_timestamp(), clock_timestamp())`,
        [
          leaseId, locked.projectId, locked.environmentName, intentId,
          ownerWorkerId, fencingToken,
          JSON.stringify({
            operation: "iam_secret_access_saved_plan_apply",
            manifestId: locked.id,
            planHash,
            referenceFingerprint: metadata.fingerprint,
          }),
        ],
      );
      const idempotencyKey = canonicalSha256({
        operation: "iam_secret_access_saved_plan_apply",
        manifestId: locked.id,
        planHash,
        referenceFingerprint: metadata.fingerprint,
      });
      await manager.query(
        `INSERT INTO deployment_side_effects
           (id, intent_id, project_id, environment_name, operation_id,
            effect_type, idempotency_key, request_fingerprint, lease_id,
            owner_worker_id, fencing_token, status, safe_result_code,
            result_fingerprint, external_reference_hash, failure_code,
            reconciliation_required, attempt_started_at, deadline_at,
            completed_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $1,
                 'infrastructure_terraform_apply', $5, $6, $7, $8,
                 $9::bigint, 'started', NULL, NULL, NULL, NULL, false,
                 clock_timestamp(), clock_timestamp() + interval '15 minutes',
                 NULL, clock_timestamp(), clock_timestamp())`,
        [
          operationId, intentId, locked.projectId, locked.environmentName,
          idempotencyKey, planHash, leaseId, ownerWorkerId, fencingToken,
        ],
      );
      return { intentId, leaseId, operationId, ownerWorkerId, fencingToken };
    });
  }

  private async finalizeAddonApplyOperation(
    manifest: InfrastructureManifest,
    planHash: string,
    operation: AddonApplyOperation,
    result: V1InfrastructureApplyResult,
  ) {
    await this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const rows = this.rows<{ id: string }>(await manager.query(
        `SELECT effect.id
           FROM deployment_side_effects effect
           JOIN project_operation_leases lease ON lease.id = effect.lease_id
          WHERE effect.id = $1 AND effect.intent_id = $2
            AND effect.effect_type = 'infrastructure_terraform_apply'
            AND effect.request_fingerprint = $3
            AND effect.status = 'started'
            AND lease.id = $4 AND lease.owner_worker_id = $5
            AND lease.fencing_token = $6::bigint
            AND lease.status IN ('acquired','heartbeat_active')
            AND lease.expires_at > clock_timestamp()
          FOR UPDATE OF effect, lease`,
        [
          operation.operationId, operation.intentId, planHash,
          operation.leaseId, operation.ownerWorkerId, operation.fencingToken,
        ],
      ));
      if (rows.length !== 1) throw new Error("CANARY_SECRET_ACCESS_APPLY_JOURNAL_CONFLICT");
      const persisted = await manager.getRepository(InfrastructureManifest).findOneByOrFail({ id: manifest.id });
      const succeeded = result.state === "applied" && persisted.status === "applied"
        && persisted.planArtifactSha256 === planHash
        && Boolean(persisted.terraformOutputsHash)
        && Boolean(persisted.stateVersionId);
      const status = succeeded ? "succeeded" : result.state === "uncertain" ? "uncertain" : "failed";
      const safeCode = succeeded
        ? "IAM_SECRET_ACCESS_PLAN_APPLIED_VERIFIED"
        : result.safeCodes[0] || "IAM_SECRET_ACCESS_PLAN_APPLY_FAILED";
      await manager.query(
        `UPDATE deployment_side_effects
            SET status = $2,
                safe_result_code = CASE WHEN $2 = 'succeeded' THEN $3 ELSE NULL END,
                result_fingerprint = CASE WHEN $2 = 'succeeded' THEN $4 ELSE NULL END,
                external_reference_hash = CASE WHEN $2 = 'succeeded' THEN $5 ELSE NULL END,
                failure_code = CASE WHEN $2 = 'succeeded' THEN NULL ELSE $3 END,
                reconciliation_required = ($2 = 'uncertain'),
                completed_at = CASE WHEN $2 = 'uncertain' THEN NULL ELSE clock_timestamp() END,
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [
          operation.operationId,
          status,
          safeCode,
          succeeded ? persisted.terraformOutputsHash : null,
          succeeded ? canonicalSha256({
            stateKey: persisted.stateKey,
            stateVersionId: persisted.stateVersionId,
          }) : null,
        ],
      );
      if (succeeded) {
        const transitioned = await this.terminalOutbox.transitionIntentToTerminal(manager, {
          intentId: operation.intentId,
          expectedStatus: "planned",
          status: "completed",
          failureCode: null,
          failureMessage: null,
        });
        if (!transitioned) throw new Error("CANARY_SECRET_ACCESS_INTENT_FINALIZATION_CONFLICT");
      }
      const released = this.rows<{ id: string }>(await manager.query(
        `UPDATE project_operation_leases
            SET status = 'released', released_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE id = $1 AND owner_worker_id = $2
            AND fencing_token = $3::bigint
            AND status IN ('acquired','heartbeat_active')
          RETURNING id`,
        [operation.leaseId, operation.ownerWorkerId, operation.fencingToken],
      ));
      if (released.length !== 1) throw new Error("CANARY_SECRET_ACCESS_APPLY_LEASE_RELEASE_FAILED");
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

  private rows<T>(result: unknown): T[] {
    if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) {
      return result[0] as T[];
    }
    return Array.isArray(result) ? result as T[] : [];
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

  private reconciliationSafeCode(error: unknown) {
    const code = error instanceof Error ? error.message : "";
    if (/^[A-Z0-9_]{3,128}$/.test(code)) return code;
    return [
      "CANARY_FOUNDATION_STATE_MISMATCH",
      "CANARY_FOUNDATION_OUTPUT_MISSING",
      "CANARY_FOUNDATION_LOG_GROUP_MISSING",
      "CANARY_MANAGED_DATABASE_SERVICE_MISSING",
      "CANARY_MANAGED_DATABASE_OUTPUT_CONTRACT_INVALID",
      "CANARY_RELEASE_RESOURCE_PRESENT",
      "CANARY_STATE_LOCK_NOT_RELEASED",
      "CANARY_STATE_VERSION_UNVERIFIED",
      "CANARY_AWS_READ_FAILED",
    ].includes(code) ? code : "TERRAFORM_APPLY_OUTCOME_UNCERTAIN";
  }

  private recoveryPersistenceSafeCode(error: unknown) {
    const message = error instanceof Error ? error.message : "";
    if (/^[A-Z0-9_]{3,128}$/.test(message)) return message;
    const sqlState = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code || "") : "";
    return /^[0-9A-Z]{5}$/.test(sqlState)
      ? `NORMAL_INFRASTRUCTURE_APPLY_RECOVERY_SQLSTATE_${sqlState}`
      : "NORMAL_INFRASTRUCTURE_APPLY_RECOVERY_PERSISTENCE_FAILED";
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

type TerraformStateResource = { mode?: "managed" | "data"; type?: string; values?: Record<string, unknown> };
type TerraformStateModule = { resources?: TerraformStateResource[]; child_modules?: TerraformStateModule[] };
