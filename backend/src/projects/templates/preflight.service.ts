import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Request } from "express";
import { Repository } from "typeorm";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { User } from "../../users/user.entity";
import { ProjectDetectionProfile } from "../project-detection-profile.entity";
import { ProjectEnvironmentVariable } from "../project-environment-variable.entity";
import {
  PreflightValidationStatus,
  ProjectPreflightReport,
} from "../project-preflight-report.entity";
import { Project } from "../project.entity";
import { ProjectsService } from "../projects.service";
import { DockerTemplateEngineService } from "./docker-template-engine.service";
import { DevOpsTemplateDefinition } from "./devops-templates";
import { TemplateRegistryService } from "./template-registry.service";

@Injectable()
export class PreflightService {
  constructor(
    @InjectRepository(ProjectPreflightReport)
    private readonly reportRepository: Repository<ProjectPreflightReport>,
    @InjectRepository(ProjectDetectionProfile)
    private readonly profileRepository: Repository<ProjectDetectionProfile>,
    @InjectRepository(ProjectEnvironmentVariable)
    private readonly envVarRepository: Repository<ProjectEnvironmentVariable>,
    private readonly projectsService: ProjectsService,
    private readonly templateRegistryService: TemplateRegistryService,
    private readonly dockerTemplateEngineService: DockerTemplateEngineService,
    private readonly auditLogService: AuditLogService
  ) {}

  async generateReport(user: User, projectId: string, req?: Request) {
    const project = await this.projectsService.getProjectEntityForManage(
      user,
      projectId
    );
    await this.audit("PREFLIGHT_STARTED", user, project, undefined, req);

    try {
      const profile = await this.getProfile(project.id);
      const report = await this.buildReport(project, profile);
      const savedReport = await this.saveReport(project, profile, report);

      await this.audit("PREFLIGHT_COMPLETED", user, project, savedReport, req);

      if (savedReport.generatedDockerfile) {
        await this.audit("TEMPLATE_INJECTED", user, project, savedReport, req);
      }

      if (
        savedReport.validationStatus ===
        PreflightValidationStatus.MANUAL_DOCKERFILE_REQUIRED
      ) {
        await this.audit(
          "MANUAL_DOCKERFILE_REQUIRED",
          user,
          project,
          savedReport,
          req
        );
      }

      return this.toReportResponse(savedReport);
    } catch (error) {
      await this.audit("PREFLIGHT_FAILED", user, project, undefined, req);
      throw error;
    }
  }

  async getReport(user: User, projectId: string) {
    const project = await this.projectsService.getProjectEntityForView(user, projectId);
    const report = await this.reportRepository.findOne({
      where: { projectId: project.id },
    });

    if (!report) {
      throw new NotFoundException("Pre-flight report not found");
    }

    return this.toReportResponse(report);
  }

  listTemplates() {
    return this.templateRegistryService.listTemplates();
  }

  private async buildReport(project: Project, profile: ProjectDetectionProfile) {
    const validations = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const template = this.templateRegistryService.getTemplate(
      profile.selectedTemplate || ""
    );
    const envVars = await this.envVarRepository.find({
      where: { projectId: project.id },
      order: { key: "ASC" },
    });
    warnings.push(...(profile.warnings || []));

    this.addCheck(validations, "DETECTION_PROFILE_EXISTS", true, "Detection profile exists.");
    this.addCheck(validations, "PROJECT_REPOSITORY_URL", Boolean(project.repositoryUrl), "Project has repository URL.", errors);
    this.addCheck(validations, "PROJECT_TARGET_BRANCH", Boolean(project.targetBranch), "Project has target branch.", errors);
    this.addCheck(validations, "SELECTED_TEMPLATE_EXISTS", Boolean(profile.selectedTemplate), "Detection selected a template.", errors);
    this.addCheck(validations, "SUPPORTED_TEMPLATE", Boolean(template), "A supported template was found.", errors);
    this.addCheck(validations, "SUPPORTED_FRAMEWORK", this.isSupportedFramework(profile), "Framework is supported for pre-flight.", errors);
    this.addCheck(validations, "SUPPORTED_ECOSYSTEM", ["node", "python"].includes(profile.ecosystem) || profile.selectedTemplate?.startsWith("custom-dockerfile"), "Ecosystem is supported for pre-flight.", errors);
    this.addCheck(validations, "EXPECTED_PORT", Boolean(profile.expectedPort || template?.defaultPort || profile.selectedTemplate?.startsWith("custom-dockerfile")), "Expected port exists or safe default exists.", errors);
    this.addCheck(validations, "START_COMMAND", Boolean(profile.startCommand || profile.staticOutput || profile.hasDockerfile || profile.dockerfileRequired), "Start command exists or is not required.", errors);
    this.addCheck(validations, "ENV_VALUES_NOT_INCLUDED", true, "Environment variable values are not included in report.");

    if (!template) {
      throw new ForbiddenException("Unsupported deployment template");
    }

    this.addCheck(
      validations,
      "BUILD_COMMAND",
      !template.requiredCommands.includes("build") || Boolean(profile.buildCommand),
      "Build command exists where required.",
      errors
    );

    const generatedDockerfile =
      profile.hasDockerfile ||
      profile.selectedTemplate === "custom-dockerfile" ||
      profile.selectedTemplate === "custom-dockerfile-required"
        ? null
        : this.dockerTemplateEngineService.renderDockerfile(template, profile);

    if (profile.selectedTemplate === "custom-dockerfile-required") {
      const rawProfile = (profile.rawProfile || {}) as Record<string, unknown>;
      warnings.push(
        typeof rawProfile.unsupportedReason === "string"
          ? "Stack detected but no supported template is available."
          : "No safe automatic template was found. Please provide a custom Dockerfile."
      );
    }

    warnings.push(...template.warnings);
    if (!this.hasDockerignore(profile)) {
      warnings.push(".dockerignore was not found; the worker will generate a safe build-only default.");
    }

    const validationStatus = this.validationStatus(profile, errors, warnings);
    const report = {
      project: {
        id: project.id,
        name: project.name,
        repositoryUrl: project.repositoryUrl,
        repositoryFullName: project.repositoryFullName,
        targetBranch: project.targetBranch,
      },
      detectedStack: {
        ecosystem: profile.ecosystem,
        framework: profile.framework,
        frameworkVariant: profile.frameworkVariant,
        packageManager: profile.packageManager,
        runtimeVersion: profile.runtimeVersion,
      },
      deploymentProfile: {
        buildCommand: profile.buildCommand,
        startCommand: profile.startCommand,
        expectedPort: profile.expectedPort || template.defaultPort || null,
        healthCheckPath: profile.healthCheckPath,
        requiresDatabase: profile.requiresDatabase,
        requiresPersistentStorage: profile.requiresPersistentStorage,
        staticOutput: profile.staticOutput,
      },
      template: {
        templateKey: template.templateKey,
        displayName: template.displayName,
        baseImage: template.baseImage,
        runtimeImage: template.runtimeImage,
        usesMultiStageBuild: template.usesMultiStageBuild,
        securityLevel: template.securityLevel,
      },
      dockerfile: {
        willGenerate: Boolean(generatedDockerfile),
        usesExistingDockerfile: profile.hasDockerfile,
        dockerfileRequired: profile.dockerfileRequired,
        contentPreview: generatedDockerfile,
      },
      environmentVariables: {
        count: envVars.length,
        keys: envVars.map((envVar) => envVar.key),
        containsSecretValues: false,
        valuesIncluded: false,
      },
      validations,
      warnings,
      errors,
    };

    return { report, template, generatedDockerfile, validationStatus, warnings, errors };
  }

  private async saveReport(
    project: Project,
    profile: ProjectDetectionProfile,
    builtReport: {
      report: Record<string, unknown>;
      template: DevOpsTemplateDefinition;
      generatedDockerfile: string | null;
      validationStatus: string;
      warnings: string[];
      errors: string[];
    }
  ) {
    const existing = await this.reportRepository.findOne({
      where: { projectId: project.id },
    });
    const report = this.reportRepository.create({
      ...(existing || {}),
      projectId: project.id,
      detectionProfileId: profile.id,
      templateKey: builtReport.template.templateKey,
      templateDisplayName: builtReport.template.displayName,
      ecosystem: profile.ecosystem,
      framework: profile.framework,
      frameworkVariant: profile.frameworkVariant,
      packageManager: profile.packageManager,
      runtimeVersion: profile.runtimeVersion,
      expectedPort: profile.expectedPort || builtReport.template.defaultPort || null,
      buildCommand: profile.buildCommand,
      startCommand: profile.startCommand,
      healthCheckPath: profile.healthCheckPath,
      hasDockerfile: profile.hasDockerfile,
      dockerfileRequired: profile.dockerfileRequired,
      generatedDockerfile: builtReport.generatedDockerfile,
      report: builtReport.report,
      validationStatus: builtReport.validationStatus,
      warnings: builtReport.warnings,
      errors: builtReport.errors,
    });

    return this.reportRepository.save(report);
  }

  private async getProfile(projectId: string) {
    const profile = await this.profileRepository.findOne({ where: { projectId } });

    if (!profile) {
      throw new NotFoundException("Run stack detection before pre-flight validation");
    }

    return profile;
  }

  private addCheck(
    validations: Array<{ code: string; status: string; message: string }>,
    code: string,
    passed: boolean,
    message: string,
    errors?: string[]
  ) {
    validations.push({ code, status: passed ? "passed" : "failed", message });

    if (!passed && errors) {
      errors.push(message);
    }
  }

  private isSupportedFramework(profile: ProjectDetectionProfile) {
    if (profile.selectedTemplate?.startsWith("custom-dockerfile")) {
      return true;
    }

    return [
      "nextjs",
      "express",
      "nestjs",
      "react",
      "vite-react",
      "django",
      "fastapi",
      "flask",
      "unknown",
    ].includes(profile.framework || "unknown");
  }

  private validationStatus(
    profile: ProjectDetectionProfile,
    errors: string[],
    warnings: string[]
  ) {
    if (profile.selectedTemplate === "custom-dockerfile-required") {
      return PreflightValidationStatus.MANUAL_DOCKERFILE_REQUIRED;
    }

    if (errors.length > 0) {
      return PreflightValidationStatus.FAILED;
    }

    return warnings.length > 0
      ? PreflightValidationStatus.PASSED_WITH_WARNINGS
      : PreflightValidationStatus.PASSED;
  }

  private hasDockerignore(profile: ProjectDetectionProfile) {
    const rawProfile = profile.rawProfile as { rootFiles?: unknown } | null;
    return Array.isArray(rawProfile?.rootFiles)
      ? rawProfile.rootFiles.includes(".dockerignore")
      : false;
  }

  private async audit(
    action: string,
    user: User,
    project: Project,
    report?: ProjectPreflightReport,
    req?: Request
  ) {
    await this.auditLogService.record({
      actorUser: user,
      action,
      resourceType: "project",
      resourceId: project.id,
      status: action === "PREFLIGHT_FAILED" ? "failed" : "success",
      metadata: {
        projectId: project.id,
        repositoryFullName: project.repositoryFullName,
        templateKey: report?.templateKey,
        ecosystem: report?.ecosystem,
        framework: report?.framework,
        validationStatus: report?.validationStatus,
        warningsCount: report?.warnings?.length || 0,
        errorsCount: report?.errors?.length || 0,
      },
      req,
    });
  }

  private toReportResponse(report: ProjectPreflightReport) {
    return {
      id: report.id,
      projectId: report.projectId,
      detectionProfileId: report.detectionProfileId,
      templateKey: report.templateKey,
      templateDisplayName: report.templateDisplayName,
      ecosystem: report.ecosystem,
      framework: report.framework,
      frameworkVariant: report.frameworkVariant,
      packageManager: report.packageManager,
      runtimeVersion: report.runtimeVersion,
      expectedPort: report.expectedPort,
      buildCommand: report.buildCommand,
      startCommand: report.startCommand,
      healthCheckPath: report.healthCheckPath,
      hasDockerfile: report.hasDockerfile,
      dockerfileRequired: report.dockerfileRequired,
      generatedDockerfile: report.generatedDockerfile,
      report: report.report,
      validationStatus: report.validationStatus,
      warnings: report.warnings || [],
      errors: report.errors || [],
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    };
  }
}
