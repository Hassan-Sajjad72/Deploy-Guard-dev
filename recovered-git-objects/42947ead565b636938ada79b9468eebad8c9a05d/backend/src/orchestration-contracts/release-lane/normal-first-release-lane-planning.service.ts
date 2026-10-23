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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  | { state: "disabled"; safeCodes: readonly ["NORMAL_FIRST_RELEASE_PLANNING_DISABLED"]; fallbackToLegacy: true }
  | { state: "blocked"; safeCodes: readonly string[]; fallbackToLegacy: boolean }
  | { state: "prepared"; safeCodes: readonly ["FIRST_RELEASE_INTENT_PREPARED"]; fallbackToLegacy: false; firstRelease: true; intent: { id: string; status: string; infrastructureManifestId: string | null; replayed: boolean } };

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
    if (applied || stable) return { state: "not_applicable" };
    if (!this.enabled(projectId)) return this.disabled();
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.DEVELOPER) return this.blocked("NORMAL_FIRST_RELEASE_ACTOR_NOT_ALLOWED", false);
    if (user.role !== UserRole.ADMIN && project.ownerUserId !== user.id) throw new ForbiddenException("You do not have permission to prepare this project.");
    if (project.environmentName !== "dev") return this.blocked("NORMAL_FIRST_RELEASE_PROJECT_INELIGIBLE", true);

    const [contract, preflight, legacy] = await Promise.all([
      this.contracts.findOne({ where: { projectId } }),
      this.preflights.findOne({ where: { projectId } }),
      this.pipelineRuns.findOne({ where: { projectId, status: In(ACTIVE_LEGACY) } }),
    ]);
    if (legacy) return this.blocked("NORMAL_FIRST_RELEASE_LEGACY_ACTIVITY_CONFLICT", true);
    if (!contract || !contract.deployable || contract.invalidatedAt || contract.invalidatedReason) return this.blocked("NORMAL_FIRST_RELEASE_CONTRACT_NOT_READY", true);
    if (!COMMIT.test(contract.commitSha || "") || contract.commitSha !== contract.detectionSourceCommit) return this.blocked("NORMAL_FIRST_RELEASE_SOURCE_COMMIT_UNPROVEN", true);
    if (!preflight || ![PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS].includes(preflight.validationStatus as PreflightValidationStatus) || preflight.inputFingerprint !== contract.contractHash) return this.blocked("NORMAL_FIRST_RELEASE_PREFLIGHT_NOT_CURRENT", true);

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
      return this.blocked("NORMAL_FIRST_RELEASE_IMMUTABLE_EVIDENCE_CONFLICT", false);
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
      if (!draft || result.intent.releaseManifestId || !result.intent.infrastructureManifestId) return this.blocked("NORMAL_FIRST_RELEASE_PLANNER_RESULT_INVALID", false);
      return this.prepared(result.intent, result.replayed);
    } catch (error) {
      if (error instanceof PlannerIdempotencyConflictError) return this.blocked("NORMAL_FIRST_RELEASE_IDEMPOTENCY_CONFLICT", false);
      if (error instanceof PlannerClassificationNotAllowedError) return this.blocked("NORMAL_FIRST_RELEASE_NOT_NEW_PROJECT", true);
      return this.blocked("NORMAL_FIRST_RELEASE_PREPARATION_FAILED", false);
    }
  }

  private enabled(projectId: string) {
    return this.config.get<unknown>("TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED") === "true"
      && this.config.get<unknown>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST") === projectId
      && this.config.get<unknown>("TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST") === "dev"
      && UUID.test(projectId);
  }
  private idempotency(projectId: string, commitSha: string, contractHash: string) {
    return `normal-first-release-plan:v1:${projectId}:dev:${commitSha}:${contractHash}`;
  }
  private prepared(intent: { id: string; status: string; infrastructureManifestId: string | null }, replayed: boolean): NormalFirstReleasePreparation {
    return { state: "prepared", safeCodes: ["FIRST_RELEASE_INTENT_PREPARED"], fallbackToLegacy: false, firstRelease: true, intent: { id: intent.id, status: intent.status, infrastructureManifestId: intent.infrastructureManifestId, replayed } };
  }
  private disabled(): NormalFirstReleasePreparation { return { state: "disabled", safeCodes: ["NORMAL_FIRST_RELEASE_PLANNING_DISABLED"], fallbackToLegacy: true }; }
  private blocked(code: string, fallbackToLegacy: boolean): NormalFirstReleasePreparation { return { state: "blocked", safeCodes: [code], fallbackToLegacy }; }
}
