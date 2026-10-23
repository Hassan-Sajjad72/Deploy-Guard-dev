import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User, UserRole } from "../../users/user.entity";
import { Project, ProjectVisibility } from "../../projects/project.entity";
import { DeploymentIntent } from "../entities/deployment-intent.entity";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { OrchestrationOutbox } from "../entities/orchestration-outbox.entity";
import { ReleaseManifest } from "../entities/release-manifest.entity";

export type NormalReleaseLaneEvent = {
  kind: "prepared" | "queued" | "running" | "completed" | "cancelled" | "blocked";
  code: string;
  occurredAt: string;
};

const RELEASE_LANE_EVENT_LIMIT = 4;
const RELEASE_LANE_EVENT_CODES = {
  prepared: "RELEASE_LANE_INTENT_PREPARED",
  queued: "RELEASE_LANE_INTENT_QUEUED",
  running: "RELEASE_LANE_INTENT_RUNNING",
  completed: "RELEASE_LANE_INTENT_COMPLETED",
  cancelled: "RELEASE_LANE_INTENT_CANCELLED",
} as const;

export type NormalReleaseLaneStatus =
  | { state: "disabled"; safeCodes: readonly ["NORMAL_RELEASE_LANE_STATUS_DISABLED"] }
  | { state: "missing"; safeCodes: readonly ["NORMAL_RELEASE_LANE_STATUS_MISSING"] }
  | {
    state: "prepared" | "queued" | "running" | "completed" | "cancelled" | "blocked";
    safeCodes: readonly string[];
    intent: {
      safeId: string;
      status: string;
      releaseManifestRevision: string | null;
      appliedInfrastructureRevision: string | null;
      outboxStatus: "pending" | "publishing" | "published" | "failed" | "dead_letter" | null;
      sourceCommitShortSha: string | null;
      lifecycleCode: string;
      lastMeaningfulAt: string;
      events: readonly NormalReleaseLaneEvent[];
    };
  };

/** Read-only normal UI projection. It intentionally has no execution dependencies. */
@Injectable()
export class NormalReleaseLaneStatusService {
  constructor(
    private readonly config: ConfigService,
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

  async get(user: User, projectId: string): Promise<NormalReleaseLaneStatus> {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found.");
    this.assertCanView(user, project);
    if (!this.enabled(projectId)) return { state: "disabled", safeCodes: ["NORMAL_RELEASE_LANE_STATUS_DISABLED"] };
    if (project.environmentName !== "dev") return { state: "missing", safeCodes: ["NORMAL_RELEASE_LANE_STATUS_MISSING"] };

    const intent = await this.intents.findOne({
      where: { projectId, environmentName: "dev", classification: "release_only" },
      order: { receivedAt: "DESC" },
    });
    if (!intent) return { state: "missing", safeCodes: ["NORMAL_RELEASE_LANE_STATUS_MISSING"] };

    const [release, applied, outbox] = await Promise.all([
      intent.releaseManifestId
        ? this.releases.findOne({ where: { id: intent.releaseManifestId, projectId, environmentName: "dev" } })
        : null,
      intent.infrastructureManifestId
        ? this.infrastructure.findOne({ where: { id: intent.infrastructureManifestId, projectId, environmentName: "dev", status: "applied" } })
        : null,
      this.outbox.findOne({ where: { intentId: intent.id }, order: { createdAt: "DESC" } }),
    ]);
    const state = this.state(intent.status, release, applied, outbox);
    return {
      state: state.value,
      safeCodes: [state.safeCode],
      intent: {
        safeId: intent.id.slice(0, 8),
        status: intent.status,
        releaseManifestRevision: release?.revision || null,
        appliedInfrastructureRevision: applied?.revision || null,
        outboxStatus: outbox?.status || null,
        sourceCommitShortSha: this.shortSha(release?.commitSha),
        lifecycleCode: state.safeCode,
        lastMeaningfulAt: this.lastMeaningfulAt(intent, release, outbox),
        events: this.events(intent, outbox, state.value, state.safeCode),
      },
    };
  }

  private enabled(projectId: string) {
    if (this.config.get<unknown>("TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED") !== "true") return false;
    const projects = this.config.get<unknown>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST");
    const environments = this.config.get<unknown>("TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST");
    if (typeof projects !== "string" || typeof environments !== "string") return false;
    const allowedProjects = projects.split(",").map((value) => value.trim()).filter(Boolean);
    const allowedEnvironments = environments.split(",").map((value) => value.trim()).filter(Boolean);
    return allowedProjects.length === 1
      && allowedProjects[0] === projectId
      && allowedEnvironments.length === 1
      && allowedEnvironments[0] === "dev";
  }

  private assertCanView(user: User, project: Project) {
    if (user.role === UserRole.ADMIN || project.ownerUserId === user.id) return;
    if (user.role === UserRole.READONLY && project.visibility === ProjectVisibility.WORKSPACE) return;
    throw new ForbiddenException("Insufficient permissions");
  }

  private state(
    status: string,
    release: ReleaseManifest | null,
    applied: InfrastructureManifest | null,
    outbox: OrchestrationOutbox | null,
  ): { value: Exclude<NormalReleaseLaneStatus["state"], "disabled" | "missing">; safeCode: string } {
    if (!applied || !release || release.infrastructureManifestId !== applied.id) {
      return { value: "blocked", safeCode: "NORMAL_RELEASE_LANE_STATUS_MALFORMED" };
    }
    if (status === "planned" && outbox?.status === "pending") return { value: "prepared", safeCode: "RELEASE_LANE_INTENT_PREPARED" };
    if (status === "enqueued" || outbox?.status === "publishing" || outbox?.status === "published") return { value: "queued", safeCode: "RELEASE_LANE_INTENT_QUEUED" };
    if (status === "running") return { value: "running", safeCode: "RELEASE_LANE_INTENT_RUNNING" };
    if (status === "completed") return { value: "completed", safeCode: "RELEASE_LANE_INTENT_COMPLETED" };
    if (status === "cancelled") return { value: "cancelled", safeCode: "RELEASE_LANE_INTENT_CANCELLED" };
    return { value: "blocked", safeCode: "NORMAL_RELEASE_LANE_STATUS_BLOCKED" };
  }

  private shortSha(value: string | null | undefined) {
    return typeof value === "string" && /^[a-f0-9]{7,64}$/i.test(value)
      ? value.slice(0, 12).toLowerCase()
      : null;
  }

  private events(
    intent: DeploymentIntent,
    outbox: OrchestrationOutbox | null,
    state: Exclude<NormalReleaseLaneStatus["state"], "disabled" | "missing">,
    lifecycleCode: string,
  ): readonly NormalReleaseLaneEvent[] {
    const events: Array<NormalReleaseLaneEvent & { order: number }> = [];
    const add = (kind: NormalReleaseLaneEvent["kind"], value: Date | null | undefined, order: number) => {
      const occurredAt = this.timestamp(value);
      if (occurredAt) {
        const code = kind === "blocked" ? lifecycleCode : RELEASE_LANE_EVENT_CODES[kind];
        events.push({ kind, code, occurredAt, order });
      }
    };

    add("prepared", intent.plannedAt || outbox?.createdAt || intent.receivedAt, 0);
    if (intent.enqueuedAt || intent.status === "enqueued" || ["publishing", "published"].includes(outbox?.status || "")) {
      add("queued", intent.enqueuedAt || outbox?.publishedAt || outbox?.updatedAt, 1);
    }
    if (intent.startedAt) add("running", intent.startedAt, 2);
    if (state === "completed" || state === "cancelled") add(state, intent.completedAt || intent.updatedAt, 3);
    if (state === "blocked" && ["failed", "rejected"].includes(intent.status)) {
      add("blocked", intent.completedAt || intent.updatedAt, 3);
    }

    return events
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.order - right.order)
      .slice(-RELEASE_LANE_EVENT_LIMIT)
      .map(({ kind, code, occurredAt }) => ({ kind, code, occurredAt }));
  }

  private timestamp(value: Date | null | undefined) {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
  }

  private lastMeaningfulAt(intent: DeploymentIntent, release: ReleaseManifest | null, outbox: OrchestrationOutbox | null) {
    const timestamps = [intent.updatedAt, release?.updatedAt, outbox?.updatedAt]
      .filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()))
      .map((value) => value.getTime());
    return new Date(Math.max(...timestamps)).toISOString();
  }
}
