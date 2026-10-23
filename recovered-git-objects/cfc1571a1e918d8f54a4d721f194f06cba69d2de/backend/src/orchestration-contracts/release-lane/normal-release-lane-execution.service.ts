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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NormalReleaseLaneExecution =
  | {
    state: "disabled";
    safeCodes: readonly ["NORMAL_RELEASE_LANE_EXECUTION_DISABLED"];
    fallbackToLegacy: true;
  }
  | {
    state: "blocked";
    safeCodes: readonly string[];
    fallbackToLegacy: boolean;
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
    if (gate === "blocked") return this.blocked("NORMAL_RELEASE_LANE_CONFIGURATION_INVALID", true);
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.DEVELOPER) {
      return this.blocked("NORMAL_RELEASE_LANE_ACTOR_NOT_ALLOWED", false);
    }

    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found.");
    if (user.role !== UserRole.ADMIN && project.ownerUserId !== user.id) {
      throw new ForbiddenException("You do not have permission to execute this project.");
    }
    if (project.environmentName !== "dev") {
      return this.blocked("NORMAL_RELEASE_LANE_PROJECT_INELIGIBLE", true);
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
      return this.blocked("NORMAL_RELEASE_LANE_PREPARED_INTENT_NOT_UNIQUE", true);
    }
    const intent = candidates[0];
    if (!intent.releaseManifestId || !intent.infrastructureManifestId) {
      return this.blocked("NORMAL_RELEASE_LANE_PREPARED_EVIDENCE_MALFORMED", false);
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
      return this.blocked("NORMAL_RELEASE_LANE_PREPARED_EVIDENCE_MALFORMED", false);
    }
    if (outboxes.length !== 1) {
      return this.blocked("NORMAL_RELEASE_LANE_OUTBOX_NOT_DISPATCHABLE", false);
    }
    const outbox = outboxes[0];
    if (outbox.status !== "pending"
      || outbox.attemptCount !== 0
      || outbox.publishedAt
      || outbox.publishedJobId
      || outbox.claimedBy
      || outbox.claimExpiresAt) {
      return this.blocked("NORMAL_RELEASE_LANE_OUTBOX_NOT_DISPATCHABLE", false);
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
      return this.blocked(result.reason, false);
    }
    if (result.status === "dead_letter") {
      return this.blocked("NORMAL_RELEASE_LANE_OUTBOX_NOT_DISPATCHABLE", false);
    }
    return this.blocked("NORMAL_RELEASE_LANE_OUTBOX_DISPATCH_UNAVAILABLE", false);
  }

  private gate(projectId: string): "ready" | "disabled" | "blocked" {
    if (this.config.get<unknown>("TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED") !== "true") {
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

  private disabled(): NormalReleaseLaneExecution {
    return {
      state: "disabled",
      safeCodes: ["NORMAL_RELEASE_LANE_EXECUTION_DISABLED"],
      fallbackToLegacy: true,
    };
  }

  private blocked(code: string, fallbackToLegacy: boolean): NormalReleaseLaneExecution {
    return { state: "blocked", safeCodes: [code], fallbackToLegacy };
  }
}
