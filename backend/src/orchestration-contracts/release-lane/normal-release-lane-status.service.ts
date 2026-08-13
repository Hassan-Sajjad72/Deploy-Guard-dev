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
import {
  PreflightValidationStatus,
  ProjectPreflightReport,
} from "../../projects/project-preflight-report.entity";
import {
  ProjectSecurityScan,
  SecurityPolicyDecision,
  SecurityScanStatus,
} from "../../projects/project-security-scan.entity";
import {
  DeploymentSideEffect,
  DeploymentSideEffectStatus,
} from "../entities/deployment-side-effect.entity";
import { normalV1AllowsScope } from "./normal-v1-activation-policy";
import {
  FIRST_RELEASE_PRE_EXECUTION_RETRY_READY,
  isFirstReleasePreExecutionRetryEligible,
} from "./normal-first-release-pre-execution-retry";

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

export type NormalReleaseOperationPhase = {
  key: "analyze" | "build" | "prepare" | "deploy" | "verify";
  label: "Analyze" | "Build" | "Prepare" | "Deploy" | "Verify";
  status: "not_started" | "waiting" | "running" | "passed" | "failed";
  occurredAt: string | null;
};

export type NormalReleaseOperation = {
  latestAttempt: {
    releaseRevision: string;
    sourceCommitShortSha: string;
    status:
      | "prepared"
      | "queued"
      | "running"
      | "reconciling"
      | "completed"
      | "cancelled"
      | "blocked";
    lastMeaningfulAt: string;
  };
  phases: readonly NormalReleaseOperationPhase[];
  evidence: {
    preflight: NormalReleaseOperationEvidence;
    security: NormalReleaseOperationEvidence;
  };
  observability: NormalReleaseOperationObservability;
  terminalResult: "live" | "failed" | null;
};

export type NormalReleaseOperationEvidence = {
  state: "not_started" | "running" | "passed" | "blocked" | "unavailable" | "deferred";
  safeCode: string;
  observedAt: string | null;
};

export type NormalReleaseOperationObservability = {
  serviceHealth: {
    state: "healthy" | "progressing" | "degraded" | "unavailable";
    safeCode: string;
    observedAt: string | null;
  };
  metrics: {
    completedPhases: number;
    totalPhases: 5;
    succeededEffects: number;
    totalEffects: number;
    durationMs: number | null;
  };
  events: readonly {
    phase: NormalReleaseOperationPhase["key"];
    state: "running" | "passed" | "failed";
    safeCode: string;
    occurredAt: string;
  }[];
  logs: readonly {
    level: "info" | "warning" | "error";
    label: string;
    safeCode: string;
    occurredAt: string;
  }[];
};

export type NormalInfrastructurePlanningReview = {
  resourceSummary: {
    create: number;
    update: number;
    replace: number;
    delete: number;
  } | null;
  costEstimate: {
    state: "real" | "deferred" | "unavailable";
    currency: string | null;
    monthlyCost: number | null;
    resourceCount: number | null;
  };
  approvalReady: boolean;
  approval: {
    state: "auto_approved" | "owner_required" | "owner_approved" | "operator_required" | "operator_approved" | "platform_attention";
    required: boolean;
    thresholdMonthlyCost: number | null;
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
      operation: NormalReleaseOperation | null;
      firstRelease: boolean;
      infrastructurePlanning: {
        planState: "prepared" | "queued" | "running" | "completed" | "blocked";
        applyState: "not_ready" | "continuation_pending" | "awaiting_approval" | "queued" | "running" | "applied" | "blocked";
        planOutboxStatus: "pending" | "publishing" | "published" | "failed" | "dead_letter" | null;
        applyOutboxStatus: "pending" | null;
        review: NormalInfrastructurePlanningReview | null;
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
    @InjectRepository(ProjectPreflightReport)
    private readonly preflightReports?: Repository<ProjectPreflightReport>,
    @InjectRepository(ProjectSecurityScan)
    private readonly securityScans?: Repository<ProjectSecurityScan>,
    @InjectRepository(DeploymentSideEffect)
    private readonly sideEffects?: Repository<DeploymentSideEffect>,
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
    // Drafts are immutable lineage evidence, not an execution capability. Read
    // them even when the first-release planning gate has subsequently been
    // disabled so a completed first release remains truthfully projectable.
    if (intent && intent.infrastructureManifestId) {
      initialDraft = await this.drafts?.findOne({
        where: {
          projectId,
          environmentName: "dev",
          infrastructureManifestId: intent.infrastructureManifestId,
        },
        order: { createdAt: "ASC" },
      }) || null;
    }
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
    // An immutable initial draft remains historical evidence after the first
    // release. A later candidate on the same applied foundation must not be
    // projected as a first release merely because that draft still exists.
    const firstReleaseIntent = Boolean(initialDraft)
      && (!stable || stable.id === intent.releaseManifestId);
    const stableInfrastructure = firstReleaseIntent
      && intent.status === "completed"
      && release?.id === stable?.id
      && stable?.infrastructureManifestId !== applied?.id
      ? await this.infrastructure.findOne({
        where: {
          id: stable!.infrastructureManifestId,
          projectId,
          environmentName: "dev",
        },
      })
      : null;
    const requiresRecoveredLineage = Boolean(
      firstReleaseIntent
      && intent.status === "completed"
      && release?.id === stable?.id
      && stable?.infrastructureManifestId !== applied?.id,
    );
    const recoveredLineageValid = !requiresRecoveredLineage || Boolean(
      initialDraft
      && applied
      && release
      && stable
      && stableInfrastructure
      && initialDraft.infrastructureManifestId === intent.infrastructureManifestId
      && initialDraft.infrastructureManifestId === applied.id
      && initialDraft.releaseDraft.commitSha === release.commitSha
      && release.infrastructureManifestId === stableInfrastructure.id
      && stable.infrastructureManifestId === stableInfrastructure.id
      && stableInfrastructure.parentManifestId === applied.id
      && stableInfrastructure.status === "applied"
      && applied.status === "superseded",
    );
    const effectiveInfrastructure = requiresRecoveredLineage && recoveredLineageValid
      ? stableInfrastructure
      : applied;
    const [rollback, deployment, preflight, securityScan, sideEffects] = await Promise.all([
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
      release && this.preflightReports
        ? this.preflightReports.findOne({
          where: { projectId },
          order: { updatedAt: "DESC" },
        })
        : null,
      release?.imageUri && this.securityScans
        ? this.securityScans.findOne({
          where: { projectId, imageUri: release.imageUri },
          order: { updatedAt: "DESC" },
        })
        : null,
      this.sideEffects
        ? this.sideEffects.find({
          where: { intentId: intent.id },
          order: { createdAt: "ASC" },
          take: 8,
        })
        : [],
    ]);
    const stableRelease = this.stableRelease(
      stable,
      rollback,
      deployment,
      effectiveInfrastructure,
    );
    const preExecutionRetryEligible = Boolean(
      firstReleaseIntent
      && initialDraft
      && isFirstReleasePreExecutionRetryEligible({
        intent,
        manifest: effectiveInfrastructure,
        draft: initialDraft,
        outbox: planOutbox,
        sideEffects,
      }),
    );
    const state = stableRelease.conflict
      ? { value: "blocked" as const, safeCode: "NORMAL_RELEASE_LANE_STABLE_IDENTITY_CONFLICT" }
      : !recoveredLineageValid
        ? { value: "blocked" as const, safeCode: "NORMAL_FIRST_RELEASE_STABLE_LINEAGE_CONFLICT" }
      : continuationConflict
        ? { value: "blocked" as const, safeCode: "NORMAL_FIRST_RELEASE_APPLY_CONTINUATION_CONFLICT" }
      : preExecutionRetryEligible
        ? { value: "blocked" as const, safeCode: FIRST_RELEASE_PRE_EXECUTION_RETRY_READY }
        : this.state(
          projectId,
          intent.status,
          intent.failureCode,
          release,
          effectiveInfrastructure,
          planOutbox,
          firstReleaseIntent,
          applyContinuation,
          applyOutbox,
        );
    const visibleOutbox = applyContinuation ? applyOutbox : planOutbox;
    const history = this.events(intent, visibleOutbox, state.value, state.safeCode);
    const lastMeaningfulAt = this.lastMeaningfulAt(
      applyContinuation || intent,
      release,
      visibleOutbox,
    );
    return {
      state: state.value,
      safeCodes: [state.safeCode],
      intent: {
        safeId: intent.id.slice(0, 8),
        status: intent.status,
        releaseManifestRevision: release?.revision || null,
        appliedInfrastructureRevision: effectiveInfrastructure?.revision || null,
        outboxStatus: visibleOutbox?.status || null,
        sourceCommitShortSha: this.shortSha(release?.commitSha || initialDraft?.releaseDraft.commitSha),
        lifecycleCode: state.safeCode,
        lastMeaningfulAt,
        history,
        operation: release
          ? this.operation(
            intent,
            release,
            state.value,
            lastMeaningfulAt,
            preflight,
            securityScan,
            sideEffects,
          )
          : null,
        firstRelease: firstReleaseIntent,
        infrastructurePlanning: firstReleaseIntent && initialDraft
          ? {
            planState: state.safeCode
              === "FIRST_RELEASE_INFRASTRUCTURE_APPLY_AWAITING_APPROVAL"
              || state.safeCode === "FIRST_RELEASE_INFRASTRUCTURE_AUTOMATIC_CONTINUATION_PENDING"
              || state.safeCode === "FIRST_RELEASE_INFRASTRUCTURE_APPLIED_RELEASE_AWAITING_EXECUTION"
              || state.safeCode === "FIRST_RELEASE_INTENT_COMPLETED"
              ? "completed"
              : state.safeCode === "FIRST_RELEASE_INFRASTRUCTURE_PLAN_QUEUED"
                ? "queued"
                : state.safeCode === "FIRST_RELEASE_INFRASTRUCTURE_PLAN_RUNNING"
                  ? "running"
              : state.safeCode === "FIRST_RELEASE_INTENT_PREPARED"
                ? "prepared"
                : "blocked",
            applyState: state.safeCode
              === "FIRST_RELEASE_INFRASTRUCTURE_APPLY_AWAITING_APPROVAL"
              ? "awaiting_approval"
              : state.safeCode === "FIRST_RELEASE_INFRASTRUCTURE_AUTOMATIC_CONTINUATION_PENDING"
                ? "continuation_pending"
              : state.safeCode === "FIRST_RELEASE_INFRASTRUCTURE_APPLIED_RELEASE_AWAITING_EXECUTION"
                || state.safeCode === "FIRST_RELEASE_INTENT_COMPLETED"
                ? "applied"
                : state.safeCode === "FIRST_RELEASE_INFRASTRUCTURE_APPLY_QUEUED"
                  ? "queued"
                  : state.safeCode === "FIRST_RELEASE_INFRASTRUCTURE_APPLY_RUNNING"
                    ? "running"
                    : state.value === "blocked" ? "blocked" : "not_ready",
            planOutboxStatus: planOutbox?.status || null,
            applyOutboxStatus: applyOutbox?.status === "pending" ? "pending" : null,
            review: this.infrastructurePlanReview(effectiveInfrastructure, applyContinuation),
          }
          : null,
      },
      stableRelease: stableRelease.value,
    };
  }

  private enabled(projectId: string) {
    if (this.config.get<unknown>("TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED") !== "true"
      && this.config.get<unknown>("TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED") !== "true"
      && this.config.get<unknown>("TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_PLANNING_ENABLED") !== "true") return false;
    return normalV1AllowsScope(this.config, projectId, "dev");
  }

  private firstReleaseEnabled(projectId: string) {
    return (this.config.get<unknown>("TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED") === "true"
      || this.config.get<unknown>("TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_PLANNING_ENABLED") === "true")
      && normalV1AllowsScope(this.config, projectId, "dev");
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
        applied?.status === "applied" && release && status === "completed"
        && outbox?.eventType === "intent.release.execute"
        && outbox.status === "published"
      ) return { value: "completed", safeCode: "FIRST_RELEASE_INTENT_COMPLETED" };
      if (
        applied?.status === "applied" && release?.status === "desired" && status === "planned"
        && outbox?.eventType === "intent.release.execute" && outbox.status === "pending"
        && outbox.attemptCount === 0 && outbox.claimedBy === null && outbox.publishedJobId === null
      ) return { value: "prepared", safeCode: "FIRST_RELEASE_INTENT_PREPARED" };
      if (
        applied?.status === "applied" && release === null && status === "plan_completed"
        && applyContinuation?.kind === "apply" && applyContinuation.status === "completed"
        && applyContinuation.infrastructureManifestId === applied.id
        && applyOutbox?.eventType === "intent.infrastructure.apply" && applyOutbox.status === "published"
      ) return { value: "completed", safeCode: "FIRST_RELEASE_INFRASTRUCTURE_APPLIED_RELEASE_AWAITING_EXECUTION" };
      if (
        applied && ["planned", "approved", "applying", "manual_review"].includes(applied.status)
        && status === "plan_completed"
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
        && typeof applyContinuation.decision?.approvalRequired === "boolean"
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
        const policyState = String(
          (applyContinuation.decision?.automaticContinuation as Record<string, unknown> | undefined)?.state || "",
        );
        return {
          value: "prepared",
          safeCode: ["auto_approved", "owner_approved", "operator_approved"].includes(policyState)
            ? "FIRST_RELEASE_INFRASTRUCTURE_AUTOMATIC_CONTINUATION_PENDING"
            : "FIRST_RELEASE_INFRASTRUCTURE_APPLY_AWAITING_APPROVAL",
        };
      }
      if (
        applied
        && ["desired", "planning", "planned"].includes(applied.status)
        && release === null
        && ["enqueued", "running"].includes(status)
        && outbox?.eventType === "intent.infrastructure.plan"
        && outbox.status === "published"
      ) return {
        value: status === "running" ? "running" : "queued",
        safeCode: status === "running"
          ? "FIRST_RELEASE_INFRASTRUCTURE_PLAN_RUNNING"
          : "FIRST_RELEASE_INFRASTRUCTURE_PLAN_QUEUED",
      };
      if (
        !applied
        || !(applied.status === "desired" || (
          applied.status === "failed"
          && applied.failureCode === "REMOTE_CANARY_PLAN_NOT_ALLOWED"
          && applied.planArtifactReference === null
          && applied.planArtifactSha256 === null
          && applied.planInputFingerprint === null
          && applied.stateVersionId === null
          && applied.terraformOutputs === null
          && applied.terraformOutputsHash === null
          && applied.appliedAt === null
        ))
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
      && normalV1AllowsScope(this.config, projectId, "dev");
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

  private operation(
    intent: DeploymentIntent,
    release: ReleaseManifest,
    state: Exclude<NormalReleaseLaneStatus["state"], "disabled" | "missing">,
    lastMeaningfulAt: string,
    preflight: ProjectPreflightReport | null,
    securityScan: ProjectSecurityScan | null,
    sideEffects: readonly DeploymentSideEffect[],
  ): NormalReleaseOperation | null {
    const releaseRevision = this.revision(release.revision);
    const sourceCommitShortSha = this.shortSha(release.commitSha);
    if (!releaseRevision || !sourceCommitShortSha) return null;

    const completed = state === "completed";
    const failed = state === "blocked" || state === "cancelled";
    const running = state === "running" || state === "reconciling";
    const evidence = {
      preflight: this.preflightEvidence(release, preflight),
      security: this.securityEvidence(release, securityScan),
    };
    const evidenceBlocked = [
      evidence.preflight.state,
      evidence.security.state,
    ].some((value) => value === "blocked" || value === "unavailable");
    const phases: NormalReleaseOperationPhase[] = [
      {
        key: "analyze",
        label: "Analyze",
        status: evidence.preflight.state === "passed"
          ? "passed"
          : evidence.preflight.state === "running"
            ? "running"
            : evidence.preflight.state === "blocked"
              || evidence.preflight.state === "unavailable"
              ? "failed"
              : "not_started",
        occurredAt: evidence.preflight.observedAt,
      },
      {
        key: "build",
        label: "Build",
        status: release.builtAt && evidence.security.state === "passed"
          ? "passed"
          : release.builtAt && evidence.security.state === "deferred"
            ? "passed"
          : release.builtAt && (evidence.security.state === "blocked"
            || evidence.security.state === "unavailable")
            ? "failed"
            : release.builtAt && evidence.security.state === "running"
              ? "running"
              : release.buildStartedAt || running
                ? "running"
                : state === "queued"
                  ? "waiting"
                  : "not_started",
        occurredAt: evidence.security.observedAt
          || this.timestamp(release.builtAt),
      },
      {
        key: "prepare",
        label: "Prepare",
        status: release.taskDefinitionArn || completed
          ? "passed"
          : release.builtAt && running
            ? "running"
            : release.builtAt
              ? "waiting"
              : "not_started",
        occurredAt: release.taskDefinitionArn
          ? this.timestamp(release.deploymentStartedAt || release.updatedAt)
          : null,
      },
      {
        key: "deploy",
        label: "Deploy",
        status: release.healthVerifiedAt || completed
          ? "passed"
          : release.deploymentStartedAt
            ? "running"
            : release.taskDefinitionArn && running
              ? "running"
              : release.taskDefinitionArn
                ? "waiting"
                : "not_started",
        occurredAt: this.timestamp(release.healthVerifiedAt),
      },
      {
        key: "verify",
        label: "Verify",
        status: release.promotedAt || completed
          ? "passed"
          : state === "reconciling" || release.healthVerifiedAt
            ? "running"
            : release.deploymentStartedAt
              ? "waiting"
              : "not_started",
        occurredAt: this.timestamp(release.promotedAt),
      },
    ];
    if (failed && !phases.some((phase) => phase.status === "failed")) {
      const failureIndex = phases.findIndex(
        (phase) => phase.status !== "passed",
      );
      const index = failureIndex === -1 ? phases.length - 1 : failureIndex;
      phases[index] = { ...phases[index], status: "failed" };
    }
    return {
      latestAttempt: {
        releaseRevision,
        sourceCommitShortSha,
        status: state,
        lastMeaningfulAt,
      },
      phases,
      evidence,
      observability: this.operationObservability(
        intent,
        release,
        phases,
        state,
        sideEffects,
      ),
      terminalResult: completed
        ? evidenceBlocked ? "failed" : "live"
        : failed ? "failed" : null,
    };
  }

  private operationObservability(
    intent: DeploymentIntent,
    release: ReleaseManifest,
    phases: readonly NormalReleaseOperationPhase[],
    state: Exclude<NormalReleaseLaneStatus["state"], "disabled" | "missing">,
    effects: readonly DeploymentSideEffect[],
  ): NormalReleaseOperationObservability {
    const phaseCodes: Record<NormalReleaseOperationPhase["key"], string> = {
      analyze: "NORMAL_RELEASE_ANALYZE",
      build: "NORMAL_RELEASE_BUILD",
      prepare: "NORMAL_RELEASE_PREPARE",
      deploy: "NORMAL_RELEASE_DEPLOY",
      verify: "NORMAL_RELEASE_VERIFY",
    };
    const events = phases
      .filter((phase): phase is NormalReleaseOperationPhase & {
        status: "running" | "passed" | "failed";
        occurredAt: string;
      } => Boolean(phase.occurredAt)
        && ["running", "passed", "failed"].includes(phase.status))
      .map((phase) => ({
        phase: phase.key,
        state: phase.status,
        safeCode: `${phaseCodes[phase.key]}_${phase.status.toUpperCase()}`,
        occurredAt: phase.occurredAt,
      }))
      .slice(-5);
    const logs = effects
      .map((effect) => this.effectLog(effect))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .slice(-6);
    const durationStart = intent.startedAt || intent.enqueuedAt
      || intent.plannedAt || intent.receivedAt;
    const durationEnd = intent.completedAt || (
      state === "running" || state === "reconciling" ? intent.updatedAt : null
    );
    const durationMs = durationStart instanceof Date
      && durationEnd instanceof Date
      && durationEnd.getTime() >= durationStart.getTime()
      ? durationEnd.getTime() - durationStart.getTime()
      : null;
    return {
      serviceHealth: this.serviceHealth(release, state),
      metrics: {
        completedPhases: phases.filter((phase) => phase.status === "passed").length,
        totalPhases: 5,
        succeededEffects: effects.filter((effect) =>
          effect.status === "succeeded" || effect.status === "reconciled"
        ).length,
        totalEffects: effects.length,
        durationMs,
      },
      events,
      logs,
    };
  }

  private serviceHealth(
    release: ReleaseManifest,
    state: Exclude<NormalReleaseLaneStatus["state"], "disabled" | "missing">,
  ): NormalReleaseOperationObservability["serviceHealth"] {
    const healthSafeCode = this.healthEvidenceSafeCode(release.healthEvidence);
    if (
      release.healthVerifiedAt
      && typeof healthSafeCode === "string"
      && /^[A-Z][A-Z0-9_]{2,127}$/.test(healthSafeCode)
    ) return {
      state: "healthy",
      safeCode: "NORMAL_RELEASE_SERVICE_HEALTHY",
      observedAt: this.timestamp(release.healthVerifiedAt),
    };
    if (state === "running" || state === "reconciling") return {
      state: "progressing",
      safeCode: "NORMAL_RELEASE_SERVICE_HEALTH_PROGRESSING",
      observedAt: this.timestamp(release.deploymentStartedAt || release.updatedAt),
    };
    if (state === "blocked" || state === "cancelled" || release.status === "failed") {
      return {
        state: "degraded",
        safeCode: "NORMAL_RELEASE_SERVICE_HEALTH_DEGRADED",
        observedAt: this.timestamp(release.updatedAt),
      };
    }
    return {
      state: "unavailable",
      safeCode: "NORMAL_RELEASE_SERVICE_HEALTH_UNAVAILABLE",
      observedAt: null,
    };
  }

  private healthEvidenceSafeCode(
    evidence: Record<string, unknown> | null,
  ): string | null {
    const nested = (key: string) => {
      const value = evidence?.[key];
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).safeCode
        : null;
    };
    const candidate = evidence?.safeCode
      ?? nested("promotion")
      ?? nested("rollbackVerification");
    return typeof candidate === "string" ? candidate : null;
  }

  private effectLog(effect: DeploymentSideEffect):
    NormalReleaseOperationObservability["logs"][number] | null {
    const known: Record<string, { label: string; stem: string }> = {
      "ecr.build_push_immutable_image": {
        label: "Immutable image prepared",
        stem: "NORMAL_RELEASE_IMAGE",
      },
      "ecr.inspect_immutable_image": {
        label: "Immutable image verified",
        stem: "NORMAL_RELEASE_IMAGE_INSPECTION",
      },
      "ecs.register_task_definition_revision": {
        label: "Runtime definition prepared",
        stem: "NORMAL_RELEASE_RUNTIME_DEFINITION",
      },
      "ecs.update_existing_service": {
        label: "Service update requested",
        stem: "NORMAL_RELEASE_SERVICE_UPDATE",
      },
      "ecs.rollback_existing_service": {
        label: "Bounded rollback requested",
        stem: "NORMAL_RELEASE_ROLLBACK",
      },
    };
    const mapping = known[effect.effectType];
    if (!mapping) return null;
    const status = this.effectStatus(effect.status);
    const occurredAt = this.timestamp(
      effect.completedAt || effect.attemptStartedAt || effect.updatedAt,
    );
    if (!occurredAt) return null;
    return {
      level: status === "FAILED" ? "error"
        : status === "RECONCILIATION_REQUIRED" ? "warning" : "info",
      label: mapping.label,
      safeCode: `${mapping.stem}_${status}`,
      occurredAt,
    };
  }

  private effectStatus(status: DeploymentSideEffectStatus) {
    if (status === "succeeded" || status === "reconciled") return "SUCCEEDED";
    if (status === "failed") return "FAILED";
    if (status === "uncertain") return "RECONCILIATION_REQUIRED";
    return "IN_PROGRESS";
  }

  private preflightEvidence(
    release: ReleaseManifest,
    preflight: ProjectPreflightReport | null,
  ): NormalReleaseOperationEvidence {
    if (!preflight) return {
      state: "unavailable",
      safeCode: "NORMAL_RELEASE_PREFLIGHT_EVIDENCE_UNAVAILABLE",
      observedAt: null,
    };
    if (preflight.inputFingerprint !== release.deploymentContractHash) return {
      state: "blocked",
      safeCode: "NORMAL_RELEASE_PREFLIGHT_EVIDENCE_STALE",
      observedAt: this.timestamp(preflight.updatedAt),
    };
    if (
      preflight.validationStatus === PreflightValidationStatus.PASSED
      || preflight.validationStatus
        === PreflightValidationStatus.PASSED_WITH_WARNINGS
    ) return {
      state: "passed",
      safeCode: "NORMAL_RELEASE_PREFLIGHT_PASSED",
      observedAt: this.timestamp(preflight.updatedAt),
    };
    return {
      state: "blocked",
      safeCode: "NORMAL_RELEASE_PREFLIGHT_BLOCKED",
      observedAt: this.timestamp(preflight.updatedAt),
    };
  }

  private securityEvidence(
    release: ReleaseManifest,
    scan: ProjectSecurityScan | null,
  ): NormalReleaseOperationEvidence {
    if (!release.imageUri || !release.builtAt) return {
      state: "not_started",
      safeCode: "NORMAL_RELEASE_SECURITY_NOT_STARTED",
      observedAt: null,
    };
    if (this.config.get<unknown>("TRIVY_SCAN_ENABLED") !== "true") return {
      state: "deferred",
      safeCode: "NORMAL_RELEASE_SECURITY_DEFERRED",
      observedAt: null,
    };
    if (!scan) return {
      state: "unavailable",
      safeCode: "NORMAL_RELEASE_SECURITY_SCANNER_UNAVAILABLE",
      observedAt: null,
    };
    const observedAt = this.timestamp(
      scan.completedAt || scan.failedAt || scan.updatedAt,
    );
    if (
      scan.scanStatus === SecurityScanStatus.QUEUED
      || scan.scanStatus === SecurityScanStatus.RUNNING
    ) return {
      state: "running",
      safeCode: "NORMAL_RELEASE_SECURITY_SCAN_RUNNING",
      observedAt: this.timestamp(scan.startedAt || scan.updatedAt),
    };
    if (scan.scanStatus === SecurityScanStatus.FAILED) return {
      state: "unavailable",
      safeCode: "NORMAL_RELEASE_SECURITY_SCANNER_UNAVAILABLE",
      observedAt,
    };
    if (
      scan.scanStatus === SecurityScanStatus.COMPLETED
      && (scan.policyDecision === SecurityPolicyDecision.ALLOWED
        || scan.policyDecision === SecurityPolicyDecision.APPROVED_OVERRIDE)
    ) return {
      state: "passed",
      safeCode: "NORMAL_RELEASE_SECURITY_PASSED",
      observedAt,
    };
    return {
      state: "blocked",
      safeCode: "NORMAL_RELEASE_SECURITY_POLICY_BLOCKED",
      observedAt,
    };
  }

  private infrastructurePlanReview(
    manifest: InfrastructureManifest | null,
    applyContinuation: DeploymentIntent | null,
  ): NormalInfrastructurePlanningReview | null {
    const reference = manifest?.planArtifactReference;
    if (!manifest?.planArtifactSha256 || !reference || typeof reference !== "object") return null;
    const review = reference.review;
    if (!review || typeof review !== "object" || Array.isArray(review)) return null;
    const record = review as Record<string, unknown>;
    if (record.planArtifactSha256 !== manifest.planArtifactSha256) return null;
    const rawSummary = reference.planSummary;
    const summary = rawSummary && typeof rawSummary === "object" && !Array.isArray(rawSummary)
      ? rawSummary as Record<string, unknown>
      : null;
    const count = (key: string) => typeof summary?.[key] === "number"
      && Number.isInteger(summary[key]) && Number(summary[key]) >= 0
      ? Number(summary[key]) : null;
    const resourceCounts = summary
      && ["create", "update", "replace", "delete"].every((key) => count(key) !== null)
      ? {
        create: count("create")!,
        update: count("update")!,
        replace: count("replace")!,
        delete: count("delete")!,
      }
      : null;
    const rawCost = record.cost;
    const cost = rawCost && typeof rawCost === "object" && !Array.isArray(rawCost)
      ? rawCost as Record<string, unknown>
      : {};
    const costState = cost.state === "real" || cost.state === "deferred"
      ? cost.state : "unavailable";
    const monthlyCost = costState === "real" && typeof cost.monthlyCost === "number"
      && Number.isFinite(cost.monthlyCost) && cost.monthlyCost >= 0
      ? cost.monthlyCost : null;
    const resourceCount = costState === "real" && typeof cost.resourceCount === "number"
      && Number.isInteger(cost.resourceCount) && cost.resourceCount >= 0
      ? cost.resourceCount : null;
    const currency = costState === "real" && typeof cost.currency === "string"
      && /^[A-Z]{3}$/.test(cost.currency) ? cost.currency : null;
    const approvalReady = manifest.status === "planned"
      && resourceCounts !== null
      && (costState === "real" || costState === "deferred");
    const rawApproval = applyContinuation?.decision?.automaticContinuation;
    const approval = rawApproval && typeof rawApproval === "object" && !Array.isArray(rawApproval)
      ? rawApproval as Record<string, unknown>
      : null;
    const approvalState = approval && [
      "auto_approved", "owner_required", "owner_approved",
      "operator_required", "operator_approved", "platform_attention",
    ].includes(String(approval.state)) ? String(approval.state) as NonNullable<NormalInfrastructurePlanningReview["approval"]>["state"] : null;
    const threshold = approvalState && typeof approval?.thresholdMonthlyCost === "number"
      && Number.isFinite(approval.thresholdMonthlyCost) && approval.thresholdMonthlyCost >= 0
      ? approval.thresholdMonthlyCost : null;
    return {
      resourceSummary: resourceCounts,
      costEstimate: { state: costState, currency, monthlyCost, resourceCount },
      approvalReady,
      approval: approvalState ? {
        state: approvalState,
        required: !["auto_approved", "owner_approved", "operator_approved"].includes(approvalState),
        thresholdMonthlyCost: threshold,
      } : null,
    };
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
