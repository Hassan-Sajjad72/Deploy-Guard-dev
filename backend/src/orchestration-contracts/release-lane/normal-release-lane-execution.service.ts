import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User, UserRole } from "../../users/user.entity";
import { Project } from "../../projects/project.entity";
import { DeploymentIntent } from "../entities/deployment-intent.entity";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { OrchestrationOutbox } from "../entities/orchestration-outbox.entity";
import { ReleaseManifest } from "../entities/release-manifest.entity";
import { DurableOutboxDispatcherService } from "../outbox/durable-outbox-dispatcher.service";
import { normalV1Activation, normalV1AllowsScope } from "./normal-v1-activation-policy";

export type NormalReleaseLaneExecution =
  | {
    state: "disabled";
    safeCodes: readonly ["NORMAL_RELEASE_LANE_EXECUTION_DISABLED"];
    fallbackToLegacy: false;
  }
  | {
    state: "blocked";
    safeCodes: readonly string[];
    fallbackToLegacy: false;
  }
  | {
    state: "dispatched";
    safeCodes: readonly ["RELEASE_LANE_OUTBOX_DISPATCHED"];
    fallbackToLegacy: false;
  };

/**
 * Default-off authenticated activation boundary for a single, already planned
 * v1 release-only intent. It only requests canonical outbox delivery; it never
 * starts a consumer, invokes a one-shot runner, or reaches an external client.
 */
@Injectable()
export class NormalReleaseLaneExecutionService {
  constructor(
    private readonly config: ConfigService,
    private readonly dispatcher: DurableOutboxDispatcherService,
    @InjectRepository(Project)
    private readonly projects: Repository<Project>,
    @InjectRepository(DeploymentIntent)
    private readonly intents: Repository<DeploymentIntent>,
    @InjectRepository(ReleaseManifest)
    private readonly releases: Repository<ReleaseManifest>,
    @InjectRepository(InfrastructureManifest)
    private readonly infrastructure: Repository<InfrastructureManifest>,
    @InjectRepository(OrchestrationOutbox)
    private readonly outbox: Repository<OrchestrationOutbox>,
  ) {}

  async dispatch(user: User, projectId: string): Promise<NormalReleaseLaneExecution> {
    const gate = this.gate(projectId);
    if (gate === "disabled") return this.disabled();
    if (gate === "blocked") {
      return this.blocked("NORMAL_RELEASE_LANE_CONFIGURATION_INVALID");
    }
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.DEVELOPER) {
      return this.blocked("NORMAL_RELEASE_LANE_ACTOR_NOT_ALLOWED");
    }

    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found.");
    if (user.role !== UserRole.ADMIN && project.ownerUserId !== user.id) {
      throw new ForbiddenException("You do not have permission to execute this project.");
    }
    if (project.environmentName !== "dev") {
      return this.blocked("NORMAL_RELEASE_LANE_PROJECT_INELIGIBLE");
    }

    const candidates = await this.intents.find({
      where: {
        projectId,
        environmentName: "dev",
        classification: "release_only",
        status: "planned",
      },
      order: { receivedAt: "DESC" },
    });
    if (candidates.length !== 1) {
      return this.blocked("NORMAL_RELEASE_LANE_PREPARED_INTENT_NOT_UNIQUE");
    }
    const intent = candidates[0];
    if (!intent.releaseManifestId || !intent.infrastructureManifestId) {
      return this.blocked("NORMAL_RELEASE_LANE_PREPARED_EVIDENCE_MALFORMED");
    }

    const [release, applied, outboxes] = await Promise.all([
      this.releases.findOne({
        where: {
          id: intent.releaseManifestId,
          projectId,
          environmentName: "dev",
          status: "desired",
        },
      }),
      this.infrastructure.findOne({
        where: {
          id: intent.infrastructureManifestId,
          projectId,
          environmentName: "dev",
          status: "applied",
        },
      }),
      this.outbox.find({ where: { intentId: intent.id }, order: { createdAt: "ASC" } }),
    ]);
    if (!release
      || release.createdByIntentId !== intent.id
      || release.infrastructureManifestId !== intent.infrastructureManifestId
      || !applied) {
      return this.blocked("NORMAL_RELEASE_LANE_PREPARED_EVIDENCE_MALFORMED");
    }
    if (release.parentManifestId === null
      && release.previousStableManifestId === null
      && this.config.get<unknown>(
        "TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_EXECUTION_ENABLED",
      ) !== "true") {
      return this.blocked(
        "NORMAL_MANAGED_FIRST_RELEASE_EXECUTION_DISABLED",
      );
    }
    if (outboxes.length !== 1) {
      return this.blocked("NORMAL_RELEASE_LANE_OUTBOX_NOT_DISPATCHABLE");
    }
    const outbox = outboxes[0];
    if (outbox.status !== "pending"
      || outbox.attemptCount !== 0
      || outbox.publishedAt
      || outbox.publishedJobId
      || outbox.claimedBy
      || outbox.claimExpiresAt) {
      return this.blocked("NORMAL_RELEASE_LANE_OUTBOX_NOT_DISPATCHABLE");
    }

    const result = await this.dispatcher.dispatchExact({
      outboxId: outbox.id,
      intentId: intent.id,
      projectId,
      environmentName: "dev",
    });
    if (result.status === "published") {
      return {
        state: "dispatched",
        safeCodes: ["RELEASE_LANE_OUTBOX_DISPATCHED"],
        fallbackToLegacy: false,
      };
    }
    if (result.status === "blocked") {
      return this.blocked(result.reason);
    }
    if (result.status === "dead_letter") {
      return this.blocked("NORMAL_RELEASE_LANE_OUTBOX_NOT_DISPATCHABLE");
    }
    return this.blocked("NORMAL_RELEASE_LANE_OUTBOX_DISPATCH_UNAVAILABLE");
  }

  private gate(projectId: string): "ready" | "disabled" | "blocked" {
    if (this.config.get<unknown>("TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED") !== "true") {
      return "disabled";
    }
    if (!normalV1Activation(this.config)) return "blocked";
    return normalV1AllowsScope(this.config, projectId, "dev") ? "ready" : "blocked";
  }

  private disabled(): NormalReleaseLaneExecution {
    return {
      state: "disabled",
      safeCodes: ["NORMAL_RELEASE_LANE_EXECUTION_DISABLED"],
      fallbackToLegacy: false,
    };
  }

  private blocked(code: string): NormalReleaseLaneExecution {
    return { state: "blocked", safeCodes: [code], fallbackToLegacy: false };
  }
}
