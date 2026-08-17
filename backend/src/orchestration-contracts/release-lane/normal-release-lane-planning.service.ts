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
import { resolveReleaseServiceArn } from "./release-service-lineage";
import { normalV1Activation, normalV1AllowsScope } from "./normal-v1-activation-policy";

const COMMIT = /^[0-9a-f]{40}$/i;

export type NormalReleaseLanePreparation =
  | { state: "disabled"; safeCodes: readonly ["NORMAL_RELEASE_LANE_PLANNING_DISABLED"]; fallbackToLegacy: false }
  | { state: "blocked"; safeCodes: readonly string[]; fallbackToLegacy: false }
  | {
    state: "no_op";
    safeCodes: readonly ["NORMAL_RELEASE_LANE_NO_OP"];
    fallbackToLegacy: false;
    stableRelease: { revision: string; sourceCommitShortSha: string };
  }
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
    if (gate === "blocked") return this.blocked("NORMAL_RELEASE_LANE_CONFIGURATION_INVALID");

    if (user.role !== UserRole.ADMIN && user.role !== UserRole.DEVELOPER) {
      return this.blocked("NORMAL_RELEASE_LANE_ACTOR_NOT_ALLOWED");
    }
    const project = await this.projectRepository.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found.");
    if (user.role !== UserRole.ADMIN && project.ownerUserId !== user.id) {
      throw new ForbiddenException("You do not have permission to prepare this project.");
    }
    if (project.environmentName !== "dev") {
      return this.blocked("NORMAL_RELEASE_LANE_PROJECT_INELIGIBLE");
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
      return this.blocked("NORMAL_RELEASE_LANE_CONTRACT_NOT_READY");
    }
    if (!COMMIT.test(contract.commitSha || "") || contract.commitSha !== contract.detectionSourceCommit) {
      return this.blocked("NORMAL_RELEASE_LANE_SOURCE_COMMIT_UNPROVEN");
    }
    if (!preflight
      || ![PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS]
        .includes(preflight.validationStatus as PreflightValidationStatus)
      || preflight.inputFingerprint !== contract.contractHash) {
      return this.blocked("NORMAL_RELEASE_LANE_PREFLIGHT_NOT_CURRENT");
    }
    const stableServiceArn = stable && applied
      ? await resolveReleaseServiceArn(
        stable,
        (releaseManifestId) => this.releases.findOne({
          where: {
            id: releaseManifestId,
            projectId: project.id,
            environmentName: "dev",
            infrastructureManifestId: applied.id,
          },
        }),
      )
      : null;
    if (!applied || !stable || stable.infrastructureManifestId !== applied.id
      || !stableServiceArn || !stable.taskDefinitionArn) {
      return this.blocked("NORMAL_RELEASE_LANE_PROJECT_INELIGIBLE");
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
        return this.blocked("NORMAL_RELEASE_LANE_IDEMPOTENCY_CONFLICT");
      }
      if (error instanceof PlannerClassificationNotAllowedError) {
        if (error.classification === "no_op") return {
          state: "no_op",
          safeCodes: ["NORMAL_RELEASE_LANE_NO_OP"],
          fallbackToLegacy: false,
          stableRelease: {
            revision: String(stable.revision),
            sourceCommitShortSha: stable.commitSha.slice(0, 12).toLowerCase(),
          },
        };
        return this.blocked("NORMAL_RELEASE_LANE_NOT_RELEASE_ONLY");
      }
      return this.blocked("NORMAL_RELEASE_LANE_PREPARATION_FAILED");
    }
  }

  private gate(projectId: string): "ready" | "disabled" | "blocked" {
    if (this.config.get<unknown>("TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED") !== "true") {
      return "disabled";
    }
    if (!normalV1Activation(this.config)) return "blocked";
    return normalV1AllowsScope(this.config, projectId, "dev") ? "ready" : "blocked";
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
    return { state: "disabled", safeCodes: ["NORMAL_RELEASE_LANE_PLANNING_DISABLED"], fallbackToLegacy: false };
  }

  private blocked(code: string): NormalReleaseLanePreparation {
    return { state: "blocked", safeCodes: [code], fallbackToLegacy: false };
  }
}
