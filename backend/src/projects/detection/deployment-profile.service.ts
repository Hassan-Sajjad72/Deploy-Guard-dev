import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Request } from "express";
import { EntityManager, Repository } from "typeorm";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { User } from "../../users/user.entity";
import { GithubAppService } from "../github-app.service";
import {
  DetectionConfidence,
  DetectionStatus,
  ProjectDetectionProfile,
} from "../project-detection-profile.entity";
import { Project } from "../project.entity";
import { ProjectsService } from "../projects.service";
import { DETECTION_INPUT_FINGERPRINT_VERSION, detectionFingerprint } from "../analysis-fingerprint";
import { DeploymentContractService } from "../deployment-contract.service";
import { acquireProjectConfigurationAdvisoryLock } from "../../infrastructure/database-service-binding.service";
import { canonicalEnvironmentName } from "../canonical-environment";
import {
  RepositoryCloneError,
  RepositoryWorkspaceService,
} from "./repository-workspace.service";
import {
  DeploymentProfileDraft,
  StackDetectionService,
} from "./stack-detection.service";
import { hasCurrentCanonicalTopology } from "./topology.types";
import { readinessWarningDetails } from "../readiness-warning";

@Injectable()
export class DeploymentProfileService {
  constructor(
    @InjectRepository(ProjectDetectionProfile)
    private readonly profileRepository: Repository<ProjectDetectionProfile>,
    private readonly projectsService: ProjectsService,
    private readonly repositoryWorkspaceService: RepositoryWorkspaceService,
    private readonly stackDetectionService: StackDetectionService,
    private readonly deploymentContractService: DeploymentContractService,
    private readonly auditLogService: AuditLogService,
    private readonly githubApp: GithubAppService
  ) {}

  async runDetection(user: User, projectId: string, req?: Request) {
    return this.executeDetection(user, projectId, req);
  }

  async getOrRunDetection(user: User, projectId: string, req?: Request) {
    const project = await this.projectsService.getProjectEntityForManage(user, projectId);
    const existing = await this.profileRepository.findOne({ where: { projectId: project.id } });
    try {
      const commitSha = await this.repositoryWorkspaceService.resolveRemoteCommit({
        repositoryUrl: project.repositoryUrl,
        targetBranch: project.targetBranch,
        accessToken: (await this.githubApp.tokenForRepository(user.id, project.repositoryFullName, project.githubInstallationId)).token,
      });
      const fingerprint = detectionFingerprint(project, commitSha);
      if (
        existing?.detectionStatus === DetectionStatus.SUCCESS &&
        existing.commitSha === commitSha &&
        existing.inputFingerprint === fingerprint &&
        hasCurrentCanonicalTopology(existing.rawProfile)
      ) {
        await this.auditLogService.record({
          actorUser: user,
          action: "STACK_DETECTION_REUSED",
          resourceType: "project",
          resourceId: project.id,
          status: "success",
          metadata: { ...this.auditMetadata(project, existing), fingerprintMatched: true },
          req,
        });
        return this.toProfileResponse(existing);
      }
    } catch {
      // A failed lightweight remote check cannot prove freshness. Execute the
      // authoritative clone/detection path so its existing diagnostics apply.
    }
    return this.runDetection(user, projectId, req);
  }

  private async executeDetection(user: User, projectId: string, req?: Request) {
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
        accessToken: (await this.githubApp.tokenForRepository(user.id, project.repositoryFullName, project.githubInstallationId)).token,
      });
      workspacePath = workspace.workspacePath;
      const draft = this.stackDetectionService.detect(
        workspace.workspacePath,
        workspace.commitSha,
        project.appDirectory,
        project.deploymentOverrides || {}
      );
      draft.rawProfile.repositoryUrl = project.repositoryUrl;
      draft.rawProfile.targetBranch = project.targetBranch;
      draft.rawProfile.inputFingerprintVersion = DETECTION_INPUT_FINGERPRINT_VERSION;
      const profile = await this.profileRepository.manager.transaction(async (manager) => {
        await acquireProjectConfigurationAdvisoryLock(manager, project.id, canonicalEnvironmentName(project));
        const currentProject = await manager.getRepository(Project).findOne({ where: { id: project.id } });
        if (
          !currentProject
          || detectionFingerprint(currentProject, draft.commitSha) !== detectionFingerprint(project, draft.commitSha)
        ) {
          throw new ConflictException({
            code: "detection_configuration_changed",
            message: "Project deployment settings changed during repository detection. Run detection again.",
          });
        }
        const saved = await this.saveProfile(currentProject, draft, manager);
        await this.deploymentContractService.upsertFromDetection(currentProject, saved, manager);
        return saved;
      });

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
      const response = error && typeof error === "object" && "getResponse" in error
        ? (error as { getResponse(): unknown }).getResponse()
        : null;
      if (response && typeof response === "object" && (response as { code?: unknown }).code === "detection_configuration_changed") {
        throw error;
      }
      const profile = await this.profileRepository.manager.transaction(async (manager) => {
        await acquireProjectConfigurationAdvisoryLock(manager, project.id, canonicalEnvironmentName(project));
        const currentProject = await manager.getRepository(Project).findOne({ where: { id: project.id } });
        if (!currentProject) throw new NotFoundException("Project not found");
        const saved = await this.saveFailedProfile(currentProject, error, manager);
        await this.deploymentContractService.upsertFromDetection(currentProject, saved, manager);
        return saved;
      });

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

  private async saveProfile(project: Project, draft: DeploymentProfileDraft, manager?: EntityManager) {
    const profiles = manager?.getRepository(ProjectDetectionProfile) || this.profileRepository;
    const existing = await profiles.findOne({
      where: { projectId: project.id },
    });
    const profile = profiles.create({
      ...(existing || {}),
      projectId: project.id,
      repositoryUrl: project.repositoryUrl,
      repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch,
      inputFingerprint: detectionFingerprint(project, draft.commitSha),
      ...draft,
    });

    return profiles.save(profile);
  }

  private async saveFailedProfile(project: Project, error: unknown, manager?: EntityManager) {
    const profiles = manager?.getRepository(ProjectDetectionProfile) || this.profileRepository;
    const existing = await profiles.findOne({
      where: { projectId: project.id },
    });
    const profile = profiles.create({
      ...(existing || {}),
      projectId: project.id,
      repositoryUrl: project.repositoryUrl,
      repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch,
      commitSha: null,
      inputFingerprint: null,
      ecosystem: "unknown",
      language: null,
      framework: "unknown",
      frameworkVariant: null,
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
      dockerfileRequired: false,
      selectedTemplate: null,
      confidence: DetectionConfidence.LOW,
      detectionStatus: DetectionStatus.FAILED,
      warnings: [],
      errors: [error instanceof Error ? error.message : "Stack detection failed"],
      rawProfile: {
        detected: false,
        appDirectory: null,
        manifestFiles: [],
        templateMatched: false,
        unsupportedReason: null,
        cloneError:
          error instanceof RepositoryCloneError
            ? error.cloneError
            : "Stack detection could not inspect the repository.",
        branchError:
          error instanceof RepositoryCloneError ? error.branchError : null,
      },
    });

    return profiles.save(profile);
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
    const rawProfile = (profile.rawProfile || {}) as Record<string, unknown>;
    const topology = rawProfile.componentTopology && typeof rawProfile.componentTopology === "object"
      ? rawProfile.componentTopology as Record<string, unknown>
      : null;
    const topologyComponents = Array.isArray(topology?.components) ? topology.components : [];
    const explicitWarningDetails = [
      ...(Array.isArray(rawProfile.deployabilityWarningDetails) ? rawProfile.deployabilityWarningDetails : []),
      ...topologyComponents.flatMap((component) => {
        if (!component || typeof component !== "object") return [];
        const componentProfile = (component as Record<string, any>).profile?.rawProfile;
        return Array.isArray(componentProfile?.deployabilityWarningDetails) ? componentProfile.deployabilityWarningDetails : [];
      }),
    ].filter((item, index, items) => item && typeof item === "object" && items.findIndex((candidate: any) => candidate?.code === (item as any).code) === index);
    const warningMessages = [
      ...(profile.warnings || []),
      ...(Array.isArray(rawProfile.deployabilityWarnings) ? rawProfile.deployabilityWarnings.map(String) : []),
      ...topologyComponents.flatMap((component) => {
        if (!component || typeof component !== "object") return [];
        const componentProfile = (component as Record<string, any>).profile;
        return [
          ...(Array.isArray(componentProfile?.warnings) ? componentProfile.warnings.map(String) : []),
          ...(Array.isArray(componentProfile?.rawProfile?.deployabilityWarnings) ? componentProfile.rawProfile.deployabilityWarnings.map(String) : []),
        ];
      }),
    ];
    const warningDetails = readinessWarningDetails(warningMessages, explicitWarningDetails as any);
    return {
      id: profile.id,
      projectId: profile.projectId,
      repositoryUrl: profile.repositoryUrl,
      repositoryFullName: profile.repositoryFullName,
      targetBranch: profile.targetBranch,
      commitSha: profile.commitSha,
      inputFingerprint: profile.inputFingerprint,
      ecosystem: profile.ecosystem,
      language: profile.language,
      framework: profile.framework,
      frameworkVariant: profile.frameworkVariant,
      packageManager: profile.packageManager,
      runtimeVersion: profile.runtimeVersion,
      buildCommand: profile.buildCommand,
      startCommand: profile.startCommand,
      expectedPort: profile.expectedPort,
      port: profile.expectedPort,
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
      detectorId: rawProfile.detectorId ?? null,
      detectorEvidence: Array.isArray(rawProfile.detectorEvidence) ? rawProfile.detectorEvidence : [],
      detected: rawProfile.detected ?? profile.ecosystem !== "unknown",
      appDirectory: rawProfile.appDirectory ?? null,
      manifestFiles: Array.isArray(rawProfile.manifestFiles)
        ? rawProfile.manifestFiles
        : [],
      detectedCandidates: Array.isArray(rawProfile.detectedCandidates) ? rawProfile.detectedCandidates : [],
      components: Array.isArray(rawProfile.components) ? rawProfile.components : [],
      componentRelationships: rawProfile.componentTopology && typeof rawProfile.componentTopology === "object"
        ? ((rawProfile.componentTopology as Record<string, unknown>).relationships || [])
        : [],
      managedDatabase: rawProfile.componentTopology && typeof rawProfile.componentTopology === "object"
        ? ((rawProfile.componentTopology as Record<string, unknown>).managedDatabase || null)
        : null,
      topologyStatus: rawProfile.topologyStatus || null,
      topologyShape: rawProfile.topologyShape || null,
      topologyAnalysisState: rawProfile.topologyAnalysisState || null,
      topologySchemaVersion: rawProfile.componentTopology && typeof rawProfile.componentTopology === "object"
        ? ((rawProfile.componentTopology as Record<string, unknown>).schemaVersion || null)
        : null,
      topologyAnalyzerVersion: rawProfile.componentTopology && typeof rawProfile.componentTopology === "object"
        ? ((rawProfile.componentTopology as Record<string, unknown>).analyzerVersion || null)
        : null,
      topologyBlockers: Array.isArray(rawProfile.topologyBlockers) ? rawProfile.topologyBlockers : [],
      appRootConfidence: rawProfile.appRootConfidence ?? profile.confidence,
      appRootReason: rawProfile.appRootReason ?? null,
      runtimeType: rawProfile.runtimeType ?? (profile.staticOutput ? "static" : "server"),
      installCommand: rawProfile.installCommand ?? null,
      outputDirectory: rawProfile.outputDirectory ?? null,
      dependencyFiles: Array.isArray(rawProfile.dependencyFiles) ? rawProfile.dependencyFiles : [],
      lockfiles: Array.isArray(rawProfile.lockfiles) ? rawProfile.lockfiles : [],
      sourceFileCount: rawProfile.sourceFileCount ?? 0,
      requiredEnvironmentVariables: Array.isArray(rawProfile.requiredEnvironmentVariables) ? rawProfile.requiredEnvironmentVariables : [],
      optionalEnvironmentVariables: Array.isArray(rawProfile.optionalEnvironmentVariables) ? rawProfile.optionalEnvironmentVariables : [],
      environmentVariables: Array.isArray(rawProfile.environmentVariables) ? rawProfile.environmentVariables : [],
      deployabilityBlockers: Array.isArray(rawProfile.deployabilityBlockers) ? rawProfile.deployabilityBlockers : [],
      deployabilityWarnings: Array.isArray(rawProfile.deployabilityWarnings) ? rawProfile.deployabilityWarnings : [],
      templateMatched: rawProfile.templateMatched ?? false,
      unsupportedReason: rawProfile.unsupportedReason ?? null,
      detectionWarnings: profile.warnings || [],
      cloneError: rawProfile.cloneError ?? null,
      branchError: rawProfile.branchError ?? null,
      warnings: profile.warnings || [],
      warningDetails,
      errors: profile.errors || [],
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

}
