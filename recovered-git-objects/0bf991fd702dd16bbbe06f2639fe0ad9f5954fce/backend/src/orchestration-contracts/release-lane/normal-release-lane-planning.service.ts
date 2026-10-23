import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User, UserRole } from "../../users/user.entity";
import { ProjectDeploymentContract } from "../../projects/project-deployment-contract.entity";
import {
  PreflightValidationStatus,
  ProjectPreflightReport,
} from "../../projects/project-preflight-report.entity";
import { Project } from "../../projects/project.entity";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { ReleaseManifest } from "../entities/release-manifest.entity";
import {
  PlannerClassificationNotAllowedError,
  PlannerIdempotencyConflictError,
} from "../planner/transactional-deployment-planner.types";
import { TransactionalDeploymentPlannerService } from "../planner/transactional-deployment-planner.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40}$/i;

export type NormalReleaseLanePreparation =
  | { state: "disabled"; safeCodes: readonly ["NORMAL_RELEASE_LANE_PLANNING_DISABLED"]; fallbackToLegacy: true }
  | { state: "blocked"; safeCodes: readonly string[]; fallbackToLegacy: boolean }
  | {
    state: "prepared";
    safeCodes: readonly ["RELEASE_LANE_INTENT_PREPARED"];
    fallbackToLegacy: false;
    intent: { id: string; status: string; releaseManifestId: string | null; replayed: boolean };
  };

/**
 * Default-off authenticated bridge from the normal project workflow to the
 * immutable v1 release-only planner. It deliberately has no dispatcher,
 * consumer, runner, ownership, queue, Docker, ECS, or Terraform dependency.
 */
@Injectable()
export class NormalReleaseLanePlanningService {
  constructor(
    private readonly config: ConfigService,
    private readonly planner: TransactionalDeploymentPlannerService,
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectDeploymentContract)
    private readonly contracts: Repository<ProjectDeploymentContract>,
    @InjectRepository(ProjectPreflightReport)
    private readonly preflights: Repository<ProjectPreflightReport>,
    @InjectRepository(InfrastructureManifest)
    private readonly infrastructure: Repository<InfrastructureManifest>,
    @InjectRepository(ReleaseManifest)
    private readonly releases: Repository<ReleaseManifest>,
  ) {}

  async prepare(user: User, projectId: string): Promise<NormalReleaseLanePreparation> {
    const gate = this.gate(projectId);
    if (gate === "disabled") return this.disabled();
    if (gate === "blocked") return this.blocked("NORMAL_RELEASE_LANE_CONFIGURATION_INVALID", true);

    if (user.role !== UserRole.ADMIN && user.role !== UserRole.DEVELOPER) {
      return this.blocked("NORMAL_RELEASE_LANE_ACTOR_NOT_ALLOWED", false);
    }
    const project = await this.projectRepository.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found.");
    if (user.role !== UserRole.ADMIN && project.ownerUserId !== user.id) {
      throw new ForbiddenException("You do not have permission to prepare this project.");
    }
    if (project.environmentName !== "dev") {
      return this.blocked("NORMAL_RELEASE_LANE_PROJECT_INELIGIBLE", true);
    }

    const [contract, preflight, applied, stable] = await Promise.all([
      this.contracts.findOne({ where: { projectId: project.id } }),
      this.preflights.findOne({ where: { projectId: project.id } }),
      this.infrastructure.findOne({
        where: { projectId: project.id, environmentName: "dev", status: "applied" },
        order: { createdAt: "DESC" },
      }),
      this.releases.findOne({
        where: { projectId: project.id, environmentName: "dev", status: "stable" },
        order: { createdAt: "DESC" },
      }),
    ]);

    if (!contract || !contract.deployable || contract.invalidatedAt || contract.invalidatedReason) {
      return this.blocked("NORMAL_RELEASE_LANE_CONTRACT_NOT_READY", true);
    }
    if (!COMMIT.test(contract.commitSha || "") || contract.commitSha !== contract.detectionSourceCommit) {
      return this.blocked("NORMAL_RELEASE_LANE_SOURCE_COMMIT_UNPROVEN", true);
    }
    if (!preflight
      || ![PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS]
        .includes(preflight.validationStatus as PreflightValidationStatus)
      || preflight.inputFingerprint !== contract.contractHash) {
      return this.blocked("NORMAL_RELEASE_LANE_PREFLIGHT_NOT_CURRENT", true);
    }
    if (!applied || !stable || stable.infrastructureManifestId !== applied.id
      || !stable.initialServiceArn || !stable.taskDefinitionArn) {
      return this.blocked("NORMAL_RELEASE_LANE_PROJECT_INELIGIBLE", true);
    }

    try {
      const result = await this.planner.plan({
        actor: {
          userId: user.id,
          role: user.role === UserRole.ADMIN ? "admin" : "developer",
        },
        projectId: project.id,
        environmentName: "dev",
        kind: "deploy",
        idempotencyKey: this.idempotencyKey(
          project.id,
          applied.id,
          stable.id,
          contract.commitSha,
          contract.contractHash,
        ),
        requestedCommitSha: contract.commitSha,
        requiredClassification: "release_only",
      });
      return {
        state: "prepared",
        safeCodes: ["RELEASE_LANE_INTENT_PREPARED"],
        fallbackToLegacy: false,
        intent: {
          id: result.intent.id,
          status: result.intent.status,
          releaseManifestId: result.intent.releaseManifestId,
          replayed: result.replayed,
        },
      };
    } catch (error) {
      if (error instanceof PlannerIdempotencyConflictError) {
        return this.blocked("NORMAL_RELEASE_LANE_IDEMPOTENCY_CONFLICT", false);
      }
      if (error instanceof PlannerClassificationNotAllowedError) {
        return this.blocked("NORMAL_RELEASE_LANE_NOT_RELEASE_ONLY", true);
      }
      return this.blocked("NORMAL_RELEASE_LANE_PREPARATION_FAILED", false);
    }
  }

  private gate(projectId: string): "ready" | "disabled" | "blocked" {
    if (this.config.get<unknown>("TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED") !== "true") {
      return "disabled";
    }
    const projects = this.config.get<unknown>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST");
    if (typeof projects !== "string") return "blocked";
    const allowlist = projects.split(",").map((value) => value.trim()).filter(Boolean);
    if (allowlist.length !== 1 || !UUID.test(allowlist[0]) || allowlist[0] !== projectId) return "blocked";
    return this.config.get<unknown>("TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST") === "dev"
      ? "ready"
      : "blocked";
  }

  private idempotencyKey(
    projectId: string,
    infrastructureManifestId: string,
    stableReleaseManifestId: string,
    commitSha: string,
    contractHash: string,
  ) {
    // A new pinned source commit or refreshed immutable contract is a distinct
    // planning request. Leaving either out would replay a completed release
    // intent for an older source revision.
    return `normal-release-plan:v1:${projectId}:dev:${infrastructureManifestId}:${stableReleaseManifestId}:${commitSha}:${contractHash}`;
  }

  private disabled(): NormalReleaseLanePreparation {
    return { state: "disabled", safeCodes: ["NORMAL_RELEASE_LANE_PLANNING_DISABLED"], fallbackToLegacy: true };
  }

  private blocked(code: string, fallbackToLegacy: boolean): NormalReleaseLanePreparation {
    return { state: "blocked", safeCodes: [code], fallbackToLegacy };
  }
}
