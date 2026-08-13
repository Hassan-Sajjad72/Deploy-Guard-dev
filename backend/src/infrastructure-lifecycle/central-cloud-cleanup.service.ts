import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { Request } from "express";
import { In, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { AwsCliService } from "../state-management/aws-cli.service";
import { TerraformStateService } from "../state-management/terraform-state.service";
import { User } from "../users/user.entity";
import { CentralCleanupChallenge } from "./central-cleanup-challenge.entity";
import { CentralCloudResource } from "./central-cloud-resource.entity";
import { CentralCloudInventoryService } from "./central-cloud-inventory.service";
import { CloudCleanupSafetyService } from "./cloud-cleanup-safety.service";
import { ExecuteCentralCleanupDto } from "./dto/central-cloud-cleanup.dto";
import { InfrastructureLifecycleService } from "./infrastructure-lifecycle.service";
import { CloudCleanupOperation } from "./cloud-cleanup-operation.entity";

@Injectable()
export class CentralCloudCleanupService {
  constructor(
    @InjectRepository(CentralCloudResource) private readonly resources: Repository<CentralCloudResource>,
    @InjectRepository(CentralCleanupChallenge) private readonly challenges: Repository<CentralCleanupChallenge>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(CloudCleanupOperation) private readonly cleanupOperations: Repository<CloudCleanupOperation>,
    private readonly inventory: CentralCloudInventoryService,
    private readonly safety: CloudCleanupSafetyService,
    private readonly lifecycle: InfrastructureLifecycleService,
    private readonly state: TerraformStateService,
    private readonly aws: AwsCliService,
    private readonly config: ConfigService,
    private readonly audit: AuditLogService,
  ) {}

  async issueChallenge(user: User, action: "selected" | "safe_orphans" | "emergency_non_production", req?: Request) {
    this.assertRecentAuthentication(user);
    const token = randomBytes(32).toString("base64url");
    const confirmationPhrase = action === "selected" ? "DELETE SELECTED RESOURCES" : action === "safe_orphans" ? "CLEAN SAFE ORPHANS" : "DESTROY ALL DEPLOYGUARD TEST RESOURCES";
    const challenge = await this.challenges.save(this.challenges.create({ userId: user.id, action, tokenHash: this.hash(token), confirmationPhrase, expiresAt: new Date(Date.now() + 5 * 60_000), usedAt: null }));
    await this.audit.record({ actorUser: user, action: "CENTRAL_CLOUD_CLEANUP_CHALLENGE_ISSUED", resourceType: "cloud_cleanup", resourceId: challenge.id, status: "success", metadata: { cleanupAction: action }, req });
    return { challengeId: challenge.id, challengeToken: token, confirmationPhrase, expiresAt: challenge.expiresAt };
  }

  async cleanupSelected(user: User, dto: ExecuteCentralCleanupDto, req?: Request) {
    await this.consumeChallenge(user, dto, "selected");
    if (!dto.resourceIds?.length) throw new BadRequestException("Select at least one safe resource.");
    return this.recordedCleanup(user, dto.resourceIds, false, "selected", req);
  }

  async cleanupSafeOrphans(user: User, dto: ExecuteCentralCleanupDto, req?: Request) {
    await this.consumeChallenge(user, dto, "safe_orphans");
    const orphanResources = await this.resources.find({ where: { status: "orphan", safeToCleanup: true, protected: false } });
    if (!orphanResources.length) return { results: [], inventory: await this.inventory.refresh(user, req) };
    return this.recordedCleanup(user, orphanResources.map((resource) => resource.id), true, "safe_orphans", req);
  }

  async consumeEmergencyChallenge(user: User, dto: ExecuteCentralCleanupDto) { await this.consumeChallenge(user, dto, "emergency_non_production"); }

  async cleanupEmergencyResidues(projectId: string, userId: number) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException("Emergency cleanup actor no longer exists.");
    const targets = await this.resources.find({ where: { projectId, safeToCleanup: true, protected: false } });
    const direct = targets.filter((resource) => resource.cleanupEligibility === "safe_cleanup" && resource.status !== "deleted" && resource.tags?.ManagedBy === "DeployGuard" && ["testing", "preview", "dev"].includes(String(resource.tags?.Environment || "").toLowerCase()));
    if (!direct.length) return { results: [], skipped: targets.length };
    return this.cleanup(user, direct.map((resource) => resource.id), false);
  }

  private async recordedCleanup(user: User, resourceIds: string[], orphanOnly: boolean, mode: string, req?: Request) {
    const operation = await this.cleanupOperations.save(this.cleanupOperations.create({ userId: user.id, mode, status: "running", resourceIds, results: null, errorMessage: null, completedAt: null }));
    try {
      const response = await this.cleanup(user, resourceIds, orphanOnly, req);
      operation.results = response.results; operation.status = response.results.some((result) => result.status === "failed") ? "completed_with_errors" : "completed"; operation.completedAt = new Date();
      await this.cleanupOperations.save(operation);
      return { ...response, operationId: operation.id };
    } catch (error) {
      operation.status = "failed"; operation.errorMessage = this.safeError(error); operation.completedAt = new Date(); await this.cleanupOperations.save(operation); throw error;
    }
  }

  async retryProjectDestroy(user: User, projectId: string, operationId: string) {
    this.assertRecentAuthentication(user);
    return this.lifecycle.retry(user, projectId, operationId);
  }

  async report() {
    const [{ resources }, summary] = await Promise.all([this.inventory.resources(), this.inventory.summary()]);
    const header = ["Resource ID", "Name", "Type", "AWS Service", "Region", "Project ID", "Project Name", "Source", "Status", "Cost Risk", "Safe to cleanup", "Reason", "Last seen"];
    const rows = resources.map((resource) => [resource.id, resource.name, resource.type, resource.awsService, resource.region, resource.projectId || "", resource.projectName || "", resource.source, resource.status, resource.costRisk, resource.safeToCleanup ? "yes" : "no", resource.reason, resource.lastSeen]);
    return { filename: `deployguard-cloud-cleanup-${new Date().toISOString().slice(0, 10)}.csv`, csv: [header, ...rows].map((row) => row.map((value) => this.csv(value)).join(",")).join("\n"), summary: summary.summary };
  }

  private async cleanup(user: User, resourceIds: string[], orphanOnly: boolean, req?: Request) {
    const targets = await this.resources.find({ where: { id: In(resourceIds) } });
    if (targets.length !== new Set(resourceIds).size) throw new NotFoundException("One or more selected cloud resources were not found.");
    for (const target of targets) {
      try { this.safety.assertCleanupAllowed(target, orphanOnly); }
      catch (error) { await this.audit.record({ actorUser: user, action: target.protected ? "CENTRAL_CLOUD_PROTECTED_RESOURCE_SKIPPED" : "CENTRAL_CLOUD_MANUAL_REVIEW_REQUIRED", resourceType: "cloud_resource", resourceId: target.id, status: "warning", metadata: { projectId: target.projectId, resourceType: target.resourceType, reason: error instanceof Error ? error.message : String(error) }, req }); throw error; }
    }
    await this.audit.record({ actorUser: user, action: "CENTRAL_CLOUD_CLEANUP_SELECTED", resourceType: "cloud_cleanup", status: "success", metadata: { cleanupMode: orphanOnly ? "safe_orphans" : "selected", resourceCount: targets.length }, req });
    const results: Array<{ id: string; status: "deleted" | "failed"; message: string }> = [];
    const priority: Record<string, number> = { ecs_service: 1, ecs_task: 2, ecs_task_definition: 3, ecs_cluster: 4 };
    for (const target of targets.sort((a, b) => (priority[a.resourceType] || 10) - (priority[b.resourceType] || 10))) {
      await this.audit.record({ actorUser: user, action: "CENTRAL_CLOUD_CLEANUP_STARTED", resourceType: "cloud_resource", resourceId: target.id, status: "success", metadata: { projectId: target.projectId, resourceType: target.resourceType }, req });
      try {
        await this.deleteResource(target);
        target.status = "deleted"; target.deletedAt = new Date(); target.safeToCleanup = false;
        await this.resources.save(target);
        results.push({ id: target.id, status: "deleted", message: "Cleanup request completed." });
        await this.audit.record({ actorUser: user, action: "CENTRAL_CLOUD_CLEANUP_COMPLETED", resourceType: "cloud_resource", resourceId: target.id, status: "success", metadata: { projectId: target.projectId, resourceType: target.resourceType }, req });
      } catch (error) {
        const message = this.safeError(error); results.push({ id: target.id, status: "failed", message });
        target.status = "manual_review"; target.safeToCleanup = false; target.manualReviewAt = new Date(); target.reason = `Automatic cleanup failed and requires dependency review: ${message}`;
        await this.resources.save(target);
        await this.audit.record({ actorUser: user, action: "CENTRAL_CLOUD_CLEANUP_FAILED", resourceType: "cloud_resource", resourceId: target.id, status: "failed", metadata: { projectId: target.projectId, resourceType: target.resourceType, reason: message }, req });
      }
    }
    return { results, inventory: await this.inventory.refresh(user, req) };
  }

  private async deleteResource(resource: CentralCloudResource) {
    const projectId = resource.projectId!;
    if (resource.resourceType === "ecr_repository") { await this.aws.run(["ecr", "delete-repository", "--repository-name", resource.resourceName, "--force"]); return; }
    if (resource.resourceType === "secret") { const force = this.config.get<string>("SECRETS_FORCE_DELETE_WITHOUT_RECOVERY", "false").toLowerCase() === "true"; await this.aws.run(["secretsmanager", "delete-secret", "--secret-id", resource.arn || resource.resourceName, ...(force ? ["--force-delete-without-recovery"] : ["--recovery-window-in-days", "7"])]); return; }
    if (resource.resourceType === "log_group") { await this.aws.run(["logs", "delete-log-group", "--log-group-name", resource.resourceName]); return; }
    if (resource.resourceType === "ecs_service") { const cluster = this.ecsClusterFromArn(resource.arn!); await this.aws.run(["ecs", "update-service", "--cluster", cluster, "--service", resource.arn!, "--desired-count", "0"]); await this.aws.run(["ecs", "delete-service", "--cluster", cluster, "--service", resource.arn!, "--force"]); return; }
    if (resource.resourceType === "ecs_task") { const cluster = this.ecsClusterFromArn(resource.arn!); await this.aws.run(["ecs", "stop-task", "--cluster", cluster, "--task", resource.arn!, "--reason", "DeployGuard central cleanup"]); return; }
    if (resource.resourceType === "ecs_task_definition") { await this.aws.run(["ecs", "deregister-task-definition", "--task-definition", resource.arn || resource.resourceKey]); return; }
    if (resource.resourceType === "ecs_cluster") { await this.aws.run(["ecs", "delete-cluster", "--cluster", resource.arn || resource.resourceName]); return; }
    if (resource.resourceType === "terraform_lockfile") { const environment = this.environmentFromStateKey(resource.resourceName); const lock = await this.state.inspectNativeLockfile({ id: projectId }, environment); if (!lock.exists || !lock.stale || lock.key !== resource.resourceName) throw new Error("Only a confirmed stale project lockfile can be removed."); await this.state.clearStaleNativeLockfile({ id: projectId }, environment); return; }
    throw new Error("Automatic cleanup is not implemented for this resource type.");
  }

  private async consumeChallenge(user: User, dto: ExecuteCentralCleanupDto, action: "selected" | "safe_orphans" | "emergency_non_production") {
    this.assertRecentAuthentication(user);
    const challenge = await this.challenges.findOne({ where: { id: dto.challengeId, userId: user.id, action } });
    if (!challenge || challenge.usedAt || challenge.expiresAt.getTime() <= Date.now()) throw new BadRequestException("Cleanup challenge is invalid, expired, or already used.");
    const supplied = Buffer.from(this.hash(dto.challengeToken)); const expected = Buffer.from(challenge.tokenHash);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || dto.confirmationPhrase !== challenge.confirmationPhrase) throw new BadRequestException("Cloud cleanup confirmation did not match the server-issued challenge.");
    challenge.usedAt = new Date(); await this.challenges.save(challenge);
  }

  private assertRecentAuthentication(user: User) { const maxAge = Number(this.config.get<string>("DESTROY_RECENT_AUTH_MINUTES", "15")) * 60_000; if (!user.lastLoginAt || Date.now() - new Date(user.lastLoginAt).getTime() > maxAge) throw new ForbiddenException("Recent authentication is required before cloud cleanup. Sign in again."); }
  private environmentFromStateKey(value: string) { return value.match(/terraform\.([^.\/]+)\.tfstate\.tflock$/)?.[1] || "dev"; }
  private ecsClusterFromArn(value: string) { const cluster = value.match(/(?:service|task)\/([^/]+)\//)?.[1]; if (!cluster) throw new Error("ECS resource is missing its cluster scope."); return cluster; }
  private hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
  private safeError(error: unknown) { return this.aws.sanitize(error instanceof Error ? error.message : String(error)).slice(0, 1000); }
  private csv(value: unknown) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }
}
