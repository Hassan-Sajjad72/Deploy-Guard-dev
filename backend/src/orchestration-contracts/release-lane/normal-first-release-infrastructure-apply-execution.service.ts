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
import { isApprovedInfrastructurePolicy } from "../../projects/normal-deployment-cost-policy";

@Injectable()
export class NormalFirstReleaseInfrastructureApplyExecutionService {
  constructor(private readonly config: ConfigService, private readonly dispatcher: DurableOutboxDispatcherService,
    @InjectRepository(Project) private readonly projects: Repository<Project>, @InjectRepository(DeploymentIntent) private readonly intents: Repository<DeploymentIntent>,
    @InjectRepository(InfrastructureManifest) private readonly manifests: Repository<InfrastructureManifest>, @InjectRepository(InitialReleaseDraft) private readonly drafts: Repository<InitialReleaseDraft>, @InjectRepository(OrchestrationOutbox) private readonly outbox: Repository<OrchestrationOutbox>) {}
  async dispatch(user: User, projectId: string) {
    return this.dispatchInternal(user, projectId, null, false);
  }

  /** Automatic continuation may dispatch only the exact policy-approved child. */
  async dispatchApprovedContinuation(projectId: string, childIntentId: string) {
    return this.dispatchInternal(
      { id: 0, role: UserRole.ADMIN } as User,
      projectId,
      childIntentId,
      true,
    );
  }

  private async dispatchInternal(user: User, projectId: string, expectedChildId: string | null, requirePolicy: boolean) {
    if (!this.enabled(projectId)) return { state: "disabled", safeCodes: ["NORMAL_FIRST_RELEASE_INFRASTRUCTURE_APPLY_EXECUTION_DISABLED"] };
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.DEVELOPER) return { state: "blocked", safeCodes: ["NORMAL_FIRST_RELEASE_INFRASTRUCTURE_APPLY_ACTOR_NOT_ALLOWED"] };
    const project = await this.projects.findOneBy({ id: projectId }); if (!project) throw new NotFoundException("Project not found.");
    if (user.role !== UserRole.ADMIN && project.ownerUserId !== user.id) throw new ForbiddenException("You do not have permission to execute this project.");
    const child = await this.intents.findOne({ where: { ...(expectedChildId ? { id: expectedChildId } : {}), projectId, environmentName: "dev", kind: "apply", classification: "infrastructure_change", status: "planned" }, order: { createdAt: "DESC" } });
    if (!child || !child.infrastructureManifestId || child.releaseManifestId || child.requestPayload?.operation !== "infrastructure_apply_continuation") return this.blocked("NORMAL_FIRST_RELEASE_INFRASTRUCTURE_APPLY_EVIDENCE_MALFORMED");
    if (requirePolicy && !isApprovedInfrastructurePolicy(child.decision?.automaticContinuation)) {
      return this.blocked("NORMAL_FIRST_RELEASE_INFRASTRUCTURE_APPLY_POLICY_NOT_APPROVED");
    }
    const [manifest, draft, parent, outboxes] = await Promise.all([
      this.manifests.findOneBy({ id: child.infrastructureManifestId, projectId, environmentName: "dev" }),
      this.drafts.findOneBy({ projectId, environmentName: "dev", infrastructureManifestId: child.infrastructureManifestId }),
      this.intents.findOneBy({ id: String(child.requestPayload.parentPlanIntentId || "") }),
      this.outbox.find({ where: { intentId: child.id }, order: { createdAt: "ASC" } }),
    ]);
    const outbox = outboxes[0];
    const recoveredPlanParent = parent?.status === "failed"
      && parent.failureCode === "INFRASTRUCTURE_PLAN_CONTINUATION_FAILED"
      && child.requestPayload?.parentPlanIntentId === parent.id;
    const recoveredPreflightDelivery = recoveredPlanParent
      && ["reconciled_preflight", "reconciled_preflight_no_effect"].includes(String(child.requestPayload?.recoveryMode || ""))
      && typeof child.requestPayload?.recoveryOfApplyIntentId === "string";
    const validManifestStatus = manifest?.status === "planned"
      || (recoveredPreflightDelivery && manifest?.status === "manual_review"
        && manifest.appliedAt === null && manifest.stateVersionId === null);
    if (!manifest || !validManifestStatus || !draft || draft.draftHash !== canonicalSha256(draft.releaseDraft) || !parent || (parent.status !== "plan_completed" && !recoveredPlanParent)
      || parent.infrastructureManifestId !== manifest.id || outboxes.length !== 1 || !outbox || !this.validOutbox(outbox, child, manifest)) return this.blocked("NORMAL_FIRST_RELEASE_INFRASTRUCTURE_APPLY_EVIDENCE_MALFORMED");
    const result = await this.dispatcher.dispatchExact({ outboxId: outbox.id, intentId: child.id, projectId, environmentName: "dev" });
    return result.status === "published" ? { state: "dispatched", safeCodes: ["FIRST_RELEASE_INFRASTRUCTURE_APPLY_OUTBOX_DISPATCHED"] } : this.blocked("NORMAL_FIRST_RELEASE_INFRASTRUCTURE_APPLY_OUTBOX_NOT_DISPATCHABLE");
  }
  private validOutbox(outbox: OrchestrationOutbox, child: DeploymentIntent, manifest: InfrastructureManifest) {
    if (outbox.status !== "pending" || outbox.attemptCount !== 0 || outbox.claimedBy || outbox.claimExpiresAt || outbox.publishedAt || outbox.publishedJobId || outbox.eventType !== "intent.infrastructure.apply") return false;
    try { const e = validateWorkerEnvelopeV1(outbox.workerEnvelope); return e.protocol.messageType === "intent.infrastructure.apply" && e.routing.queue === "deployguard-infrastructure-v1" && e.identity.intentId === child.id && e.identity.infrastructureManifestId === manifest.id && e.idempotency.canonicalKey === child.canonicalIdempotencyKey && outbox.payloadSha256 === e.idempotency.payloadSha256; } catch { return false; }
  }
  private enabled(projectId: string) { return this.config.get<unknown>("TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED") === "true" && this.config.get<unknown>("TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_EXECUTION_ENABLED") === "true" && this.config.get<unknown>("TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_ENABLED") === "true" && normalV1AllowsScope(this.config, projectId, "dev"); }
  private blocked(code: string) { return { state: "blocked", safeCodes: [code] }; }
}
