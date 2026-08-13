import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { In, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { InfrastructureEnvironmentType, ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { Project } from "../projects/project.entity";
import { User } from "../users/user.entity";
import { CentralCloudResource } from "./central-cloud-resource.entity";
import { CentralCloudCleanupService } from "./central-cloud-cleanup.service";
import { ExecuteCentralCleanupDto } from "./dto/central-cloud-cleanup.dto";
import { EmergencyCleanupOperation } from "./emergency-cleanup-operation.entity";
import { EMERGENCY_CLEANUP_QUEUE, EmergencyCleanupJob } from "./lifecycle.queue";

@Injectable()
export class EmergencyCleanupService {
  constructor(
    @InjectRepository(EmergencyCleanupOperation) private readonly operations: Repository<EmergencyCleanupOperation>,
    @InjectRepository(ProjectInfrastructureEnvironment) private readonly environments: Repository<ProjectInfrastructureEnvironment>,
    @InjectRepository(CentralCloudResource) private readonly resources: Repository<CentralCloudResource>,
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @Inject(EMERGENCY_CLEANUP_QUEUE) private readonly queue: Queue<EmergencyCleanupJob>,
    private readonly cleanup: CentralCloudCleanupService,
    private readonly audit: AuditLogService,
  ) {}

  async preview() {
    const environments = await this.environments.find({ where: { environmentType: In([InfrastructureEnvironmentType.TESTING, InfrastructureEnvironmentType.PREVIEW]) }, order: { updatedAt: "DESC" } });
    const records = await this.resources.find({ where: { status: In(["active", "cleanup_required", "orphan"]) } });
    const projects = new Map((await this.projects.find()).map((project) => [project.id, project]));
    const targets = environments.filter((environment, index, all) => all.findIndex((candidate) => candidate.projectId === environment.projectId) === index).flatMap((environment) => {
      const eligible = records.filter((resource) => resource.projectId === environment.projectId && !resource.protected && resource.ownership !== "shared" && resource.tags?.ManagedBy === "DeployGuard" && ["testing", "preview", "dev"].includes(String(resource.tags?.Environment || "").toLowerCase()));
      if (!eligible.length) return [];
      const project = projects.get(environment.projectId);
      return [{ projectId: environment.projectId, projectName: project?.name || environment.projectId, environmentId: environment.id, environmentName: environment.environmentName, environmentType: environment.environmentType, resourceCount: eligible.length, highCostCount: eligible.filter((resource) => resource.costRisk === "high").length }];
    });
    return { targets, targetCount: targets.length, resourceCount: targets.reduce((sum, target) => sum + target.resourceCount, 0), productionExcluded: true, confirmationPhrase: "DESTROY ALL DEPLOYGUARD TEST RESOURCES" };
  }

  async start(user: User, dto: ExecuteCentralCleanupDto, req?: any) {
    await this.cleanup.consumeEmergencyChallenge(user, dto);
    const preview = await this.preview();
    if (!preview.targets.length) throw new BadRequestException("No tagged DeployGuard testing or preview resources are eligible for emergency cleanup.");
    const operation = await this.operations.save(this.operations.create({ userId: user.id, status: "queued", queueJobId: null, targetCount: preview.targets.length, completedCount: 0, failedCount: 0, targets: preview.targets.map((target) => ({ ...target, status: "queued", destroyOperationId: null })), errorMessage: null, startedAt: null, completedAt: null }));
    const job = await this.queue.add("emergency-cleanup", { operationId: operation.id }, { jobId: operation.id, priority: 1 });
    operation.queueJobId = String(job.id); await this.operations.save(operation);
    await this.audit.record({ actorUser: user, action: "EMERGENCY_NON_PRODUCTION_CLEANUP_QUEUED", resourceType: "emergency_cleanup", resourceId: operation.id, status: "success", metadata: { projectCount: operation.targetCount, productionExcluded: true }, req });
    return this.safe(operation);
  }

  async list() { return (await this.operations.find({ order: { createdAt: "DESC" }, take: 25 })).map((operation) => this.safe(operation)); }
  async get(id: string) { const operation = await this.operations.findOne({ where: { id } }); return operation ? this.safe(operation) : null; }
  private safe(operation: EmergencyCleanupOperation) { return { id: operation.id, status: operation.status, targetCount: operation.targetCount, completedCount: operation.completedCount, failedCount: operation.failedCount, targets: operation.targets, errorMessage: operation.errorMessage, createdAt: operation.createdAt, startedAt: operation.startedAt, completedAt: operation.completedAt }; }
}
