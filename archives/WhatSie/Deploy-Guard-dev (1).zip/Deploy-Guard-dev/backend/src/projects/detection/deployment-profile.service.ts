import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Request } from "express";
import { Repository } from "typeorm";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { User } from "../../users/user.entity";
import {
  DetectionConfidence,
  DetectionStatus,
  ProjectDetectionProfile,
} from "../project-detection-profile.entity";
import { Project } from "../project.entity";
import { ProjectsService } from "../projects.service";
import { RepositoryWorkspaceService } from "./repository-workspace.service";
import {
  DeploymentProfileDraft,
  StackDetectionService,
} from "./stack-detection.service";

@Injectable()
export class DeploymentProfileService {
  constructor(
    @InjectRepository(ProjectDetectionProfile)
    private readonly profileRepository: Repository<ProjectDetectionProfile>,
    private readonly projectsService: ProjectsService,
    private readonly repositoryWorkspaceService: RepositoryWorkspaceService,
    private readonly stackDetectionService: StackDetectionService,
    private readonly auditLogService: AuditLogService
  ) {}

  async runDetection(user: User, projectId: string, req?: Request) {
    const project = await this.projectsService.getProjectEntityForManage(
      user,
      projectId
    );

    await this.auditLogService.record({
      actorUser: user,
      action: "STACK_DETECTION_STARTED",
      resourceType: "project",
      resourceId: project.id,
      status: "success",
      metadata: this.auditMetadata(project),
      req,
    });

    let workspacePath: string | null = null;

    try {
      const workspace = await this.repositoryWorkspaceService.cloneRepository({
        repositoryUrl: project.repositoryUrl,
        targetBranch: project.targetBranch,
      });
      workspacePath = workspace.workspacePath;
      const draft = this.stackDetectionService.detect(
        workspace.workspacePath,
        workspace.commitSha
      );
      const profile = await this.saveProfile(project, draft);

      await this.auditLogService.record({
        actorUser: user,
        action: "STACK_DETECTION_COMPLETED",
        resourceType: "project",
        resourceId: project.id,
        status: "success",
        metadata: this.auditMetadata(project, profile),
        req,
      });
      await this.auditLogService.record({
        actorUser: user,
        action: "DEPLOYMENT_PROFILE_GENERATED",
        resourceType: "project",
        resourceId: project.id,
        status: "success",
        metadata: this.auditMetadata(project, profile),
        req,
      });
      await this.auditLogService.record({
        actorUser: user,
        action: "TEMPLATE_SELECTED",
        resourceType: "project",
        resourceId: project.id,
        status: "success",
        metadata: this.auditMetadata(project, profile),
        req,
      });

      if (profile.detectionStatus === DetectionStatus.NEEDS_MANUAL_DOCKERFILE) {
        await this.auditLogService.record({
          actorUser: user,
          action: "MANUAL_DOCKERFILE_REQUIRED",
          resourceType: "project",
          resourceId: project.id,
          status: "success",
          metadata: this.auditMetadata(project, profile),
          req,
        });
      }

      return this.toProfileResponse(profile);
    } catch (error) {
      const profile = await this.saveFailedProfile(project, error);

      await this.auditLogService.record({
        actorUser: user,
        action: "STACK_DETECTION_FAILED",
        resourceType: "project",
        resourceId: project.id,
        status: "failed",
        metadata: this.auditMetadata(project, profile),
        req,
      });

      return this.toProfileResponse(profile);
    } finally {
      if (workspacePath) {
        await this.repositoryWorkspaceService.cleanup(workspacePath);
      }
    }
  }

  async getProfile(user: User, projectId: string) {
    const project = await this.projectsService.getProjectEntityForView(user, projectId);
    const profile = await this.profileRepository.findOne({
      where: { projectId: project.id },
    });

    if (!profile) {
      throw new NotFoundException("Detection profile not found");
    }

    return this.toProfileResponse(profile);
  }

  private async saveProfile(project: Project, draft: DeploymentProfileDraft) {
    const existing = await this.profileRepository.findOne({
      where: { projectId: project.id },
    });
    const profile = this.profileRepository.create({
      ...(existing || {}),
      projectId: project.id,
      repositoryUrl: project.repositoryUrl,
      repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch,
      ...draft,
    });

    return this.profileRepository.save(profile);
  }

  private async saveFailedProfile(project: Project, error: unknown) {
    const existing = await this.profileRepository.findOne({
      where: { projectId: project.id },
    });
    const profile = this.profileRepository.create({
      ...(existing || {}),
      projectId: project.id,
      repositoryUrl: project.repositoryUrl,
      repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch,
      commitSha: null,
      ecosystem: "unknown",
      language: null,
      framework: "unknown",
      frameworkVariant: "custom-dockerfile-required",
      packageManager: null,
      runtimeVersion: null,
      buildCommand: null,
      startCommand: null,
      expectedPort: null,
      healthCheckPath: "/",
      requiresDatabase: false,
      databaseType: null,
      requiresPersistentStorage: false,
      staticOutput: false,
      hasDockerfile: false,
      dockerfileRequired: true,
      selectedTemplate: "custom-dockerfile-required",
      confidence: DetectionConfidence.LOW,
      detectionStatus: DetectionStatus.FAILED,
      warnings: [],
      errors: [error instanceof Error ? error.message : "Stack detection failed"],
      rawProfile: null,
    });

    return this.profileRepository.save(profile);
  }

  private auditMetadata(project: Project, profile?: ProjectDetectionProfile) {
    return {
      projectId: project.id,
      repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch,
      ecosystem: profile?.ecosystem,
      framework: profile?.framework,
      frameworkVariant: profile?.frameworkVariant,
      selectedTemplate: profile?.selectedTemplate,
      detectionStatus: profile?.detectionStatus,
      warningsCount: profile?.warnings?.length || 0,
      errorsCount: profile?.errors?.length || 0,
    };
  }

  private toProfileResponse(profile: ProjectDetectionProfile) {
    return {
      id: profile.id,
      projectId: profile.projectId,
      repositoryUrl: profile.repositoryUrl,
      repositoryFullName: profile.repositoryFullName,
      targetBranch: profile.targetBranch,
      commitSha: profile.commitSha,
      ecosystem: profile.ecosystem,
      language: profile.language,
      framework: profile.framework,
      frameworkVariant: profile.frameworkVariant,
      packageManager: profile.packageManager,
      runtimeVersion: profile.runtimeVersion,
      buildCommand: profile.buildCommand,
      startCommand: profile.startCommand,
      expectedPort: profile.expectedPort,
      healthCheckPath: profile.healthCheckPath,
      requiresDatabase: profile.requiresDatabase,
      databaseType: profile.databaseType,
      requiresPersistentStorage: profile.requiresPersistentStorage,
      staticOutput: profile.staticOutput,
      dockerfileRequired: profile.dockerfileRequired,
      hasDockerfile: profile.hasDockerfile,
      selectedTemplate: profile.selectedTemplate,
      confidence: profile.confidence,
      detectionStatus: profile.detectionStatus,
      warnings: profile.warnings || [],
      errors: profile.errors || [],
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }
}
