import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Project } from "../../projects/project.entity";
import { User, UserRole } from "../../users/user.entity";
import { canonicalSha256 } from "../contracts/canonical-json";
import { validateWorkerEnvelopeV1 } from "../contracts/worker-envelope.validator";
import { DeploymentIntent } from "../entities/deployment-intent.entity";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { InitialReleaseDraft } from "../entities/initial-release-draft.entity";
import { OrchestrationOutbox } from "../entities/orchestration-outbox.entity";
import { DurableOutboxDispatcherService } from "../outbox/durable-outbox-dispatcher.service";
import { normalV1AllowsScope } from "./normal-v1-activation-policy";
import { normalFirstReleasePlanOperationWhere } from "./normal-first-release-plan-operation";

export type NormalFirstReleaseInfrastructurePlanExecution =
  | { state: "disabled"; safeCodes: readonly ["NORMAL_FIRST_RELEASE_INFRASTRUCTURE_PLAN_EXECUTION_DISABLED"]; fallbackToLegacy: false }
  | { state: "blocked"; safeCodes: readonly string[]; fallbackToLegacy: false }
  | { state: "dispatched"; safeCodes: readonly ["FIRST_RELEASE_INFRASTRUCTURE_PLAN_OUTBOX_DISPATCHED"]; fallbackToLegacy: false };

/**
 * Authenticated activation for one already prepared initial infrastructure
 * plan. It has no consumer, Terraform, or release dependency: dispatchExact
 * is the only side effect it may request.
 */
@Injectable()
export class NormalFirstReleaseInfrastructurePlanExecutionService {
  constructor(
    private readonly config: ConfigService,
    private readonly dispatcher: DurableOutboxDispatcherService,
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(DeploymentIntent) private readonly intents: Repository<DeploymentIntent>,
    @InjectRepository(InfrastructureManifest) private readonly infrastructure: Repository<InfrastructureManifest>,
    @InjectRepository(InitialReleaseDraft) private readonly drafts: Repository<InitialReleaseDraft>,
    @InjectRepository(OrchestrationOutbox) private readonly outbox: Repository<OrchestrationOutbox>,
  ) {}

  async dispatch(
    user: User,
    projectId: string,
  ): Promise<NormalFirstReleaseInfrastructurePlanExecution> {
    const gate = this.gate(projectId);
    if (gate === "disabled") return this.disabled();
    if (gate === "blocked") return this.blocked(
      "NORMAL_FIRST_RELEASE_INFRASTRUCTURE_PLAN_CONFIGURATION_INVALID",
    );
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.DEVELOPER) {
      return this.blocked("NORMAL_FIRST_RELEASE_INFRASTRUCTURE_PLAN_ACTOR_NOT_ALLOWED");
    }
    const project = await this.projects.findOneBy({ id: projectId });
    if (!project) throw new NotFoundException("Project not found.");
    if (user.role !== UserRole.ADMIN && project.ownerUserId !== user.id) {
      throw new ForbiddenException("You do not have permission to execute this project.");
    }
    if (project.environmentName !== "dev") {
      return this.blocked("NORMAL_FIRST_RELEASE_INFRASTRUCTURE_PLAN_PROJECT_INELIGIBLE");
    }

    const parents = await this.intents.find({
      where: normalFirstReleasePlanOperationWhere(projectId),
      order: { receivedAt: "DESC" },
      take: 2,
    });
    if (parents.length !== 1 || parents[0].status !== "planned") {
      return this.blocked("NORMAL_FIRST_RELEASE_INFRASTRUCTURE_PLAN_PARENT_NOT_UNIQUE");
    }
    const parent = parents[0];
    if (
      parent.status !== "planned"
      || parent.releaseManifestId !== null
      || !parent.infrastructureManifestId
    ) {
      return this.blocked("NORMAL_FIRST_RELEASE_INFRASTRUCTURE_PLAN_EVIDENCE_MALFORMED");
    }
    const [manifest, drafts, outboxes] = await Promise.all([
      this.infrastructure.findOneBy({
        id: parent.infrastructureManifestId,
        projectId,
        environmentName: "dev",
      }),
      this.drafts.find({
        where: { intentId: parent.id, projectId, environmentName: "dev" },
      }),
      this.outbox.find({ where: { intentId: parent.id }, order: { createdAt: "ASC" } }),
    ]);
    if (
      !manifest || !this.validManifestForDispatch(manifest)
      || drafts.length !== 1 || !this.validDraft(drafts[0], parent, manifest)
      || outboxes.length !== 1 || !this.validOutbox(outboxes[0], parent, manifest)
    ) {
      return this.blocked("NORMAL_FIRST_RELEASE_INFRASTRUCTURE_PLAN_EVIDENCE_MALFORMED");
    }
    const outbox = outboxes[0];
    const result = await this.dispatcher.dispatchExact({
      outboxId: outbox.id,
      intentId: parent.id,
      projectId,
      environmentName: "dev",
    });
    if (result.status === "published") return {
      state: "dispatched",
      safeCodes: ["FIRST_RELEASE_INFRASTRUCTURE_PLAN_OUTBOX_DISPATCHED"],
      fallbackToLegacy: false,
    };
    return this.blocked(
      result.status === "dead_letter"
        ? "NORMAL_FIRST_RELEASE_INFRASTRUCTURE_PLAN_OUTBOX_NOT_DISPATCHABLE"
        : result.status === "blocked"
          ? result.reason
          : "NORMAL_FIRST_RELEASE_INFRASTRUCTURE_PLAN_OUTBOX_DISPATCH_UNAVAILABLE",
    );
  }

  private validDraft(
    draft: InitialReleaseDraft,
    parent: DeploymentIntent,
    manifest: InfrastructureManifest,
  ) {
    return draft.intentId === parent.id
      && draft.projectId === parent.projectId
      && draft.environmentName === parent.environmentName
      && draft.infrastructureManifestId === manifest.id
      && String(draft.infrastructureRevision) === String(manifest.revision)
      && draft.draftHash === canonicalSha256(draft.releaseDraft);
  }

  private validManifestForDispatch(manifest: InfrastructureManifest) {
    if (manifest.status === "desired") return manifest.appliedAt === null;
    return manifest.status === "failed"
      && manifest.failureCode === "REMOTE_CANARY_PLAN_NOT_ALLOWED"
      && manifest.planArtifactReference === null
      && manifest.planArtifactSha256 === null
      && manifest.planInputFingerprint === null
      && manifest.stateVersionId === null
      && manifest.terraformOutputs === null
      && manifest.terraformOutputsHash === null
      && manifest.resourceCount === null
      && manifest.plannedAt === null
      && manifest.applyStartedAt === null
      && manifest.appliedAt === null;
  }

  private validOutbox(
    outbox: OrchestrationOutbox,
    parent: DeploymentIntent,
    manifest: InfrastructureManifest,
  ) {
    if (
      outbox.eventType !== "intent.infrastructure.plan"
      || outbox.status !== "pending"
      || outbox.attemptCount !== 0
      || outbox.claimedBy !== null
      || outbox.claimExpiresAt !== null
      || outbox.publishedAt !== null
      || outbox.publishedJobId !== null
      || outbox.payloadSha256 !== outbox.workerEnvelope?.idempotency?.payloadSha256
    ) return false;
    try {
      const envelope = validateWorkerEnvelopeV1(outbox.workerEnvelope);
      return envelope.protocol.messageType === "intent.infrastructure.plan"
        && envelope.routing.queue === "deployguard-infrastructure-v1"
        && envelope.routing.lane === "infrastructure"
        && envelope.routing.operation === "plan"
        && envelope.identity.intentId === parent.id
        && envelope.identity.projectId === parent.projectId
        && envelope.identity.environmentName === parent.environmentName
        && envelope.identity.infrastructureManifestId === manifest.id
        && envelope.identity.releaseManifestId === null
        && envelope.idempotency.canonicalKey === parent.canonicalIdempotencyKey;
    } catch { return false; }
  }

  private gate(projectId: string): "ready" | "disabled" | "blocked" {
    if (
      this.config.get<unknown>("TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_EXECUTION_ENABLED") !== "true"
    ) return "disabled";
    return normalV1AllowsScope(this.config, projectId, "dev")
      ? "ready" : "blocked";
  }
  private disabled(): NormalFirstReleaseInfrastructurePlanExecution {
    return { state: "disabled", safeCodes: ["NORMAL_FIRST_RELEASE_INFRASTRUCTURE_PLAN_EXECUTION_DISABLED"], fallbackToLegacy: false };
  }
  private blocked(code: string): NormalFirstReleaseInfrastructurePlanExecution {
    return { state: "blocked", safeCodes: [code], fallbackToLegacy: false };
  }
}
