import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { randomBytes } from "crypto";
import { Request } from "express";
import { DataSource, EntityManager, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { User } from "../users/user.entity";
import { DeploymentContractService } from "./deployment-contract.service";
import { ResolveDeploymentRequirementsDto } from "./dto/resolve-deployment-requirements.dto";
import { DatabaseTierProvider, DatabaseTierStatus, ProjectDatabaseTier } from "./project-database-tier.entity";
import { ProjectDeploymentContract } from "./project-deployment-contract.entity";
import {
  DeploymentRequirementsApplicationStatus,
  ProjectDeploymentRequirements,
} from "./project-deployment-requirements.entity";
import { ProjectDetectionProfile } from "./project-detection-profile.entity";
import { ProjectEnvironmentCryptoService } from "./project-environment-crypto.service";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { Project } from "./project.entity";
import { ProjectsService } from "./projects.service";
import { RecoveryIssue } from "./recovery/recovery-issue.types";
import { PreflightService } from "./templates/preflight.service";
import { analysisFingerprint } from "./analysis-fingerprint";
import { ignoredSubmittedVariableNames, isSecretConfigurationKey, ManagedServiceKind, normalizeConfigurationKey, provenRepositoryOwnedVariableKeys, SERVICE_ALIAS_GROUPS, serviceAlias } from "./configuration-ownership";
import { canonicalEnvironmentName } from "./canonical-environment";
import { requireBuildPlan } from "./build-plan";
import { evaluateBuildPlanReadiness } from "./build-plan-readiness";
import {
  acquireProjectConfigurationAdvisoryLock,
  DatabaseServiceBindingService,
} from "../infrastructure/database-service-binding.service";
import { ManagedDatabaseEngine } from "./managed-database-engine";

type Evidence = {
  key: string;
  required?: boolean;
  phase?: "build" | "runtime";
  secret?: boolean;
  database?: boolean;
  sources?: string[];
  detectedDefault?: string;
};

@Injectable()
export class DeploymentRequirementsService {
  constructor(
    @InjectRepository(ProjectDeploymentRequirements) private readonly requirements: Repository<ProjectDeploymentRequirements>,
    @InjectRepository(ProjectDetectionProfile) private readonly profiles: Repository<ProjectDetectionProfile>,
    @InjectRepository(ProjectDeploymentContract) private readonly contracts: Repository<ProjectDeploymentContract>,
    @InjectRepository(ProjectDatabaseTier) private readonly tiers: Repository<ProjectDatabaseTier>,
    @InjectRepository(ProjectEnvironmentVariable) private readonly env: Repository<ProjectEnvironmentVariable>,
    private readonly dataSource: DataSource,
    private readonly projects: ProjectsService,
    private readonly contractService: DeploymentContractService,
    private readonly preflight: PreflightService,
    private readonly crypto: ProjectEnvironmentCryptoService,
    private readonly audit: AuditLogService,
    private readonly effectiveConfiguration: DatabaseServiceBindingService,
  ) {}

  async get(user: User, projectId: string) {
    await this.projects.getProjectEntityForView(user, projectId);
    return this.reconcile(projectId);
  }

  async resolve(user: User, projectId: string, dto: ResolveDeploymentRequirementsDto, req?: Request) {
    const project = await this.projects.getProjectEntityForManage(user, projectId);
    const environmentName = canonicalEnvironmentName(project);
    const profile = await this.profiles.findOne({ where: { projectId } });
    const contract = await this.contracts.findOne({ where: { projectId } });
    if (!profile || !contract) throw new NotFoundException("Run repository detection before completing deployment requirements.");
    const buildPlan = requireBuildPlan(contract);
    if (dto.sourceCommit && dto.sourceCommit !== profile.commitSha) throw new BadRequestException("The repository commit changed. Run detection again before saving.");
    if (dto.scanRevision && dto.scanRevision !== profile.inputFingerprint) throw new BadRequestException("The repository scan changed. Refresh deployment requirements before saving.");

    const evidence = this.evidence(profile);
    const detectedDatabaseName = await this.detectedDatabaseName(projectId, evidence);
    if (contract.databaseRequired && dto.databaseProvider !== "managed") {
      throw new BadRequestException("Detected databases are managed by DeployGuard; external database configuration is not supported.");
    }
    const selectedProvider = contract.databaseRequired ? "managed" : "none";
    const databaseName = (dto.databaseName || detectedDatabaseName || `app_${projectId.replace(/-/g, "").slice(0, 8)}`).trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(databaseName)) throw new BadRequestException("Database name must contain only letters, numbers, and underscores.");
    const resolvedValues = { ...(dto.values || {}) };

    const requiredUserKeys = buildPlan.requiredInputs.filter((key) => !serviceAlias(key, (contract.databaseEngine || "postgres") as ManagedServiceKind));
    let saveKeys = [...new Set(requiredUserKeys)];
    const submittedKeys = [...new Set([...Object.keys(dto.values || {}), ...Object.keys(dto.generate || {})].map(normalizeConfigurationKey))];
    const ignoredVariableNames = ignoredSubmittedVariableNames(submittedKeys, {
      service: (contract.databaseEngine || "postgres") as ManagedServiceKind,
      managedService: selectedProvider === "managed",
      repositoryOwnedKeys: provenRepositoryOwnedVariableKeys(evidence),
    });
    saveKeys = [...new Set([...saveKeys, ...submittedKeys.filter((key) => !ignoredVariableNames.includes(key))])];

    const now = new Date();
    const internalHost = `db.project-${projectId}.deployguard.local`;
    const generatedUser = this.generatedDatabaseUser(projectId);
    await this.dataSource.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager, projectId, environmentName);
      const tierRepo = manager.getRepository(ProjectDatabaseTier);
      const envRepo = manager.getRepository(ProjectEnvironmentVariable);
      const requirementRepo = manager.getRepository(ProjectDeploymentRequirements);
      const currentProfile = await manager.getRepository(ProjectDetectionProfile).findOne({ where: { projectId } });
      const currentContract = await manager.getRepository(ProjectDeploymentContract).findOne({ where: { projectId } });
      if (
        !currentProfile
        || !currentContract
        || currentProfile.commitSha !== profile.commitSha
        || currentProfile.inputFingerprint !== profile.inputFingerprint
        || currentContract.contractHash !== contract.contractHash
      ) {
        throw new BadRequestException("Deployment configuration changed while requirements were being saved. Refresh and try again.");
      }
      const existingRows = await envRepo.createQueryBuilder("env").addSelect("env.value").where("env.projectId = :projectId", { projectId }).getMany();
      const active = new Map(existingRows.filter((row) => row.isActive !== false).map((row) => [row.key, row]));
      for (const key of requiredUserKeys) {
        const supplied = String(resolvedValues[key] || "").trim();
        if (!supplied && !dto.generate?.[key] && !active.has(key)) {
          throw new BadRequestException(`${key} is required before deployment can continue.`);
        }
      }
      const existingTier = await tierRepo.findOne({ where: { projectId } });
      const managed = selectedProvider === "managed";
      const selectedEngine = contract.databaseEngine || "postgres";
      const established = existingTier?.provider === DatabaseTierProvider.MANAGED
        && Boolean(existingTier.efsFileSystemId || existingTier.credentialsSecretArn || existingTier.status === DatabaseTierStatus.READY);
      if (established && existingTier.engine !== selectedEngine) {
        throw new BadRequestException("The managed database engine is immutable after project persistence is established. Full project Destroy is required before selecting another engine.");
      }
      await tierRepo.save(tierRepo.create({
        ...(existingTier || {}),
        projectId,
        requiredByDetection: contract.databaseRequired,
        provider: managed ? DatabaseTierProvider.MANAGED : DatabaseTierProvider.NONE,
        engine: selectedEngine as ManagedDatabaseEngine,
        status: contract.databaseRequired ? DatabaseTierStatus.PENDING : DatabaseTierStatus.NOT_REQUIRED,
        externalHost: null,
        externalPort: null,
        externalTlsRequired: true,
        internalHost: managed ? internalHost : null,
        databaseName,
        databaseUser: managed ? generatedUser : String(resolvedValues.DB_USER || "").trim(),
        persistenceEnabled: contract.databaseRequired && managed,
        backupEnabled: false,
        lastError: null,
      }));

      if (managed) {
        await envRepo.createQueryBuilder().update(ProjectEnvironmentVariable).set({
          isActive: false,
          supersededAt: now,
          supersededReason: "Superseded by DeployGuard-managed database binding",
        }).where("project_id = :projectId", { projectId }).andWhere("upper(key) IN (:...keys)", { keys: this.databaseAliases(contract.databaseEngine) }).execute();
      }
      for (const key of saveKeys) {
        const prior = await envRepo.createQueryBuilder("env").addSelect("env.value").where("env.projectId = :projectId", { projectId }).andWhere("env.key = :key", { key }).getOne();
        const plain = String(resolvedValues[key] || "").trim() || (dto.generate?.[key] ? randomBytes(32).toString("base64url") : prior ? this.crypto.decrypt(prior.value) : "");
        const evidenceItem = evidence.find((item) => item.key === key);
        await envRepo.save(envRepo.create({
          ...(prior || {}), projectId, key: normalizeConfigurationKey(key), normalizedKey: normalizeConfigurationKey(key),
          value: this.crypto.encrypt(plain),
          isSecret: evidenceItem?.secret === true || isSecretConfigurationKey(key),
          scope: evidenceItem?.phase === "build" ? "build" : "runtime",
          isRequired: requiredUserKeys.includes(key),
          environment: environmentName,
          detectedSource: (evidenceItem?.sources || ["Repository scan"]).join(", "),
          owner: requiredUserKeys.includes(key) ? "user_required" : "user_optional",
          source: requiredUserKeys.includes(key) ? "repository_requirement" : "user_optional",
          protected: false,
          serviceBindingId: null,
          detectedReference: (evidenceItem?.sources || ["Repository scan"]).join(", "),
          repositoryDefault: null,
          supersededBy: null,
          configurationFingerprint: analysisFingerprint({ projectId, key, scope: evidenceItem?.phase || "runtime", revision: profile.inputFingerprint, configured: true }),
          isActive: true,
          supersededAt: null,
          supersededReason: null,
          appliedAt: null,
          encryptionVersion: 1,
        }));
      }
      const priorRequirements = await requirementRepo.findOne({ where: { projectId } });
      await requirementRepo.save(requirementRepo.create({
        ...(priorRequirements || {}), projectId,
        sourceCommit: profile.commitSha,
        scanRevision: profile.inputFingerprint,
        status: "saved",
        applicationStatus: "saved",
        configurationRevision: (priorRequirements?.configurationRevision || 0) + 1,
        savedAt: now,
        appliedAt: null,
        verifiedAt: null,
        appliedPipelineRunId: null,
        resumeFromStage: contract.databaseRequired ? "database_tier_setup" : "ecs_task_definition_update",
        resumeSequence: contract.databaseRequired
          ? ["database_tier_setup", "ecs_task_definition_update", "ecs_service_deploy", "health_check"]
          : ["ecs_task_definition_update", "ecs_service_deploy", "health_check"],
      }));
      await this.contractService.refreshForProject(projectId, manager);
    });

    const report = await this.preflight.generateReport(user, projectId, req);
    await this.audit.record({
      actorUser: user,
      action: "DEPLOYMENT_REQUIREMENTS_RESOLVED",
      resourceType: "project",
      resourceId: projectId,
      status: "success",
      metadata: {
        projectId,
        provider: selectedProvider,
        configuredKeys: requiredUserKeys,
        ignoredVariableNames,
        deploymentStarted: false,
      },
      req,
    });
    return {
      requirements: await this.reconcile(projectId),
      preflight: report,
      ignoredVariableNames,
      deployment: { state: "not_started", safeCode: "NORMAL_V1_DEPLOYMENT_REQUIRES_EXPLICIT_ACTION" },
    };
  }

  async markApplying(projectId: string, pipelineRunId: string) {
    return this.updateApplicationStatus(projectId, "applying", pipelineRunId);
  }

  async markVerified(projectId: string, pipelineRunId: string) {
    const row = await this.requirements.findOne({ where: { projectId } });
    if (!row) return null;
    const now = new Date();
    row.status = "applied";
    row.applicationStatus = "verified";
    row.appliedPipelineRunId = pipelineRunId;
    row.appliedAt = now;
    row.verifiedAt = now;
    await this.env.update({ projectId, isActive: true }, { appliedAt: now });
    return this.requirements.save(row);
  }

  private async reconcile(projectId: string, manager?: EntityManager) {
    if (!manager) {
      return this.dataSource.transaction(async (transactionManager) => {
        const project = await transactionManager.getRepository(Project).findOne({ where: { id: projectId } });
        if (!project) throw new NotFoundException("Project not found");
        await acquireProjectConfigurationAdvisoryLock(transactionManager, projectId, canonicalEnvironmentName(project));
        return this.reconcile(projectId, transactionManager);
      });
    }
    const profiles = manager.getRepository(ProjectDetectionProfile);
    const contracts = manager.getRepository(ProjectDeploymentContract);
    const tiers = manager.getRepository(ProjectDatabaseTier);
    const requirements = manager.getRepository(ProjectDeploymentRequirements);
    const environment = manager.getRepository(ProjectEnvironmentVariable);
    const [profile, contract, tier, stored, rows] = await Promise.all([
      profiles.findOne({ where: { projectId } }),
      contracts.findOne({ where: { projectId } }),
      tiers.findOne({ where: { projectId } }),
      requirements.findOne({ where: { projectId } }),
      environment.find({ where: { projectId }, order: { key: "ASC" } }),
    ]);
    if (!profile || !contract) throw new NotFoundException("Run repository detection before completing deployment requirements.");
    const buildPlan = requireBuildPlan(contract);
    const evidence = this.evidence(profile);
    const provider = !contract.databaseRequired
      ? DatabaseTierProvider.NONE
      : tier?.provider && tier.provider !== DatabaseTierProvider.NONE ? tier.provider : DatabaseTierProvider.MANAGED;
    const detectedDatabaseName = await this.detectedDatabaseName(projectId, evidence, manager);
    const generatedUser = this.generatedDatabaseUser(projectId);
    if (tier && !tier.provider) {
      let changed = false;
      if ((!tier.databaseName || tier.databaseName === "app") && detectedDatabaseName) { tier.databaseName = detectedDatabaseName; changed = true; }
      if (!tier.databaseUser || tier.databaseUser === "deployguard" || tier.databaseUser === "postgres") { tier.databaseUser = generatedUser; changed = true; }
      if (changed) await tiers.save(tier);
    }
    if (tier?.provider === DatabaseTierProvider.MANAGED) {
      let changed = false;
      if ((!tier.databaseName || tier.databaseName === "app") && detectedDatabaseName) { tier.databaseName = detectedDatabaseName; changed = true; }
      if (!tier.databaseUser || tier.databaseUser === "deployguard" || tier.databaseUser === "postgres") { tier.databaseUser = generatedUser; changed = true; }
      if (tier.internalHost !== `db.project-${projectId}.deployguard.local`) { tier.internalHost = `db.project-${projectId}.deployguard.local`; changed = true; }
      if (changed) await tiers.save(tier);
      const stale = rows.filter((row) => row.isActive !== false && this.databaseAliases(contract.databaseEngine).includes(normalizeConfigurationKey(row.key)));
      if (stale.length) {
        const now = new Date();
        stale.forEach((row) => { row.isActive = false; row.supersededAt = now; row.supersededReason = "Superseded by DeployGuard-managed database binding"; });
        await environment.save(stale);
        await this.contractService.refreshForProject(projectId, manager);
      }
    }
    const project = await manager.getRepository(Project).findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found");
    const effective = await this.effectiveConfiguration.resolveEffectiveDeploymentConfiguration(projectId, null, canonicalEnvironmentName(project), {
      throwOnBlockers: false,
      requireReady: false,
      useSnapshot: false,
      manager,
    });
    const activeKeys = new Set(Object.keys(effective.ownership));
    const requiredKeys = buildPlan.requiredInputs.filter((key) => !serviceAlias(key, (contract.databaseEngine || "postgres") as ManagedServiceKind));
    const requiredInputs = requiredKeys.map((key) => {
      const item = evidence.find((entry) => entry.key === key);
      return {
        key,
        label: key,
        description: key === "JWT_SECRET" ? "Used by your app to sign authentication tokens." : "Required by the application at runtime.",
        owner: "user_required",
        secret: item?.secret === true || isSecretConfigurationKey(key),
        required: true,
        scope: item?.phase || "runtime",
        detectedFrom: (item?.sources || ["Repository scan"]).join(", "),
        detectedDefault: item?.secret ? null : item?.detectedDefault || null,
        configured: activeKeys.has(key),
        validationError: null,
      };
    });
    const unresolved = requiredInputs.filter((item) => !item.configured);
    const managedBindings = Object.entries(effective.ownership)
      .filter(([, value]) => ["platform", "managed_service", "repository_default", "external_service"].includes(value.owner))
      .map(([key, value]) => ({ key, owner: value.owner, source: value.source, configured: true, protected: value.protected, maskedPreview: value.secret ? "••••••••" : effective.runtimeVariables[key] || "configured", serviceBindingId: value.serviceBindingId }));
    const blockers = [...contract.blockers].filter((message) => !/Database tier required|Missing required environment variables|Local database configuration detected/i.test(message));
    blockers.push(...effective.blockers);
    if (unresolved.length) blockers.unshift(`Required configuration: ${unresolved.length} item${unresolved.length === 1 ? "" : "s"} remaining.`);
    const readyToResume = unresolved.length === 0 && (!contract.databaseRequired || Boolean(tier?.provider)) && blockers.length === 0;
    const readiness = evaluateBuildPlanReadiness(buildPlan, effective);
    const applicationStatus = stored?.applicationStatus || (unresolved.length ? "needs_input" : "detected");
    const status = stored?.status === "applied" ? "applied" : unresolved.length ? "needs_input" : stored?.savedAt ? "saved" : "ready";
    const snapshot = requirements.create({
      ...(stored || {}), projectId,
      sourceCommit: profile.commitSha,
      scanRevision: profile.inputFingerprint,
      status,
      applicationStatus,
      architecture: {
        runtime: buildPlan.language === "javascript" ? "Node.js" : "Python",
        framework: buildPlan.framework,
        port: buildPlan.port,
        buildPlanVersion: buildPlan.planVersion,
        databaseRequired: contract.databaseRequired,
        databaseEngine: contract.databaseEngine,
        persistentFileStorageRequired: contract.persistentStorageRequired,
      },
      requiredInputs,
      managedBindings,
      database: {
        required: contract.databaseRequired,
        provider,
        engine: contract.databaseEngine || "postgres",
        detectedDatabaseName,
        effectiveDatabaseName: tier?.provider ? (tier.databaseName || detectedDatabaseName) : detectedDatabaseName,
        persistence: provider === DatabaseTierProvider.MANAGED,
        internalNetworking: provider === DatabaseTierProvider.MANAGED,
        configured: Boolean(tier?.provider),
      },
      blockers,
      readyToResume,
      resumeFromStage: contract.databaseRequired ? "database_tier_setup" : "ecs_task_definition_update",
      resumeSequence: contract.databaseRequired
        ? ["database_tier_setup", "ecs_task_definition_update", "ecs_service_deploy", "health_check"]
        : ["ecs_task_definition_update", "ecs_service_deploy", "health_check"],
    });
    const saved = await requirements.save(snapshot);
    return { ...this.publicView(saved), readiness };
  }

  private publicView(row: ProjectDeploymentRequirements) {
    return {
      projectId: row.projectId,
      sourceCommit: row.sourceCommit,
      scanRevision: row.scanRevision,
      status: row.status,
      applicationStatus: row.applicationStatus,
      architecture: row.architecture,
      requiredInputs: row.requiredInputs.map((input) => ({
        key: String(input.key || ""),
        label: String(input.label || input.key || ""),
        description: String(input.description || ""),
        owner: String(input.owner || "user_required"),
        secret: input.secret === true,
        required: input.required === true,
        scope: String(input.scope || "runtime"),
        detectedFrom: String(input.detectedFrom || "Repository scan"),
        detectedDefault: input.secret === true ? null : (input.detectedDefault || null),
        configured: input.configured === true,
        validationError: input.validationError || null,
      })),
      managedBindings: row.managedBindings.map((binding) => ({
        key: String(binding.key || ""),
        owner: String(binding.owner || "platform"),
        source: String(binding.source || "DeployGuard service binding"),
        configured: binding.configured === true,
        maskedPreview: String(binding.maskedPreview || "••••••••"),
        protected: binding.protected === true,
        serviceBindingId: binding.serviceBindingId || null,
      })),
      database: row.database,
      blockers: row.blockers,
      readyToResume: row.readyToResume,
      resumeFromStage: row.resumeFromStage,
      resumeSequence: row.resumeSequence,
      configurationRevision: row.configurationRevision,
      savedAt: row.savedAt,
      appliedAt: row.appliedAt,
      verifiedAt: row.verifiedAt,
    };
  }

  private evidence(profile: ProjectDetectionProfile): Evidence[] {
    const raw = (profile.rawProfile || {}) as Record<string, unknown>;
    return Array.isArray(raw.environmentVariables)
      ? raw.environmentVariables.filter((item): item is Evidence => Boolean(item && typeof item === "object" && "key" in item))
      : [];
  }

  private requiredUserKeys(contract: ProjectDeploymentContract, evidence: Evidence[], provider: string | null) {
    const managed = provider === DatabaseTierProvider.MANAGED;
    return [...new Set(contract.requiredEnvVars)]
      .filter((key) => key !== "PORT" && key !== "HOST")
      .filter((key) => !serviceAlias(key, (contract.databaseEngine || "postgres") as ManagedServiceKind))
      .filter((key) => !evidence.find((item) => item.key === key)?.detectedDefault || isSecretConfigurationKey(key))
      .sort();
  }

  private async detectedDatabaseName(projectId: string, evidence: Evidence[], manager?: EntityManager) {
    const detected = evidence.find((item) => item.key === "DB_NAME")?.detectedDefault;
    if (detected && /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(detected)) return detected;
    const row = await (manager?.getRepository(ProjectEnvironmentVariable) || this.env).createQueryBuilder("env").addSelect("env.value").where("env.projectId = :projectId", { projectId }).andWhere("env.key = 'DB_NAME'").getOne();
    if (!row) return null;
    const value = this.crypto.decrypt(row.value).trim();
    return /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value) ? value : null;
  }

  private generatedDatabaseUser(projectId: string) {
    return `dg_${projectId.replace(/-/g, "").slice(0, 12)}`;
  }

  private databaseAliases(engine: string | null) {
    const service = (engine || "postgres") as ManagedServiceKind;
    return [...new Set(SERVICE_ALIAS_GROUPS.filter((group) => group.service === service).flatMap((group) => [...group.aliases]))];
  }

  private recoveryIssue(projectId: string, databaseRequired: boolean): RecoveryIssue {
    return {
      code: databaseRequired ? "database_configuration_resolved" : "missing_runtime_env_resolved",
      title: "Deployment requirements resolved",
      severity: "info",
      category: databaseRequired ? "database" : "runtime",
      rootCause: "Deployment configuration changed.",
      simpleExplanation: "DeployGuard can reuse unaffected successful stages.",
      detectedEvidence: [{ source: "settings", message: "Canonical deployment requirements were saved." }],
      requiredAction: databaseRequired ? "Apply database configuration and redeploy the service." : "Update the service configuration and redeploy.",
      primaryActionLabel: "Save and resume deployment",
      primaryActionRoute: `/projects/${projectId}/requirements`,
      primaryActionMode: "focused_settings",
      focusSection: databaseRequired ? "database" : "environment",
      resumeFromStage: databaseRequired ? "database_tier_setup" : "ecs_task_definition_update",
      canResume: true,
      requiresFullRerun: false,
      affectedStages: databaseRequired
        ? ["database_tier_setup", "ecs_task_definition_update", "ecs_service_deploy", "health_check"]
        : ["ecs_task_definition_update", "ecs_service_deploy", "health_check"],
      safeToRetry: true,
      developerDetails: {},
    };
  }

  private async markPending(projectId: string, pipelineRunId: string) {
    const row = await this.requirements.findOne({ where: { projectId } });
    if (!row) return;
    row.applicationStatus = "pending_deployment";
    row.appliedPipelineRunId = pipelineRunId;
    await this.requirements.save(row);
  }

  private async updateApplicationStatus(projectId: string, status: DeploymentRequirementsApplicationStatus, pipelineRunId: string) {
    const row = await this.requirements.findOne({ where: { projectId } });
    if (!row) return null;
    row.applicationStatus = status;
    row.appliedPipelineRunId = pipelineRunId;
    return this.requirements.save(row);
  }
}
