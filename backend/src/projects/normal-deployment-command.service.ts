import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource, EntityManager } from "typeorm";
import { User, UserRole } from "../users/user.entity";
import { Project } from "./project.entity";
import { ProjectCostSettings } from "../finops/project-cost-settings.entity";
import { canonicalSha256 } from "../orchestration-contracts/contracts/canonical-json";
import { DeploymentIntent } from "../orchestration-contracts/entities/deployment-intent.entity";
import { InfrastructureManifest } from "../orchestration-contracts/entities/infrastructure-manifest.entity";
import { InitialReleaseDraft } from "../orchestration-contracts/entities/initial-release-draft.entity";
import { OrchestrationOutbox } from "../orchestration-contracts/entities/orchestration-outbox.entity";
import { NormalFirstReleaseLanePlanningService } from "../orchestration-contracts/release-lane/normal-first-release-lane-planning.service";
import { NormalReleaseLanePlanningService } from "../orchestration-contracts/release-lane/normal-release-lane-planning.service";
import { NormalFirstReleaseInfrastructurePlanExecutionService } from "../orchestration-contracts/release-lane/normal-first-release-infrastructure-plan-execution.service";
import { NormalFirstReleaseInfrastructureApplyExecutionService } from "../orchestration-contracts/release-lane/normal-first-release-infrastructure-apply-execution.service";
import { NormalReleaseLaneExecutionService } from "../orchestration-contracts/release-lane/normal-release-lane-execution.service";
import { V1InfrastructurePlanReviewService } from "../orchestration-contracts/infrastructure/v1-infrastructure-plan-review.service";
import { normalV1AllowsScope } from "../orchestration-contracts/release-lane/normal-v1-activation-policy";
import { normalFirstReleasePlanOperationWhere } from "../orchestration-contracts/release-lane/normal-first-release-plan-operation";
import {
  AutomaticInfrastructurePolicy,
  decideAutomaticInfrastructurePolicy,
} from "./normal-deployment-cost-policy";
import { DurableOutboxDrainService } from "../orchestration-contracts/outbox/durable-outbox-drain.service";

type DeveloperDeploymentCommandResult = Readonly<{
  deployment: {
    state: "accepted" | "no_op" | "approval_required" | "platform_attention";
    message: string;
  };
}>;

type CommandMarker = Readonly<{
  schemaVersion: 1;
  operationKey: string;
  requestedByUserId: number;
  requestedAt: string;
}>;

const APPROVED_POLICY_STATES = new Set(["auto_approved", "owner_approved", "operator_approved"]);

/**
 * One product command over the existing exact normal-v1 boundaries.
 *
 * The HTTP method only prepares and publishes exact durable work. A default-off
 * timer in the API process observes command-marked durable evidence and resumes
 * safe continuation after independently supervised workers complete. It never
 * starts a worker or invokes Terraform/release handlers itself.
 */
@Injectable()
export class NormalDeploymentCommandService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NormalDeploymentCommandService.name);
  private readonly active = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly firstReleasePlanning: NormalFirstReleaseLanePlanningService,
    private readonly laterReleasePlanning: NormalReleaseLanePlanningService,
    private readonly planExecution: NormalFirstReleaseInfrastructurePlanExecutionService,
    private readonly applyExecution: NormalFirstReleaseInfrastructureApplyExecutionService,
    private readonly releaseExecution: NormalReleaseLaneExecutionService,
    private readonly planReview: V1InfrastructurePlanReviewService,
    private readonly durableOutboxDrain: DurableOutboxDrainService,
  ) {}

  onModuleInit() {
    if (!this.automaticEnabled()) return;
    const interval = boundedInteger(
      this.config.get<unknown>("NORMAL_V1_AUTOMATIC_CONTINUATION_INTERVAL_MS"),
      1_000,
      60_000,
      5_000,
    );
    this.timer = setInterval(() => void this.scan(), interval);
    this.timer.unref();
    this.logger.log("NORMAL_V1_AUTOMATIC_CONTINUATION_READY");
    void this.scan();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.active.size) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async deploy(user: User, projectId: string): Promise<DeveloperDeploymentCommandResult> {
    const project = await this.authorizedProject(user, projectId);
    if (!this.enabledFor(project.id) || !this.durableOutboxDrain.readiness().ready) {
      return attention();
    }

    const first = await this.firstReleasePlanning.prepare(user, project.id);
    if (first.state === "prepared") {
      await this.bindCommand(first.intent.id, user.id);
      if (first.intent.nextBoundary === "release") {
        return this.dispatchRelease(user, project.id, first.intent.id);
      }
      const result = await this.planExecution.dispatch(user, project.id);
      if (result.state === "dispatched" || await this.isPublished(first.intent.id)) {
        return accepted("Deployment accepted. Infrastructure planning is queued.");
      }
      return attention();
    }
    if (first.state !== "not_applicable") return attention();

    const later = await this.laterReleasePlanning.prepare(user, project.id);
    if (later.state === "no_op") return noOp();
    if (later.state !== "prepared") return attention();
    await this.bindCommand(later.intent.id, user.id);
    return this.dispatchRelease(user, project.id, later.intent.id);
  }

  async approveCost(user: User, projectId: string): Promise<DeveloperDeploymentCommandResult> {
    const project = await this.authorizedProject(user, projectId);
    // Cost approval is a workspace/project-owner action, not an operator bypass.
    if (project.ownerUserId !== user.id || !this.enabledFor(project.id)) {
      throw new ForbiddenException("Only the project owner can approve deployment cost.");
    }
    const root = await this.commandRoot(project.id);
    const child = root ? await this.applyChild(root) : null;
    if (!root || !child || child.status !== "planned" || !child.infrastructureManifestId) {
      return attention();
    }
    const manifest = await this.dataSource.getRepository(InfrastructureManifest)
      .findOneBy({ id: child.infrastructureManifestId, projectId, environmentName: "dev" });
    if (!manifest) return attention();
    const expected = await this.policyFor(manifest);
    if (expected.state !== "owner_required") return attention();

    const approved = await this.serializable(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`deployguard:normal-deploy-cost:${child.id}`]);
      await manager.query("SELECT id FROM deployment_intents WHERE id = $1 FOR UPDATE", [child.id]);
      const locked = await manager.getRepository(DeploymentIntent).findOneByOrFail({ id: child.id });
      const current = record(locked.decision?.automaticContinuation);
      if (current.state === "owner_approved" && current.evidenceHash === expected.evidenceHash) return locked;
      if (current.state !== "owner_required" || current.evidenceHash !== expected.evidenceHash
        || locked.status !== "planned" || locked.infrastructureManifestId !== manifest.id) {
        throw new Error("NORMAL_V1_COST_APPROVAL_EVIDENCE_CHANGED");
      }
      locked.decision = {
        ...(locked.decision || {}),
        approvalRequired: false,
        automaticContinuation: {
          ...current,
          state: "owner_approved",
          approvalRequired: false,
          approvedByUserId: user.id,
          approvedAt: new Date().toISOString(),
        },
      };
      return manager.getRepository(DeploymentIntent).save(locked);
    });
    const result = await this.applyExecution.dispatchApprovedContinuation(project.id, approved.id);
    return result.state === "dispatched" || await this.isPublished(approved.id)
      ? accepted("Cost approved. Infrastructure apply is queued.")
      : attention();
  }

  async advanceProject(projectId: string) {
    if (this.stopping || !this.enabledFor(projectId) || this.active.has(projectId)) return;
    this.active.add(projectId);
    try {
      const root = await this.commandRoot(projectId);
      if (!root || root.status !== "plan_completed" || !root.infrastructureManifestId) return;
      const child = await this.applyChild(root);
      if (!child) return;

      if (child.status === "planned") {
        const manifest = await this.dataSource.getRepository(InfrastructureManifest)
          .findOneBy({ id: root.infrastructureManifestId, projectId, environmentName: "dev" });
        if (!manifest) return;
        const policy = await this.policyFor(manifest);
        const persisted = await this.persistPolicy(root, child, manifest, policy);
        const persistedPolicy = record(persisted.decision?.automaticContinuation);
        if (APPROVED_POLICY_STATES.has(String(persistedPolicy.state))) {
          await this.applyExecution.dispatchApprovedContinuation(projectId, persisted.id);
        }
        return;
      }

      if (child.status === "completed") {
        const manifest = await this.dataSource.getRepository(InfrastructureManifest)
          .findOneBy({ id: root.infrastructureManifestId, projectId, environmentName: "dev", status: "applied" });
        if (!manifest || !root.requestedByUserId) return;
        const user = await this.dataSource.getRepository(User).findOneBy({ id: root.requestedByUserId });
        if (!user) return;
        const existingRelease = await this.releaseContinuation(root);
        if (existingRelease) {
          if (existingRelease.status === "planned" && !await this.isPublished(existingRelease.id)) {
            await this.releaseExecution.dispatch(user, projectId);
          }
          return;
        }
        const prepared = await this.firstReleasePlanning.prepare(user, projectId);
        if (prepared.state !== "prepared" || prepared.intent.nextBoundary !== "release") return;
        await this.bindCommand(prepared.intent.id, user.id, commandMarker(root)?.operationKey);
        await this.releaseExecution.dispatch(user, projectId);
      }
    } catch {
      // The persisted state remains the source of truth. A later bounded scan
      // re-inspects it; no mutation is blindly repeated here.
      this.logger.warn("NORMAL_V1_AUTOMATIC_CONTINUATION_PAUSED");
    } finally {
      this.active.delete(projectId);
    }
  }

  private async scan() {
    if (this.stopping || !this.automaticEnabled()) return;
    const roots = await this.dataSource.getRepository(DeploymentIntent)
      .createQueryBuilder("intent")
      .select(["intent.id", "intent.projectId"])
      .where("intent.environmentName = :environment", { environment: "dev" })
      .andWhere("intent.classification = :classification", { classification: "infrastructure_change" })
      .andWhere("intent.status = :status", { status: "plan_completed" })
      .andWhere("intent.decision -> 'developerCommand' ->> 'schemaVersion' = :version", { version: "1" })
      .orderBy("intent.updatedAt", "ASC")
      .take(50)
      .getMany();
    for (const root of roots) await this.advanceProject(root.projectId);
  }

  private async dispatchRelease(user: User, projectId: string, intentId: string) {
    const result = await this.releaseExecution.dispatch(user, projectId);
    if (result.state === "dispatched" || await this.isPublished(intentId)) {
      return accepted("Deployment accepted. Release execution is queued.");
    }
    return attention();
  }

  private async authorizedProject(user: User, projectId: string) {
    if (![UserRole.ADMIN, UserRole.DEVELOPER].includes(user.role)) {
      throw new ForbiddenException("You do not have permission to deploy projects.");
    }
    const project = await this.dataSource.getRepository(Project).findOneBy({ id: projectId });
    if (!project) throw new NotFoundException("Project not found.");
    if (user.role !== UserRole.ADMIN && project.ownerUserId !== user.id) {
      throw new ForbiddenException("You do not have permission to deploy this project.");
    }
    if (project.environmentName !== "dev") throw new ForbiddenException("This environment cannot be deployed.");
    return project;
  }

  private async bindCommand(intentId: string, userId: number, inheritedOperationKey?: string) {
    return this.serializable(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`deployguard:normal-deploy-command:${intentId}`]);
      await manager.query("SELECT id FROM deployment_intents WHERE id = $1 FOR UPDATE", [intentId]);
      const intent = await manager.getRepository(DeploymentIntent).findOneByOrFail({ id: intentId });
      const operationKey = inheritedOperationKey || canonicalSha256({
        projectId: intent.projectId,
        environmentName: intent.environmentName,
        canonicalIdempotencyKey: intent.canonicalIdempotencyKey,
        requestFingerprint: intent.requestFingerprint,
        infrastructureManifestId: intent.infrastructureManifestId,
        releaseManifestId: intent.releaseManifestId,
      });
      const existing = commandMarker(intent);
      if (existing) {
        if (existing.operationKey !== operationKey) throw new Error("NORMAL_V1_DEPLOYMENT_COMMAND_IDENTITY_CONFLICT");
        return intent;
      }
      const marker: CommandMarker = {
        schemaVersion: 1,
        operationKey,
        requestedByUserId: userId,
        requestedAt: new Date().toISOString(),
      };
      intent.decision = { ...(intent.decision || {}), developerCommand: marker };
      return manager.getRepository(DeploymentIntent).save(intent);
    });
  }

  private async commandRoot(projectId: string) {
    const candidates = await this.dataSource.getRepository(DeploymentIntent).find({
      where: normalFirstReleasePlanOperationWhere(
        projectId,
        ["planned", "enqueued", "running", "plan_completed"],
      ),
      order: { receivedAt: "DESC" },
      take: 32,
    });
    const matches = candidates.filter((intent) => commandMarker(intent));
    return matches.length === 1 ? matches[0] : null;
  }

  private async applyChild(root: DeploymentIntent) {
    const candidates = await this.dataSource.getRepository(DeploymentIntent).find({
      where: { projectId: root.projectId, environmentName: "dev", kind: "apply", classification: "infrastructure_change" },
      order: { createdAt: "DESC" },
      take: 16,
    });
    const matches = candidates.filter((candidate) => candidate.requestPayload?.parentPlanIntentId === root.id
      && candidate.requestPayload?.operation === "infrastructure_apply_continuation");
    return matches.length === 1 ? matches[0] : null;
  }

  private async releaseContinuation(root: DeploymentIntent) {
    const operationKey = commandMarker(root)?.operationKey;
    if (!operationKey) return null;
    const candidates = await this.dataSource.getRepository(DeploymentIntent).find({
      where: { projectId: root.projectId, environmentName: "dev", classification: "release_only" },
      order: { receivedAt: "DESC" },
      take: 16,
    });
    const matches = candidates.filter((candidate) => commandMarker(candidate)?.operationKey === operationKey);
    return matches.length === 1 ? matches[0] : null;
  }

  private async policyFor(manifest: InfrastructureManifest) {
    const [review, settings] = await Promise.all([
      this.planReview.review(manifest.id),
      this.dataSource.getRepository(ProjectCostSettings).findOneBy({ projectId: manifest.projectId }),
    ]);
    return decideAutomaticInfrastructurePolicy({
      planHash: review.planHash,
      costEstimate: review.costEstimate,
      resourceSummary: review.resourceSummary,
      thresholdMonthlyCost: settings?.warningThresholdMonthlyCost
        ?? boundedNumber(this.config.get<unknown>("NORMAL_V1_DEFAULT_COST_THRESHOLD_MONTHLY"), 0, 1_000_000, 25),
      maxResourceChanges: boundedInteger(
        this.config.get<unknown>("NORMAL_V1_AUTOMATIC_MAX_RESOURCE_CHANGES"),
        1,
        10_000,
        100,
      ),
    });
  }

  private async persistPolicy(root: DeploymentIntent, child: DeploymentIntent, manifest: InfrastructureManifest, policy: AutomaticInfrastructurePolicy) {
    return this.serializable(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`deployguard:normal-deploy-policy:${child.id}`]);
      await manager.query("SELECT id FROM deployment_intents WHERE id = $1 FOR UPDATE", [child.id]);
      const locked = await manager.getRepository(DeploymentIntent).findOneByOrFail({ id: child.id });
      const current = record(locked.decision?.automaticContinuation);
      if (Object.keys(current).length) {
        if (current.evidenceHash !== policy.evidenceHash) throw new Error("NORMAL_V1_AUTOMATIC_POLICY_EVIDENCE_CHANGED");
        return locked;
      }
      if (locked.status !== "planned" || locked.infrastructureManifestId !== manifest.id
        || locked.requestPayload?.parentPlanIntentId !== root.id
        || manifest.status !== "planned" || manifest.planArtifactSha256 !== policy.planHash) {
        throw new Error("NORMAL_V1_AUTOMATIC_POLICY_EVIDENCE_INVALID");
      }
      locked.decision = {
        ...(locked.decision || {}),
        approvalRequired: policy.approvalRequired,
        automaticContinuation: { ...policy, decidedAt: new Date().toISOString() },
      };
      return manager.getRepository(DeploymentIntent).save(locked);
    });
  }

  private async isPublished(intentId: string) {
    const outbox = await this.dataSource.getRepository(OrchestrationOutbox).findOne({
      where: { intentId },
      order: { createdAt: "DESC" },
    });
    return outbox?.status === "published" && Boolean(outbox.publishedJobId && outbox.publishedAt);
  }

  private async serializable<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.dataSource.transaction("SERIALIZABLE", operation);
      } catch (error) {
        const code = String((error as { code?: unknown })?.code || "");
        if (attempt === 3 || !["40001", "40P01"].includes(code)) throw error;
      }
    }
    throw new Error("NORMAL_V1_SERIALIZABLE_TRANSITION_EXHAUSTED");
  }

  private enabledFor(projectId: string) {
    return this.automaticEnabled() && normalV1AllowsScope(this.config, projectId, "dev");
  }

  private automaticEnabled() {
    return this.config.get<unknown>("TWO_LANE_NORMAL_AUTOMATIC_DEPLOY_ENABLED") === "true";
  }
}

function commandMarker(intent: DeploymentIntent): CommandMarker | null {
  const value = record(intent.decision?.developerCommand);
  return value.schemaVersion === 1
    && /^[0-9a-f]{64}$/.test(String(value.operationKey || ""))
    && Number.isInteger(value.requestedByUserId)
    && typeof value.requestedAt === "string"
    ? value as unknown as CommandMarker
    : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function accepted(message: string): DeveloperDeploymentCommandResult {
  return { deployment: { state: "accepted", message } };
}

function noOp(): DeveloperDeploymentCommandResult {
  return { deployment: { state: "no_op", message: "This exact source and configuration are already live." } };
}

function attention(): DeveloperDeploymentCommandResult {
  return { deployment: { state: "platform_attention", message: "The platform cannot continue this deployment automatically. No deployment was started." } };
}
