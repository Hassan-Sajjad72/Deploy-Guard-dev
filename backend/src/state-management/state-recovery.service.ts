import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Project } from "../projects/project.entity";
import { ProjectStateRecoveryRequest, StateRecoveryStatus } from "./project-state-recovery-request.entity";
import { TerraformStateStatus } from "./project-terraform-state.entity";
import { TerraformStateService } from "./terraform-state.service";
import { CurrentStateInvalidationService } from "./current-state-invalidation.service";

@Injectable()
export class StateRecoveryService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectStateRecoveryRequest)
    private readonly recoveryRepository: Repository<ProjectStateRecoveryRequest>,
    private readonly terraformStateService: TerraformStateService,
    private readonly currentStateInvalidation: CurrentStateInvalidationService,
  ) {}

  async listRecoverableVersions(projectId: string, environmentName = "dev") {
    const project = await this.requireProject(projectId);
    return this.terraformStateService.listStateVersions(project, environmentName);
  }

  async createRecoveryPrompt(projectId: string, versionId: string, userId?: number | null, reason?: string) {
    return this.recoveryRepository.save(
      this.recoveryRepository.create({
        projectId,
        environmentName: "dev",
        recoveryVersionId: versionId,
        requestedByUserId: userId || null,
        reason: reason || "Restore previous valid state.",
        status: StateRecoveryStatus.PENDING,
      })
    );
  }

  async restorePreviousVersion(projectId: string, environmentName: string, versionId: string, userId?: number | null) {
    const project = await this.requireProject(projectId);
    await this.terraformStateService.restoreStateVersion(project, environmentName, versionId);
    const request = await this.createRecoveryPrompt(projectId, versionId, userId, "State version restored.");
    request.status = StateRecoveryStatus.COMPLETED;
    request.approvedByUserId = userId || null;
    request.completedAt = new Date();
    await this.terraformStateService.upsertStateMetadata({
      project,
      environmentName,
      versionId,
      status: TerraformStateStatus.RECOVERED,
    });
    const saved = await this.recoveryRepository.save(request);
    this.currentStateInvalidation.invalidate(projectId, "terraform_state_version_restored");
    return saved;
  }

  async markRecoveryDecision(projectId: string, decision: "approved" | "rejected", userId?: number | null) {
    const request = await this.recoveryRepository.findOne({
      where: { projectId, status: StateRecoveryStatus.PENDING },
      order: { createdAt: "DESC" },
    });

    if (!request) {
      return null;
    }

    request.status = decision === "approved" ? StateRecoveryStatus.APPROVED : StateRecoveryStatus.REJECTED;
    request.approvedByUserId = userId || null;
    return this.recoveryRepository.save(request);
  }

  async recoveryRequests(projectId: string) {
    return this.recoveryRepository.find({
      where: { projectId },
      order: { createdAt: "DESC" },
      take: 50,
    });
  }

  private async requireProject(projectId: string) {
    const project = await this.projectRepository.findOne({ where: { id: projectId } });

    if (!project) {
      throw new Error("Project not found.");
    }

    return project;
  }
}
