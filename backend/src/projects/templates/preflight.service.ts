import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Request } from "express";
import { Repository } from "typeorm";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { User } from "../../users/user.entity";
import { DeploymentContractService } from "../deployment-contract.service";
import { ProjectDeploymentContract } from "../project-deployment-contract.entity";
import { ProjectEnvironmentVariable } from "../project-environment-variable.entity";
import {
  PreflightValidationStatus,
  ProjectPreflightReport,
} from "../project-preflight-report.entity";
import { Project } from "../project.entity";
import { canonicalEnvironmentName } from "../canonical-environment";
import { ProjectsService } from "../projects.service";
import { DevOpsTemplateDefinition } from "./devops-templates";
import { TemplateRegistryService } from "./template-registry.service";
import { DatabaseServiceBindingService } from "../../infrastructure/database-service-binding.service";
import { requireBuildPlan } from "../build-plan";
import { evaluateBuildPlanReadiness } from "../build-plan-readiness";
import type { ReadinessWarningDetail } from "../readiness-warning";

type Validation = { code: string; status: "passed" | "failed"; message: string };

@Injectable()
export class PreflightService {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @InjectRepository(ProjectPreflightReport)
    private readonly reportRepository: Repository<ProjectPreflightReport>,
    @InjectRepository(ProjectEnvironmentVariable)
    private readonly envVarRepository: Repository<ProjectEnvironmentVariable>,
    private readonly projectsService: ProjectsService,
    private readonly deploymentContractService: DeploymentContractService,
    private readonly templateRegistryService: TemplateRegistryService,
    private readonly auditLogService: AuditLogService,
    private readonly effectiveConfiguration: DatabaseServiceBindingService,
  ) {}

  async generateReport(user: User, projectId: string, req?: Request) {
    return this.singleFlight(projectId, () => this.executeGenerateReport(user, projectId, req));
  }

  async getOrGenerateReport(user: User, projectId: string, req?: Request) {
    const project = await this.projectsService.getProjectEntityForManage(user, projectId);
    const contract = await this.deploymentContractService.refreshForProject(project.id);
    if (!contract) throw new NotFoundException("Run stack detection before pre-flight validation");
    const existing = await this.reportRepository.findOne({ where: { projectId: project.id } });
    if (
      existing?.inputFingerprint === contract.contractHash &&
      contract.deployable &&
      [PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS].includes(
        existing.validationStatus as PreflightValidationStatus
      )
    ) {
      await this.audit("PREFLIGHT_REUSED", user, project, existing, req);
      return this.toReportResponse(existing);
    }
    return this.generateReport(user, projectId, req);
  }

  private async executeGenerateReport(user: User, projectId: string, req?: Request) {
    const project = await this.projectsService.getProjectEntityForManage(user, projectId);
    await this.audit("PREFLIGHT_STARTED", user, project, undefined, req);
    try {
      const contract = await this.deploymentContractService.refreshForProject(project.id);
      if (!contract) throw new NotFoundException("Run stack detection before pre-flight validation");
      const built = await this.buildReport(project, contract);
      const saved = await this.saveReport(project, contract, built);
      await this.audit("PREFLIGHT_COMPLETED", user, project, saved, req);
      if (saved.generatedDockerfile) await this.audit("TEMPLATE_INJECTED", user, project, saved, req);
      if (saved.validationStatus === PreflightValidationStatus.MANUAL_DOCKERFILE_REQUIRED) {
        await this.audit("MANUAL_DOCKERFILE_REQUIRED", user, project, saved, req);
      }
      return this.toReportResponse(saved);
    } catch (error) {
      await this.audit("PREFLIGHT_FAILED", user, project, undefined, req);
      throw error;
    }
  }

  async getReport(user: User, projectId: string) {
    const project = await this.projectsService.getProjectEntityForView(user, projectId);
    const report = await this.reportRepository.findOne({ where: { projectId: project.id } });
    if (!report) throw new NotFoundException("Pre-flight report not found");
    return this.toReportResponse(report);
  }

  listTemplates() {
    return this.templateRegistryService.listTemplates();
  }

  private async buildReport(project: Project, contract: ProjectDeploymentContract) {
    const plan = requireBuildPlan(contract);
    const template = this.templateRegistryService.getTemplate(plan.dockerTemplate) ||
      this.templateRegistryService.getTemplate("custom-dockerfile-required");
    if (!template) throw new ForbiddenException("DeployGuard template registry is incomplete");
    const effective = await this.effectiveConfiguration.resolveEffectiveDeploymentConfiguration(
      project.id,
      null,
      canonicalEnvironmentName(project),
      { throwOnBlockers: false, requireReady: false, useSnapshot: false },
    );
    const validations: Validation[] = [];
    this.addCheck(validations, "DEPLOYMENT_CONTRACT_EXISTS", true, "Deployment contract exists.");
    this.addCheck(validations, "CONTRACT_COMMIT", Boolean(contract.detectionSourceCommit), "Deployment contract is tied to a repository commit.");
    this.addCheck(validations, "SUPPORTED_LANGUAGE", ["javascript", "python"].includes(plan.language), "Only JavaScript and Python web applications are supported.");
    this.addCheck(validations, "SUPPORTED_FRAMEWORK", Boolean(plan.framework), "A supported web framework is required.");
    this.addCheck(validations, "DEPENDENCY_MANIFEST", Boolean(plan.dependencyManifest), "A supported dependency manifest is present.");
    this.addCheck(validations, "INSTALL_COMMAND", Boolean(plan.installCommand), "A compatible install command is required.");
    this.addCheck(validations, "BUILD_COMMAND", plan.runtimeType !== "static" || Boolean(plan.buildCommand), "Static applications require a build command.");
    this.addCheck(validations, "START_COMMAND", plan.runtimeType === "static" || Boolean(plan.runCommand), "Server applications require a production run command.");
    this.addCheck(validations, "EXPECTED_PORT", Boolean(plan.port), "Container and ALB target ports are required.");
    this.addCheck(validations, "HEALTH_PATH", plan.healthPath.startsWith("/"), "A valid public health-check path is required.");
    this.addCheck(validations, "REQUIRED_ENVIRONMENT", effective.unresolvedRequiredValues.length === 0, effective.unresolvedRequiredValues.length ? `Required application configuration is unresolved: ${effective.unresolvedRequiredValues.join(", ")}.` : "All required application configuration is complete.");
    this.addCheck(validations, "CONFIGURATION_OWNERSHIP", effective.prohibitedOverrides.length === 0 && effective.duplicateOwnershipConflicts.length === 0, "Every configuration key must have one authoritative owner.");
    this.addCheck(validations, "DOCKERFILE_STRATEGY", contract.dockerStrategy === "custom" || Boolean(contract.generatedDockerfile), "A safe custom or generated Dockerfile is required.");
    const generated = contract.generatedDockerfile || "";
    const generatedContractValid = plan.dockerStrategy !== "generated" || (
      Boolean(generated) &&
      !/\{\{[A-Z_]+\}\}/.test(generated) &&
      Boolean(contract.commitSha && generated.includes(contract.commitSha)) &&
      (plan.runtimeType === "static" || generated.includes(JSON.stringify(["sh", "-c", plan.runCommand]))) &&
      (!plan.buildCommand
        || generated.includes(`RUN ${plan.buildCommand}`)
        || generated.includes(Buffer.from(plan.buildCommand, "utf8").toString("base64")))
    );
    this.addCheck(validations, "DOCKERFILE_CONTRACT_PARITY", generatedContractValid, "Generated Dockerfile must exactly preserve the immutable commit, build, and start contract.");
    const buildSecrets = plan.buildTimeEnvVars.filter((key) => plan.secretEnvVars.includes(key));
    this.addCheck(validations, "NO_BUILD_TIME_SECRETS", buildSecrets.length === 0, "Secret values are forbidden during image build.");
    this.addCheck(validations, "PUBLIC_BUILD_VARIABLES", plan.buildTimeEnvVars.every((key) => /^(VITE_|NEXT_PUBLIC_|REACT_APP_)[A-Z0-9_]*$/.test(key)), "Only explicitly public framework-prefixed variables may enter image builds.");
    this.addCheck(validations, "ECS_PORT_ALIGNMENT", Boolean(plan.port) && plan.port === contract.ecsPlan.targetGroupPort, "BuildPlan and ALB target ports must match.");
    this.addCheck(validations, "ENV_VALUES_NOT_INCLUDED", true, "Environment variable values are not included in the report or contract.");

    const configurationBlockers = effective.blockers.filter((blocker) => !/^Required application configuration is unresolved:/i.test(blocker));
    const configurationWarnings: string[] = [];
    const validationStatus = this.validationStatus(contract, configurationBlockers);
    const readiness = evaluateBuildPlanReadiness(plan, effective);
    const environmentEvidence = this.environmentEvidence(contract);
    const report = {
      project: {
        id: project.id,
        name: project.name,
        repositoryUrl: project.repositoryUrl,
        repositoryFullName: contract.repositoryFullName,
        targetBranch: contract.branch,
        commitSha: plan.commitSha,
      },
      repositoryInspection: {
        emptyRepository: false,
        manifestFiles: contract.dependencyManifest ? [contract.dependencyManifest] : [],
        appRoot: plan.appRoot,
        appRootConfidence: plan.confidence,
        appRootReason: "Deployment contract selected this application root from repository evidence.",
        detectedCandidates: [],
        sourceFileCount: null,
      },
      detectedStack: {
        ecosystem: contract.language === "javascript" ? "node" : contract.language,
        language: plan.language,
        framework: plan.framework,
        packageManager: plan.packageManager,
        runtimeVersion: plan.runtimeVersion,
      },
      deploymentProfile: {
        installCommand: plan.installCommand,
        buildCommand: plan.buildCommand,
        releaseCommand: plan.releaseCommand,
        startCommand: plan.runCommand,
        expectedPort: plan.port,
        healthCheckPath: plan.healthPath,
        runtimeType: plan.runtimeType,
        outputDirectory: plan.outputDirectory,
        bindsToPortEnv: plan.bindsToPortEnv,
        bindHost: plan.bindHost,
        requiresDatabase: contract.databaseRequired,
        requiresPersistentStorage: contract.persistentStorageRequired,
        staticOutput: plan.runtimeType === "static",
      },
      template: this.templateSummary(template),
      dockerfile: {
        willGenerate: Boolean(contract.generatedDockerfile),
        usesExistingDockerfile: contract.dockerStrategy === "custom",
        dockerfileRequired: contract.dockerStrategy === "custom",
        contentPreview: contract.generatedDockerfile,
      },
      environmentVariables: {
        count: Object.keys(effective.ownership).length,
        keys: Object.keys(effective.ownership).sort(),
        detected: environmentEvidence,
        required: plan.requiredInputs,
        optional: plan.optionalInputs,
        buildTime: plan.buildTimeEnvVars,
        runtime: plan.runtimeEnvVars,
        secrets: plan.secretEnvVars,
        missing: effective.unresolvedRequiredValues,
        containsSecretValues: false,
        valuesIncluded: false,
      },
      readiness: {
        decision: readiness.status,
        requiredInputs: readiness.requiredInputs,
        deployAllowed: readiness.status === "READY" || readiness.status === "READY_WITH_WARNINGS",
        validationStatus,
        contractHash: contract.contractHash,
        configurationFingerprint: effective.configurationFingerprint,
      },
      ecsRuntimePlan: {
        containerPort: plan.port,
        albTargetPort: contract.ecsPlan.targetGroupPort,
        healthCheckPath: plan.healthPath,
        runtimeCommand: plan.runCommand,
        cpu: contract.ecsPlan.cpu,
        memory: contract.ecsPlan.memory,
        environmentMappings: contract.ecsPlan.environmentMappings,
        secretMappings: contract.ecsPlan.secretMappings,
        injectPortEnvironment: contract.runtimeType === "server",
      },
      validations,
      warnings: [...new Set([...readiness.warnings, ...configurationWarnings])],
      warningDetails: plan.warningDetails || [],
      errors: readiness.blockers,
    };
    return {
      report,
      template,
      generatedDockerfile: contract.generatedDockerfile,
      validationStatus,
      warnings: [...new Set([...contract.warnings, ...configurationWarnings])],
      warningDetails: plan.warningDetails || [],
      errors: [...new Set([...contract.blockers, ...configurationBlockers])],
    };
  }

  private async saveReport(
    project: Project,
    contract: ProjectDeploymentContract,
    built: {
      report: Record<string, unknown>;
      template: DevOpsTemplateDefinition;
      generatedDockerfile: string | null;
      validationStatus: string;
      warnings: string[];
      warningDetails: ReadinessWarningDetail[];
      errors: string[];
    }
  ) {
    const existing = await this.reportRepository.findOne({ where: { projectId: project.id } });
    return this.reportRepository.save(this.reportRepository.create({
      ...(existing || {}),
      projectId: project.id,
      detectionProfileId: contract.detectionProfileId,
      inputFingerprint: contract.contractHash,
      templateKey: contract.dockerTemplate || built.template.templateKey,
      templateDisplayName: built.template.displayName,
      ecosystem: contract.language === "javascript" ? "node" : contract.language || "unknown",
      framework: contract.framework,
      frameworkVariant: contract.dockerTemplate,
      packageManager: contract.packageManager,
      runtimeVersion: contract.nodeVersion || contract.pythonVersion,
      expectedPort: contract.port,
      buildCommand: contract.buildCommand,
      startCommand: contract.startCommand,
      healthCheckPath: contract.healthPath,
      hasDockerfile: contract.dockerStrategy === "custom",
      dockerfileRequired: contract.dockerStrategy === "custom",
      generatedDockerfile: built.generatedDockerfile,
      report: built.report,
      validationStatus: built.validationStatus,
      warnings: built.warnings,
      errors: built.errors,
    }));
  }

  private validationStatus(contract: ProjectDeploymentContract, configurationBlockers: string[] = []) {
    if (contract.dockerTemplate === "custom-dockerfile-required") {
      return PreflightValidationStatus.MANUAL_DOCKERFILE_REQUIRED;
    }
    if (!contract.deployable || contract.blockers.length || configurationBlockers.length) return PreflightValidationStatus.FAILED;
    return contract.warnings.length
      ? PreflightValidationStatus.PASSED_WITH_WARNINGS
      : PreflightValidationStatus.PASSED;
  }

  private environmentEvidence(contract: ProjectDeploymentContract) {
    const keys = new Set([...contract.requiredEnvVars, ...contract.optionalEnvVars]);
    return [...keys].sort().map((key) => ({
      key,
      required: contract.requiredEnvVars.includes(key),
      phase: contract.buildTimeEnvVars.includes(key) && contract.runtimeEnvVars.includes(key)
        ? "both"
        : contract.buildTimeEnvVars.includes(key) ? "build" : "runtime",
      public: /^(VITE_|NEXT_PUBLIC_|REACT_APP_)/.test(key),
      secret: contract.secretEnvVars.includes(key),
    }));
  }

  private templateSummary(template: DevOpsTemplateDefinition) {
    return {
      templateKey: template.templateKey,
      displayName: template.displayName,
      baseImage: template.baseImage,
      runtimeImage: template.runtimeImage,
      usesMultiStageBuild: template.usesMultiStageBuild,
      securityLevel: template.securityLevel,
    };
  }

  private addCheck(validations: Validation[], code: string, passed: boolean, message: string) {
    validations.push({ code, status: passed ? "passed" : "failed", message });
  }

  private async audit(action: string, user: User, project: Project, report?: ProjectPreflightReport, req?: Request) {
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
    const embeddedReadiness = report.report?.readiness && typeof report.report.readiness === "object"
      ? report.report.readiness as Record<string, unknown>
      : {};
    const readinessStatus = typeof embeddedReadiness.decision === "string" ? embeddedReadiness.decision : "BLOCKED";
    return {
      id: report.id,
      projectId: report.projectId,
      detectionProfileId: report.detectionProfileId,
      inputFingerprint: report.inputFingerprint,
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
      readinessStatus,
      requiredInputs: Array.isArray(embeddedReadiness.requiredInputs) ? embeddedReadiness.requiredInputs.map(String) : [],
      deployAllowed: readinessStatus === "READY" || readinessStatus === "READY_WITH_WARNINGS",
      warnings: report.warnings || [],
      errors: report.errors || [],
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    };
  }

  private async singleFlight<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const active = this.inFlight.get(projectId);
    if (active) return active as Promise<T>;
    const promise = task();
    this.inFlight.set(projectId, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(projectId) === promise) this.inFlight.delete(projectId);
    }
  }
}
