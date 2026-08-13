import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { Project, ProjectStatus, ProjectVisibility } from "../projects/project.entity";
import { User, UserRole } from "../users/user.entity";
import { DeploymentQueueStatus, ProjectDeploymentQueueItem } from "./project-deployment-queue-item.entity";
import { ProjectStateRecoveryRequest } from "./project-state-recovery-request.entity";
import { ProjectStateValidationResult } from "./project-state-validation-result.entity";
import { ProjectTerraformLock } from "./project-terraform-lock.entity";
import { ProjectTerraformState } from "./project-terraform-state.entity";
import { StateCorruptionService } from "./state-corruption.service";
import { StateLockService } from "./state-lock.service";
import { StateRecoveryService } from "./state-recovery.service";
import { TerraformStateService } from "./terraform-state.service";
import { CurrentStateInvalidationService } from "./current-state-invalidation.service";
import { TerraformStateSafetySnapshotService } from "./terraform-state-safety-snapshot.service";

@Injectable()
export class StateManagementService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectTerraformState)
    private readonly stateRepository: Repository<ProjectTerraformState>,
    @InjectRepository(ProjectTerraformLock)
    private readonly lockRepository: Repository<ProjectTerraformLock>,
    @InjectRepository(ProjectDeploymentQueueItem)
    private readonly queueRepository: Repository<ProjectDeploymentQueueItem>,
    @InjectRepository(ProjectStateValidationResult)
    private readonly validationRepository: Repository<ProjectStateValidationResult>,
    @InjectRepository(ProjectStateRecoveryRequest)
    private readonly recoveryRepository: Repository<ProjectStateRecoveryRequest>,
    private readonly terraformStateService: TerraformStateService,
    private readonly lockService: StateLockService,
    private readonly corruptionService: StateCorruptionService,
    private readonly recoveryService: StateRecoveryService,
    private readonly auditLogService: AuditLogService,
    private readonly stateSafety: TerraformStateSafetySnapshotService,
    private readonly currentStateInvalidation: CurrentStateInvalidationService,
  ) {}

  async getSafetySnapshot(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.stateSafety.get(project.id);
  }

  async getState(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    const state = await this.stateRepository.findOne({
      where: { projectId: project.id, environmentName: "dev" },
    });

    return state ? this.toStateResponse(state) : null;
  }

  async getVersions(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.terraformStateService.listStateVersions(project, "dev");
  }

  async getLocks(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    const lock = await this.lockRepository.findOne({
      where: { lockId: this.lockService.buildLockId(project.id, "dev") },
    });
    const queue = await this.queueRepository.find({
      where: [
        { projectId: project.id, status: DeploymentQueueStatus.QUEUED },
        { projectId: project.id, status: DeploymentQueueStatus.WAITING_FOR_LOCK },
        { projectId: project.id, status: DeploymentQueueStatus.PROCESSING },
      ],
      order: { position: "ASC", createdAt: "ASC" },
    });

    const s3Lockfile = await this.terraformStateService.inspectNativeLockfile(project, "dev")
      .catch((error) => ({
        exists: false,
        stale: false,
        key: this.terraformStateService.buildLockfileKey(project, "dev"),
        lastModified: null,
        error: error instanceof Error ? error.message : "Unable to inspect Terraform S3 lockfile.",
      }));

    return { lock, queue, s3Lockfile };
  }

  async getValidationResults(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.validationRepository.find({
      where: { projectId: project.id },
      order: { createdAt: "DESC" },
      take: 50,
    });
  }

  async validate(user: User, projectId: string) {
    const project = await this.findProjectForManage(user, projectId);
    await this.audit("STATE_VALIDATION_STARTED", project.id, user, "success");
    const rawState = await this.terraformStateService.getStateObject(project, "dev");
    const result = await this.corruptionService.detectCorruption(
      project.id,
      "dev",
      rawState,
      false
    );
    await this.audit(
      result.status === "corrupted" ? "STATE_VALIDATION_FAILED" : result.status === "warning" ? "STATE_VALIDATION_WARNING" : "STATE_VALIDATION_PASSED",
      project.id,
      user,
      result.status === "corrupted" ? "failed" : "success",
      { validationResultId: result.id, status: result.status }
    );
    this.currentStateInvalidation.invalidate(project.id, "terraform_state_validated");

    return result;
  }

  async recover(user: User, projectId: string, dto: Record<string, unknown>) {
    const project = await this.findProjectForManage(user, projectId);
    const versionId = String(dto.versionId || "");

    if (!versionId) {
      throw new Error("versionId is required.");
    }

    const recovery = await this.recoveryService.restorePreviousVersion(
      project.id,
      "dev",
      versionId,
      user.id
    );
    await this.audit("STATE_VERSION_RESTORED", project.id, user, "success", {
      recoveryRequestId: recovery.id,
    });
    return recovery;
  }

  async forceRelease(user: User, projectId: string, lockId: string) {
    const project = await this.findProjectForView(user, projectId);

    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException("Only admins can force release state locks.");
    }

    const lock = await this.lockService.forceReleaseOrphanedLock(lockId);
    await this.audit("STATE_LOCK_FORCE_RELEASED", project.id, user, "success", {
      lockId,
    });
    return lock;
  }

  async clearStaleLockfile(user: User, projectId: string) {
    const project = await this.findProjectForManage(user, projectId);
    const result = await this.terraformStateService.clearStaleNativeLockfile(project, "dev");
    if (result.cleared) this.currentStateInvalidation.invalidate(project.id, "terraform_s3_lockfile_cleared");
    await this.audit("S3_STATE_LOCKFILE_CLEARED", project.id, user, "success", {
      lockfileKey: result.key,
      stale: result.stale,
      cleared: result.cleared,
    });
    return result;
  }

  async recoveryRequests(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.recoveryRepository.find({
      where: { projectId: project.id },
      order: { createdAt: "DESC" },
      take: 50,
    });
  }

  private async findProjectForView(user: User, projectId: string) {
    const project = await this.projectRepository.findOne({ where: { id: projectId } });

    if (!project || project.status === ProjectStatus.ARCHIVED) {
      throw new NotFoundException("Project not found");
    }

    if (
      user.role === UserRole.ADMIN ||
      project.ownerUserId === user.id ||
      (user.role === UserRole.READONLY && project.visibility === ProjectVisibility.WORKSPACE)
    ) {
      return project;
    }

    throw new ForbiddenException("Insufficient permissions");
  }

  private async findProjectForManage(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);

    if (user.role === UserRole.READONLY) {
      throw new ForbiddenException("Insufficient permissions");
    }

    if (user.role === UserRole.ADMIN || project.ownerUserId === user.id) {
      return project;
    }

    throw new ForbiddenException("Insufficient permissions");
  }

  private async audit(
    action: string,
    projectId: string,
    actorUser: User,
    status: string,
    metadata: Record<string, unknown> = {}
  ) {
    await this.auditLogService.record({
      actorUser,
      action,
      resourceType: "terraform_state",
      resourceId: projectId,
      status,
      metadata: {
        projectId,
        ...metadata,
      },
    });
  }

  private toStateResponse(state: ProjectTerraformState) {
    return {
      id: state.id,
      projectId: state.projectId,
      environmentName: state.environmentName,
      stateBucket: state.stateBucket,
      stateKey: state.stateKey,
      stateRegion: state.stateRegion,
      currentVersionId: state.currentVersionId,
      previousVersionId: state.previousVersionId,
      checksum: state.checksum,
      resourceCount: state.resourceCount,
      dependencyGraphHash: state.dependencyGraphHash,
      status: state.status,
      lastValidatedAt: state.lastValidatedAt,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  }
}
