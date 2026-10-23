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
import { InitialReleaseDraft } from "../entities/initial-release-draft.entity";
import { ProjectDeployment } from "../../orchestration/project-deployment.entity";
import { canonicalSha256 } from "../contracts/canonical-json";

export type NormalReleaseLaneEvent = {
  kind: "prepared" | "queued" | "running" | "completed" | "cancelled" | "blocked";
  code: string;
  occurredAt: string;
};

export type NormalReleaseLaneStableRelease = {
  revision: string;
  sourceCommitShortSha: string;
  status: "stable";
  promotedAt: string;
  url: string | null;
  rollbackLineage: {
    revision: string;
    sourceCommitShortSha: string;
    status: "rollback_eligible";
  } | null;
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
    state: "prepared" | "queued" | "running" | "reconciling" | "completed" | "cancelled" | "blocked";
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
      history: readonly NormalReleaseLaneEvent[];
      firstRelease: boolean;
      infrastructurePlanning: {
        planState: "prepared" | "completed" | "blocked";
        applyState: "not_ready" | "awaiting_approval" | "queued" | "running" | "applied" | "blocked";
        planOutboxStatus: "pending" | "publishing" | "published" | "failed" | "dead_letter" | null;
        applyOutboxStatus: "pending" | null;
      } | null;
    };
    stableRelease: NormalReleaseLaneStableRelease | null;
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
    @InjectRepository(ProjectDeployment)
    private readonly deployments: Repository<ProjectDeployment>,
    @InjectRepository(InitialReleaseDraft)
    private readonly drafts?: Repository<InitialReleaseDraft>,
  ) {}

  async get(user: User, projectId: string): Promise<NormalReleaseLaneStatus> {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found.");
    this.assertCanView(user, project);
    if (!this.enabled(projectId)) return { state: "disabled", safeCodes: ["NORMAL_RELEASE_LANE_STATUS_DISABLED"] };
    if (project.environmentName !== "dev") return { state: "missing", safeCodes: ["NORMAL_RELEASE_LANE_STATUS_MISSING"] };

    let intent = await this.intents.findOne({
      where: { projectId, environmentName: "dev", classification: "release_only" },
      order: { receivedAt: "DESC" },
    });
    let initialDraft: InitialReleaseDraft | null = null;
    let applyContinuation: DeploymentIntent | null = null;
    let continuationConflict = false;
    if (!intent && this.firstReleaseEnabled(projectId)) {
      initialDraft = await this.drafts?.findOne({ where: { projectId, environmentName: "dev" }, order: { createdAt: "DESC" } }) || null;
      if (initialDraft) {
        intent = await this.intents.findOne({ where: { id: initialDraft.intentId, projectId, environmentName: "dev", classification: "infrastructure_change" } });
        if (intent?.status === "plan_completed") {
          const candidates = await this.intents.find({
            where: {
              projectId,
              environmentName: "dev",
              kind: "apply",
              classification: "infrastructure_change",
            },
            order: { createdAt: "DESC" },
            take: 16,
          });
          const matches = candidates.filter(
            (candidate) =>
              candidate.requestPayload?.operation
                === "infrastructure_apply_continuation"
              && candidate.requestPayload?.parentPlanIntentId === intent?.id,
          );
          continuationConflict = matches.length !== 1;
          applyContinuation = matches.length === 1 ? matches[0] : null;
        }
      }
    }
    if (!intent) return { state: "missing", safeCodes: ["NORMAL_RELEASE_LANE_STATUS_MISSING"] };

    const [release, applied, planOutbox, applyOutbox, stable] = await Promise.all([
      intent.releaseManifestId
        ? this.releases.findOne({ where: { id: intent.releaseManifestId, projectId, environmentName: "dev" } })
        : null,
      intent.infrastructureManifestId
        ? this.infrastructure.findOne({
          where: initialDraft
            ? { id: intent.infrastructureManifestId, projectId, environmentName: "dev" }
            : { id: intent.infrastructureManifestId, projectId, environmentName: "dev", status: "applied" },
        })
        : null,
      this.outbox.findOne({ where: { intentId: intent.id }, order: { createdAt: "DESC" } }),
      applyContinuation
        ? this.outbox.findOne({
          where: {
            intentId: applyContinuation.id,
            eventType: "intent.infrastructure.apply",
          },
          order: { createdAt: "DESC" },
        })
        : null,
      this.releases.findOne({
        where: { projectId, environmentName: "dev", status: "stable" },
        order: { promotedAt: "DESC" },
      }),
    ]);
    const [rollback, deployment] = await Promise.all([
      stable?.previousStableManifestId
        ? this.releases.findOne({
          where: { id: stable.previousStableManifestId, projectId, environmentName: "dev" },
        })
        : null,
      stable
        ? this.deployments.findOne({
          where: { projectId, environmentName: "dev" },
          order: { updatedAt: "DESC" },
        })
        : null,
    ]);
    const stableRelease = this.stableRelease(stable, rollback, deployment, applied);
    const state = stableRelease.conflict
      ? { value: "blocked" as const, safeCode: "NORMAL_RELEASE_LANE_STABLE_IDENTITY_CONFLICT" }
      : continuationConflict
        ? { value: "blocked" as const, safeCode: "NORMAL_FIRST_RELEASE_APPLY_CONTINUATION_CONFLICT" }
        : this.state(
          projectId,
          intent.status,
          intent.failureCode,
          release,
          applied,
          planOutbox,
          Boolean(initialDraft),
          applyContinuation,
          applyOutbox,
        );
    const visibleOutbox = applyContinuation ? applyOutbox : planOutbox;
    const history = this.events(intent, visibleOutbox, state.value, state.safeCode);
    return {
      state: state.value,
      safeCodes: [state.safeCode],
      intent: {
        safeId: intent.id.slice(0, 8),
        status: intent.status,
        releaseManifestRevision: release?.revision || null,
        appliedInfrastructureRevision: applied?.revision || null,
        outboxStatus: visibleOutbox?.status || null,
        sourceCommitShortSha: this.shortSha(release?.commitSha || initialDraft?.releaseDraft.commitSha),
        lifecycleCode: state.safeCode,
        lastMeaningfulAt: this.lastMeaningfulAt(
          applyContinuation || intent,
          release,
          visibleOutbox,
        ),
        history,
        firstRelease: Boolean(initialDraft),
        infrastructurePlanning: initialDraft
          ? {
            planState: state.safeCode
              === "FIRST_RELEASE_INFRASTRUCTURE_APPLY_AWAITING_APPROVAL"
              || state.safeCode === "FIRST_RELEASE_INFRASTRUCTURE_APPLIED_RELEASE_AWAITING_EXECUTION"
              ? "completed"
              : state.safeCode === "FIRST_RELEASE_INTENT_PREPARED"
                ? "prepared"
                : "blocked",
            applyState: state.safeCode
              === "FIRST_RELEASE_INFRASTRUCTURE_APPLY_AWAITING_APPROVAL"
              ? "awaiting_approval"
              : state.safeCode === "FIRST_RELEASE_INFRASTRUCTURE_APPLIED_RELEASE_AWAITING_EXECUTION"
                ? "applied"
                : state.safeCode === "FIRST_RELEASE_INFRASTRUCTURE_APPLY_QUEUED"
                  ? "queued"
                  : state.safeCode === "FIRST_RELEASE_INFRASTRUCTURE_APPLY_RUNNING"
                    ? "running"
                    : state.value === "blocked" ? "blocked" : "not_ready",
            planOutboxStatus: planOutbox?.status || null,
            applyOutboxStatus: applyOutbox?.status === "pending" ? "pending" : null,
          }
          : null,
      },
      stableRelease: stableRelease.value,
    };
  }

  private enabled(projectId: string) {
    if (this.config.get<unknown>("TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED") !== "true"
      && this.config.get<unknown>("TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED") !== "true") return false;
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

  private firstReleaseEnabled(projectId: string) {
    return this.config.get<unknown>("TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED") === "true"
      && this.config.get<unknown>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST") === projectId
      && this.config.get<unknown>("TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST") === "dev";
  }

  private assertCanView(user: User, project: Project) {
    if (user.role === UserRole.ADMIN || project.ownerUserId === user.id) return;
    if (user.role === UserRole.READONLY && project.visibility === ProjectVisibility.WORKSPACE) return;
    throw new ForbiddenException("Insufficient permissions");
  }

  private state(
    projectId: string,
    status: string,
    failureCode: string | null,
    release: ReleaseManifest | null,
    applied: InfrastructureManifest | null,
    outbox: OrchestrationOutbox | null,
    firstRelease = false,
    applyContinuation: DeploymentIntent | null = null,
    applyOutbox: OrchestrationOutbox | null = null,
  ): { value: Exclude<NormalReleaseLaneStatus["state"], "disabled" | "missing">; safeCode: string } {
    if (firstRelease) {
      if (
        applied?.status === "applied" && release === null && status === "plan_completed"
        && applyContinuation?.kind === "apply" && applyContinuation.status === "completed"
        && applyContinuation.infrastructureManifestId === applied.id
        && applyOutbox?.eventType === "intent.infrastructure.apply" && applyOutbox.status === "published"
      ) return { value: "completed", safeCode: "FIRST_RELEASE_INFRASTRUCTURE_APPLIED_RELEASE_AWAITING_EXECUTION" };
      if (
        applied?.status === "planned" && status === "plan_completed"
        && applyContinuation?.kind === "apply" && ["enqueued", "running"].includes(applyContinuation.status)
        && applyOutbox?.eventType === "intent.infrastructure.apply" && applyOutbox.status === "published"
      ) return { value: applyContinuation.status === "running" ? "running" : "queued", safeCode: applyContinuation.status === "running" ? "FIRST_RELEASE_INFRASTRUCTURE_APPLY_RUNNING" : "FIRST_RELEASE_INFRASTRUCTURE_APPLY_QUEUED" };
      if (
        applied?.status === "planned"
        && release === null
        && status === "plan_completed"
        && outbox?.eventType === "intent.infrastructure.plan"
        && outbox.status === "published"
        && applyContinuation?.kind === "apply"
        && applyContinuation.classification === "infrastructure_change"
        && applyContinuation.status === "planned"
        && applyContinuation.infrastructureManifestId === applied.id
        && applyContinuation.releaseManifestId === null
        && applyContinuation.requestPayload?.operation
          === "infrastructure_apply_continuation"
        && applyContinuation.decision?.approvalRequired === true
        && applyContinuation.decision?.executionLane === "infrastructure"
        && applyContinuation.decision?.desiredInfrastructureManifestId
          === applied.id
        && applyOutbox?.eventType === "intent.infrastructure.apply"
        && applyOutbox.status === "pending"
        && applyOutbox.attemptCount === 0
        && applyOutbox.claimedBy === null
        && applyOutbox.claimExpiresAt === null
        && applyOutbox.publishedJobId === null
        && applyOutbox.publishedAt === null
      ) {
        return {
          value: "prepared",
          safeCode: "FIRST_RELEASE_INFRASTRUCTURE_APPLY_AWAITING_APPROVAL",
        };
      }
      if (
        !applied
        || applied.status !== "desired"
        || release
        || status !== "planned"
        || outbox?.eventType !== "intent.infrastructure.plan"
        || outbox.status !== "pending"
      ) {
        return { value: "blocked", safeCode: "NORMAL_FIRST_RELEASE_STATUS_MALFORMED" };
      }
      return { value: "prepared", safeCode: "FIRST_RELEASE_INTENT_PREPARED" };
    }
    if (!applied || !release || release.infrastructureManifestId !== applied.id) {
      return { value: "blocked", safeCode: "NORMAL_RELEASE_LANE_STATUS_MALFORMED" };
    }
    // Delivery history remains auditable after terminal intent finalization.
    // A published outbox must never make a completed intent look active again.
    if (status === "completed") return { value: "completed", safeCode: "RELEASE_LANE_INTENT_COMPLETED" };
    if (status === "cancelled") return { value: "cancelled", safeCode: "RELEASE_LANE_INTENT_CANCELLED" };
    if (
      status === "failed"
      && failureCode === "RELEASE_EVIDENCE_AMBIGUOUS"
      && this.autoConvergenceEnabled(projectId)
    ) return {
      value: "reconciling",
      safeCode: "NORMAL_RELEASE_CONVERGENCE_RECONCILING",
    };
    if (status === "failed" && failureCode === "NORMAL_RELEASE_CONVERGENCE_BOUND_EXHAUSTED") {
      return {
        value: "blocked",
        safeCode: "NORMAL_RELEASE_CONVERGENCE_BOUND_EXHAUSTED",
      };
    }
    if (status === "planned" && outbox?.status === "pending") return { value: "prepared", safeCode: "RELEASE_LANE_INTENT_PREPARED" };
    if (status === "enqueued" || outbox?.status === "publishing" || outbox?.status === "published") return { value: "queued", safeCode: "RELEASE_LANE_INTENT_QUEUED" };
    if (status === "running") return { value: "running", safeCode: "RELEASE_LANE_INTENT_RUNNING" };
    return { value: "blocked", safeCode: "NORMAL_RELEASE_LANE_STATUS_BLOCKED" };
  }

  private autoConvergenceEnabled(projectId: string) {
    return this.config.get<unknown>("TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_ENABLED") === "true"
      && this.config.get<unknown>("TWO_LANE_NORMAL_RELEASE_OUTCOME_RECONCILE_APPROVED") === "true"
      && this.config.get<unknown>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST") === projectId
      && this.config.get<unknown>("TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST") === "dev";
  }

  private shortSha(value: string | null | undefined) {
    return typeof value === "string" && /^[a-f0-9]{7,64}$/i.test(value)
      ? value.slice(0, 12).toLowerCase()
      : null;
  }

  private stableRelease(
    stable: ReleaseManifest | null,
    rollback: ReleaseManifest | null,
    deployment: ProjectDeployment | null,
    infrastructure: InfrastructureManifest | null,
  ): { value: NormalReleaseLaneStableRelease | null; conflict: boolean } {
    if (!stable) return { value: null, conflict: false };
    const revision = this.revision(stable.revision);
    const sourceCommitShortSha = this.shortSha(stable.commitSha);
    const promotedAt = this.timestamp(stable.promotedAt);
    if (!revision || !sourceCommitShortSha || !promotedAt) return { value: null, conflict: true };
    if (
      deployment
      && ((deployment.releaseManifestId && deployment.releaseManifestId !== stable.id)
        || (deployment.taskDefinitionArn && deployment.taskDefinitionArn !== stable.taskDefinitionArn)
        || (deployment.ecsServiceArn && stable.initialServiceArn && deployment.ecsServiceArn !== stable.initialServiceArn))
    ) return { value: null, conflict: true };
    const rollbackRevision = rollback ? this.revision(rollback.revision) : null;
    const rollbackSha = rollback ? this.shortSha(rollback.commitSha) : null;
    if ((rollbackRevision && !rollbackSha) || (!rollbackRevision && rollbackSha)) return { value: null, conflict: true };
    return {
      value: {
        revision,
        sourceCommitShortSha,
        status: "stable",
        promotedAt,
        url: this.url(deployment?.albDnsName) || this.infrastructureUrl(infrastructure),
        rollbackLineage: rollbackRevision && rollbackSha
          ? { revision: rollbackRevision, sourceCommitShortSha: rollbackSha, status: "rollback_eligible" }
          : null,
      },
      conflict: false,
    };
  }

  private revision(value: string | null | undefined) {
    return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value) ? value : null;
  }

  private url(value: string | null | undefined) {
    if (typeof value !== "string" || !/^[a-z0-9.-]+$/i.test(value)) return null;
    return `http://${value}`;
  }

  private infrastructureUrl(infrastructure: InfrastructureManifest | null) {
    if (
      !infrastructure?.terraformOutputs
      || !infrastructure.terraformOutputsHash
      || canonicalSha256(infrastructure.terraformOutputs) !== infrastructure.terraformOutputsHash
    ) return null;
    const hostname = infrastructure.terraformOutputs.alb_dns_name;
    return this.url(typeof hostname === "string" ? hostname : null);
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
        const code = kind === "blocked" || (
          kind === "prepared"
          && lifecycleCode.startsWith("FIRST_RELEASE_")
        )
          ? lifecycleCode
          : RELEASE_LANE_EVENT_CODES[kind];
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
