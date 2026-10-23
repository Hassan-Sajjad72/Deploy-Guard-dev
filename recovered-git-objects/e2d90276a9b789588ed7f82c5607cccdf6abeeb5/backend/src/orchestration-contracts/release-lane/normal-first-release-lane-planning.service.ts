import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { User, UserRole } from "../../users/user.entity";
import { Project } from "../../projects/project.entity";
import { ProjectDeploymentContract } from "../../projects/project-deployment-contract.entity";
import { PreflightValidationStatus, ProjectPreflightReport } from "../../projects/project-preflight-report.entity";
import { ProjectPipelineRun } from "../../projects/project-pipeline-run.entity";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { ReleaseManifest } from "../entities/release-manifest.entity";
import { DeploymentIntent } from "../entities/deployment-intent.entity";
import { InitialReleaseDraft } from "../entities/initial-release-draft.entity";
import { PlannerClassificationNotAllowedError, PlannerIdempotencyConflictError } from "../planner/transactional-deployment-planner.types";
import { TransactionalDeploymentPlannerService } from "../planner/transactional-deployment-planner.service";
import { normalV1AllowsScope } from "./normal-v1-activation-policy";

const COMMIT = /^[0-9a-f]{40}$/i;
const ACTIVE_LEGACY = [
  "queued", "running", "cost_analysis_running", "waiting_for_cost_approval",
  "state_lock_acquiring", "waiting_for_state_lock", "state_lock_acquired",
  "state_heartbeat_active", "state_validation_running", "storage_evaluation_running",
  "storage_provisioning", "ecs_deployment_queued", "ecs_task_definition_registering",
  "ecs_service_updating", "ecs_waiting_for_stability", "rollback_started",
];

export type NormalFirstReleasePreparation =
  | { state: "not_applicable" }
  | { state: "disabled"; safeCodes: readonly ["NORMAL_FIRST_RELEASE_PLANNING_DISABLED"]; fallbackToLegacy: false }
  | { state: "blocked"; safeCodes: readonly string[]; fallbackToLegacy: false }
  | { state: "prepared"; safeCodes: readonly ["FIRST_RELEASE_INTENT_PREPARED"]; fallbackToLegacy: false; firstRelease: true; intent: { id: string; safeId: string; status: string; replayed: boolean; nextBoundary: "infrastructure_plan" | "release" } };

/**
 * Default-off normal-workflow bridge for a genuinely new foundation. It uses
 * the transactional planner's existing initial-draft contract and intentionally
 * does not import Terraform, a dispatcher, a consumer, or an executor.
 */
@Injectable()
export class NormalFirstReleaseLanePlanningService {
  constructor(
    private readonly config: ConfigService,
    private readonly planner: TransactionalDeploymentPlannerService,
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(ProjectDeploymentContract) private readonly contracts: Repository<ProjectDeploymentContract>,
    @InjectRepository(ProjectPreflightReport) private readonly preflights: Repository<ProjectPreflightReport>,
    @InjectRepository(ProjectPipelineRun) private readonly pipelineRuns: Repository<ProjectPipelineRun>,
    @InjectRepository(InfrastructureManifest) private readonly infrastructure: Repository<InfrastructureManifest>,
    @InjectRepository(ReleaseManifest) private readonly releases: Repository<ReleaseManifest>,
    @InjectRepository(DeploymentIntent) private readonly intents: Repository<DeploymentIntent>,
    @InjectRepository(InitialReleaseDraft) private readonly drafts: Repository<InitialReleaseDraft>,
  ) {}

  async prepare(user: User, projectId: string): Promise<NormalFirstReleasePreparation> {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found.");
    const [applied, stable] = await Promise.all([
      this.infrastructure.findOne({ where: { projectId, environmentName: "dev", status: "applied" } }),
      this.releases.findOne({ where: { projectId, environmentName: "dev", status: "stable" } }),
    ]);
    if (stable) return { state: "not_applicable" };
    // An applied foundation is deliberately invisible to the original new-
    // foundation bridge unless the separate managed-first-release gate is set.
    // This preserves the legacy fallback and the existing stateless behavior.
    if (applied && this.config.get<unknown>("TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_PLANNING_ENABLED") !== "true") {
      return { state: "not_applicable" };
    }
    if (!this.enabled(projectId)) return this.disabled();
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.DEVELOPER) return this.blocked("NORMAL_FIRST_RELEASE_ACTOR_NOT_ALLOWED");
    if (user.role !== UserRole.ADMIN && project.ownerUserId !== user.id) throw new ForbiddenException("You do not have permission to prepare this project.");
    if (project.environmentName !== "dev") return this.blocked("NORMAL_FIRST_RELEASE_PROJECT_INELIGIBLE");

    const [contract, preflight, legacy] = await Promise.all([
      this.contracts.findOne({ where: { projectId } }),
      this.preflights.findOne({ where: { projectId } }),
      this.pipelineRuns.findOne({ where: { projectId, status: In(ACTIVE_LEGACY) } }),
    ]);
    if (legacy) return this.blocked("NORMAL_FIRST_RELEASE_LEGACY_ACTIVITY_CONFLICT");
    if (!contract || !contract.deployable || contract.invalidatedAt || contract.invalidatedReason) return this.blocked("NORMAL_FIRST_RELEASE_CONTRACT_NOT_READY");
    if (!COMMIT.test(contract.commitSha || "") || contract.commitSha !== contract.detectionSourceCommit) return this.blocked("NORMAL_FIRST_RELEASE_SOURCE_COMMIT_UNPROVEN");
    if (!preflight || ![PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS].includes(preflight.validationStatus as PreflightValidationStatus) || preflight.inputFingerprint !== contract.contractHash) return this.blocked("NORMAL_FIRST_RELEASE_PREFLIGHT_NOT_CURRENT");

    if (applied) return this.prepareAppliedFoundation(user, project, applied, contract, preflight);

    const existing = await this.intents.findOne({
      where: { projectId, environmentName: "dev", status: In(["planned", "enqueued", "running"]) },
      order: { receivedAt: "DESC" },
    });
    if (existing) {
      const draft = await this.drafts.findOne({ where: { intentId: existing.id, projectId, environmentName: "dev" } });
      const source = draft?.releaseDraft;
      if (existing.classification === "infrastructure_change" && source?.commitSha === contract.commitSha && source.deploymentContractHash === contract.contractHash) {
        return this.prepared(existing, true);
      }
      return this.blocked("NORMAL_FIRST_RELEASE_IMMUTABLE_EVIDENCE_CONFLICT");
    }

    try {
      const result = await this.planner.plan({
        actor: { userId: user.id, role: user.role === UserRole.ADMIN ? "admin" : "developer" },
        projectId,
        environmentName: "dev",
        kind: "deploy",
        idempotencyKey: this.idempotency(projectId, contract.commitSha, contract.contractHash),
        requestedCommitSha: contract.commitSha,
        requiredClassification: "infrastructure_change",
      });
      const draft = await this.drafts.findOne({ where: { intentId: result.intent.id, projectId, environmentName: "dev" } });
      if (!draft || result.intent.releaseManifestId || !result.intent.infrastructureManifestId) return this.blocked("NORMAL_FIRST_RELEASE_PLANNER_RESULT_INVALID");
      return this.prepared(result.intent, result.replayed);
    } catch (error) {
      if (error instanceof PlannerIdempotencyConflictError) return this.blocked("NORMAL_FIRST_RELEASE_IDEMPOTENCY_CONFLICT");
      if (error instanceof PlannerClassificationNotAllowedError) return this.blocked("NORMAL_FIRST_RELEASE_NOT_NEW_PROJECT");
      return this.blocked("NORMAL_FIRST_RELEASE_PREPARATION_FAILED");
    }
  }

  private async prepareAppliedFoundation(
    user: User,
    project: Project,
    applied: InfrastructureManifest,
    contract: ProjectDeploymentContract,
    preflight: ProjectPreflightReport,
  ): Promise<NormalFirstReleasePreparation> {
    if (this.config.get<unknown>("TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_PLANNING_ENABLED") !== "true") {
      return this.disabled();
    }
    if (!/^[0-9a-f]{64}$/.test(applied.terraformOutputsHash || "")) {
      return this.blocked("NORMAL_MANAGED_FIRST_RELEASE_INFRASTRUCTURE_HASH_INVALID");
    }
    const draft = await this.drafts.findOne({
      where: { projectId: project.id, environmentName: "dev", infrastructureManifestId: applied.id },
      order: { createdAt: "ASC" },
    });
    const releaseDraft = draft?.releaseDraft as { commitSha?: string; deploymentContractHash?: string } | undefined;
    if (!draft || !releaseDraft || releaseDraft.commitSha !== contract.commitSha
      || releaseDraft.deploymentContractHash !== contract.contractHash) {
      return this.blocked("NORMAL_MANAGED_FIRST_RELEASE_DRAFT_INVALID");
    }
    try {
      const result = await this.planner.plan({
        actor: { userId: user.id, role: user.role === UserRole.ADMIN ? "admin" : "developer" },
        projectId: project.id,
        environmentName: "dev",
        kind: "deploy",
        idempotencyKey: `normal-managed-first-release:v1:${project.id}:dev:${contract.commitSha}:${applied.terraformOutputsHash}:${draft.draftHash}`,
        requestedCommitSha: contract.commitSha,
        initialReleaseDraftId: draft.id,
        requiredClassification: "release_only",
      });
      if (!result.intent.releaseManifestId || result.intent.infrastructureManifestId !== applied.id) {
        return this.blocked("NORMAL_MANAGED_FIRST_RELEASE_PLANNER_RESULT_INVALID");
      }
      return this.prepared(result.intent, result.replayed);
    } catch (error) {
      if (error instanceof PlannerIdempotencyConflictError) return this.blocked("NORMAL_MANAGED_FIRST_RELEASE_IDEMPOTENCY_CONFLICT");
      if (error instanceof PlannerClassificationNotAllowedError) return this.blocked("NORMAL_MANAGED_FIRST_RELEASE_NOT_RELEASE_ONLY");
      if (error instanceof Error
        && ["INITIAL_RELEASE_DRAFT_IDENTITY_INVALID", "INITIAL_RELEASE_DRAFT_FOUNDATION_INVALID"]
          .includes(error.message)) {
        return this.blocked("NORMAL_MANAGED_FIRST_RELEASE_IMMUTABLE_EVIDENCE_CONFLICT");
      }
      return this.blocked("NORMAL_MANAGED_FIRST_RELEASE_PREPARATION_FAILED");
    }
  }

  private enabled(projectId: string) {
    return this.config.get<unknown>("TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED") === "true"
      && normalV1AllowsScope(this.config, projectId, "dev");
  }
  private idempotency(projectId: string, commitSha: string, contractHash: string) {
    return `normal-first-release-plan:v1:${projectId}:dev:${commitSha}:${contractHash}`;
  }
  private prepared(intent: { id: string; status: string; infrastructureManifestId: string | null; releaseManifestId: string | null }, replayed: boolean): NormalFirstReleasePreparation {
    return { state: "prepared", safeCodes: ["FIRST_RELEASE_INTENT_PREPARED"], fallbackToLegacy: false, firstRelease: true, intent: { id: intent.id, safeId: intent.id.slice(0, 8), status: intent.status, replayed, nextBoundary: intent.releaseManifestId ? "release" : "infrastructure_plan" } };
  }
  private disabled(): NormalFirstReleasePreparation { return { state: "disabled", safeCodes: ["NORMAL_FIRST_RELEASE_PLANNING_DISABLED"], fallbackToLegacy: false }; }
  private blocked(code: string): NormalFirstReleasePreparation { return { state: "blocked", safeCodes: [code], fallbackToLegacy: false }; }
}
