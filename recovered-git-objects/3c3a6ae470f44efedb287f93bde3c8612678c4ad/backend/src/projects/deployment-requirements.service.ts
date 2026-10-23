import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { randomBytes } from "crypto";
import { Request } from "express";
import { DataSource, Repository } from "typeorm";
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
import { ProjectsService } from "./projects.service";
import { RecoveryIssue } from "./recovery/recovery-issue.types";
import { StageSelectiveResumeService } from "./recovery/stage-selective-resume.service";
import { PreflightService } from "./templates/preflight.service";

const MANAGED_DATABASE_KEYS = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DATABASE_URL"];
const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|host\.docker\.internal)$/i;
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|DATABASE_URL|CREDENTIAL|AUTH_KEY)/;

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
    private readonly resume: StageSelectiveResumeService,
    private readonly crypto: ProjectEnvironmentCryptoService,
    private readonly audit: AuditLogService,
  ) {}

  async get(user: User, projectId: string) {
    await this.projects.getProjectEntityForView(user, projectId);
    return this.reconcile(projectId);
  }

  async resolve(user: User, projectId: string, dto: ResolveDeploymentRequirementsDto, req?: Request) {
    await this.projects.getProjectEntityForManage(user, projectId);
    const profile = await this.profiles.findOne({ where: { projectId } });
    const contract = await this.contracts.findOne({ where: { projectId } });
    if (!profile || !contract) throw new NotFoundException("Run repository detection before completing deployment requirements.");
    if (dto.sourceCommit && dto.sourceCommit !== profile.commitSha) throw new BadRequestException("The repository commit changed. Run detection again before saving.");
    if (dto.scanRevision && dto.scanRevision !== profile.inputFingerprint) throw new BadRequestException("The repository scan changed. Refresh deployment requirements before saving.");

    const evidence = this.evidence(profile);
    const detectedDatabaseName = await this.detectedDatabaseName(projectId, evidence);
    const databaseName = (dto.databaseName || detectedDatabaseName || `app_${projectId.replace(/-/g, "").slice(0, 8)}`).trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(databaseName)) throw new BadRequestException("Database name must contain only letters, numbers, and underscores.");
    if (dto.databaseProvider === "external" && (!dto.externalHost || LOCAL_HOST.test(dto.externalHost.trim()))) {
      throw new BadRequestException("Enter a reachable external database host. Localhost cannot be reached from ECS.");
    }
    if (dto.databaseProvider === "external" && !String(dto.values?.DB_USER || "").trim()) {
      throw new BadRequestException("DB_USER is required for the external database.");
    }
    if (dto.databaseProvider === "external" && !String(dto.values?.DB_PASSWORD || dto.values?.DATABASE_URL || "").trim()) {
      throw new BadRequestException("DB_PASSWORD or DATABASE_URL is required for the external database.");
    }
    const resolvedValues = { ...(dto.values || {}) };
    if (dto.databaseProvider === "external" && !String(resolvedValues.DATABASE_URL || "").trim()) {
      const userName = encodeURIComponent(String(resolvedValues.DB_USER || "").trim());
      const password = encodeURIComponent(String(resolvedValues.DB_PASSWORD || ""));
      resolvedValues.DATABASE_URL = `postgresql://${userName}:${password}@${dto.externalHost!.trim()}:${dto.externalPort || 5432}/${databaseName}`;
    }

    const requiredUserKeys = this.requiredUserKeys(contract, evidence, dto.databaseProvider);
    const existingRows = await this.env.createQueryBuilder("env").addSelect("env.value").where("env.projectId = :projectId", { projectId }).getMany();
    const active = new Map(existingRows.filter((row) => row.isActive !== false).map((row) => [row.key, row]));
    const saveKeys = [...new Set([
      ...requiredUserKeys,
      ...(dto.databaseProvider === "external" ? ["DB_PASSWORD", "DATABASE_URL"] : []),
    ])];
    for (const key of requiredUserKeys) {
      const supplied = String(resolvedValues[key] || "").trim();
      if (!supplied && !dto.generate?.[key] && !active.has(key)) throw new BadRequestException(`${key} is required before deployment can continue.`);
    }

    const now = new Date();
    const internalHost = `db.project-${projectId}.deployguard.local`;
    const generatedUser = this.generatedDatabaseUser(projectId);
    await this.dataSource.transaction(async (manager) => {
      const tierRepo = manager.getRepository(ProjectDatabaseTier);
      const envRepo = manager.getRepository(ProjectEnvironmentVariable);
      const requirementRepo = manager.getRepository(ProjectDeploymentRequirements);
      const existingTier = await tierRepo.findOne({ where: { projectId } });
      const managed = dto.databaseProvider === "managed";
      await tierRepo.save(tierRepo.create({
        ...(existingTier || {}),
        projectId,
        requiredByDetection: contract.databaseRequired,
        provider: managed ? DatabaseTierProvider.MANAGED : DatabaseTierProvider.EXTERNAL,
        engine: (contract.databaseEngine || "postgres") as "postgres" | "mysql",
        status: DatabaseTierStatus.PENDING,
        externalHost: managed ? null : dto.externalHost!.trim(),
        externalPort: managed ? null : (dto.externalPort || 5432),
        internalHost: managed ? internalHost : null,
        databaseName,
        databaseUser: managed ? generatedUser : String(resolvedValues.DB_USER || "").trim(),
        persistenceEnabled: managed,
        backupEnabled: managed,
        lastError: null,
      }));

      if (managed) {
        await envRepo.createQueryBuilder().update(ProjectEnvironmentVariable).set({
          isActive: false,
          supersededAt: now,
          supersededReason: "Superseded by DeployGuard-managed database binding",
        }).where("project_id = :projectId", { projectId }).andWhere("key IN (:...keys)", { keys: MANAGED_DATABASE_KEYS }).execute();
      }
      for (const key of saveKeys) {
        const prior = await envRepo.createQueryBuilder("env").addSelect("env.value").where("env.projectId = :projectId", { projectId }).andWhere("env.key = :key", { key }).getOne();
        const plain = String(resolvedValues[key] || "").trim() || (dto.generate?.[key] ? randomBytes(32).toString("base64url") : prior ? this.crypto.decrypt(prior.value) : "");
        const evidenceItem = evidence.find((item) => item.key === key);
        await envRepo.save(envRepo.create({
          ...(prior || {}), projectId, key,
          value: this.crypto.encrypt(plain),
          isSecret: evidenceItem?.secret === true || SECRET_NAME.test(key),
          scope: evidenceItem?.phase === "build" ? "build" : "runtime",
          isRequired: true,
          environment: "production",
          detectedSource: (evidenceItem?.sources || ["Repository scan"]).join(", "),
          owner: dto.databaseProvider === "external" && MANAGED_DATABASE_KEYS.includes(key) ? "external_service_supplied" : "user_supplied",
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
    });

    await this.contractService.refreshForProject(projectId);
    const report = await this.preflight.generateReport(user, projectId, req);
    const snapshot = await this.reconcile(projectId);
    let resumeResult: unknown = null;
    if (dto.saveAndResume !== false && snapshot.readyToResume) {
      resumeResult = await this.resume.execute(user, projectId, this.recoveryIssue(projectId, contract.databaseRequired), req);
      const runId = (resumeResult as { pipelineRun?: { id?: string } })?.pipelineRun?.id || null;
      if (runId) await this.markPending(projectId, runId);
    }
    await this.audit.record({
      actorUser: user,
      action: "DEPLOYMENT_REQUIREMENTS_RESOLVED",
      resourceType: "project",
      resourceId: projectId,
      status: "success",
      metadata: { projectId, provider: dto.databaseProvider, configuredKeys: requiredUserKeys, saveAndResume: dto.saveAndResume !== false },
      req,
    });
    return { requirements: await this.reconcile(projectId), preflight: report, resume: resumeResult };
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

  private async reconcile(projectId: string) {
    const [profile, contract, tier, stored, rows] = await Promise.all([
      this.profiles.findOne({ where: { projectId } }),
      this.contracts.findOne({ where: { projectId } }),
      this.tiers.findOne({ where: { projectId } }),
      this.requirements.findOne({ where: { projectId } }),
      this.env.find({ where: { projectId }, order: { key: "ASC" } }),
    ]);
    if (!profile || !contract) throw new NotFoundException("Run repository detection before completing deployment requirements.");
    const evidence = this.evidence(profile);
    const provider = tier?.provider && tier.provider !== DatabaseTierProvider.NONE ? tier.provider : DatabaseTierProvider.MANAGED;
    const detectedDatabaseName = await this.detectedDatabaseName(projectId, evidence);
    const generatedUser = this.generatedDatabaseUser(projectId);
    if (tier && !tier.provider) {
      let changed = false;
      if ((!tier.databaseName || tier.databaseName === "app") && detectedDatabaseName) { tier.databaseName = detectedDatabaseName; changed = true; }
      if (!tier.databaseUser || tier.databaseUser === "deployguard" || tier.databaseUser === "postgres") { tier.databaseUser = generatedUser; changed = true; }
      if (changed) await this.tiers.save(tier);
    }
    if (tier?.provider === DatabaseTierProvider.MANAGED) {
      let changed = false;
      if ((!tier.databaseName || tier.databaseName === "app") && detectedDatabaseName) { tier.databaseName = detectedDatabaseName; changed = true; }
      if (!tier.databaseUser || tier.databaseUser === "deployguard" || tier.databaseUser === "postgres") { tier.databaseUser = generatedUser; changed = true; }
      if (tier.internalHost !== `db.project-${projectId}.deployguard.local`) { tier.internalHost = `db.project-${projectId}.deployguard.local`; changed = true; }
      if (changed) await this.tiers.save(tier);
      const stale = rows.filter((row) => row.isActive !== false && MANAGED_DATABASE_KEYS.includes(row.key));
      if (stale.length) {
        const now = new Date();
        stale.forEach((row) => { row.isActive = false; row.supersededAt = now; row.supersededReason = "Superseded by DeployGuard-managed database binding"; });
        await this.env.save(stale);
        await this.contractService.refreshForProject(projectId);
      }
    }
    const activeKeys = new Set(rows.filter((row) => row.isActive !== false).map((row) => row.key));
    const requiredKeys = this.requiredUserKeys(contract, evidence, provider);
    const requiredInputs = requiredKeys.map((key) => {
      const item = evidence.find((entry) => entry.key === key);
      return {
        key,
        label: key,
        description: key === "JWT_SECRET" ? "Used by your app to sign authentication tokens." : "Required by the application at runtime.",
        owner: "user_supplied",
        secret: item?.secret === true || SECRET_NAME.test(key),
        required: true,
        scope: item?.phase || "runtime",
        detectedFrom: (item?.sources || ["Repository scan"]).join(", "),
        detectedDefault: item?.secret ? null : item?.detectedDefault || null,
        configured: activeKeys.has(key),
        validationError: null,
      };
    });
    const unresolved = requiredInputs.filter((item) => !item.configured);
    const detectedBindings = [
      ...(contract.port ? [{ key: "PORT", owner: "platform_detected", source: "repository scan", configured: true, maskedPreview: String(contract.port) }] : []),
      ...(contract.databaseRequired && detectedDatabaseName ? [{ key: "DB_NAME", owner: "platform_detected", source: "repository scan", configured: true, maskedPreview: detectedDatabaseName }] : []),
    ];
    const generatedBindings = [
      ["DB_HOST", "private database service binding"], ["DB_PORT", "database service binding"],
      ["DB_USER", "generated credential binding"], ["DB_PASSWORD", "Secrets Manager"],
      ["DATABASE_URL", "generated connection binding"],
    ].map(([key, source]) => ({
      key, owner: "platform_generated", source, configured: Boolean(tier?.provider),
      maskedPreview: key === "DB_HOST" ? `db.project-${projectId}.deployguard.local` : key === "DB_PORT" ? "5432" : "••••••••",
    }));
    const managedBindings = provider === DatabaseTierProvider.MANAGED
      ? [...detectedBindings, ...generatedBindings]
      : detectedBindings;
    const blockers = [...contract.blockers].filter((message) => !/Database tier required|Missing required environment variables|Local database configuration detected/i.test(message));
    if (unresolved.length) blockers.unshift(`Required configuration: ${unresolved.length} item${unresolved.length === 1 ? "" : "s"} remaining.`);
    if (provider === DatabaseTierProvider.EXTERNAL && LOCAL_HOST.test(tier?.externalHost || "")) blockers.unshift("External database host cannot be localhost.");
    const readyToResume = unresolved.length === 0 && Boolean(tier?.provider) && blockers.length === 0;
    const applicationStatus = stored?.applicationStatus || (unresolved.length ? "needs_input" : "detected");
    const status = stored?.status === "applied" ? "applied" : unresolved.length ? "needs_input" : stored?.savedAt ? "saved" : "ready";
    const snapshot = this.requirements.create({
      ...(stored || {}), projectId,
      sourceCommit: profile.commitSha,
      scanRevision: profile.inputFingerprint,
      status,
      applicationStatus,
      architecture: {
        runtime: profile.ecosystem === "node" ? "Node.js" : "Python",
        framework: profile.framework,
        port: contract.port,
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
    const saved = await this.requirements.save(snapshot);
    return this.publicView(saved);
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
        owner: String(input.owner || "user_supplied"),
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
        owner: binding.owner === "platform_detected" ? "platform_detected" : "platform_generated",
        source: String(binding.source || "DeployGuard service binding"),
        configured: binding.configured === true,
        maskedPreview: String(binding.maskedPreview || "••••••••"),
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
      .filter((key) => !MANAGED_DATABASE_KEYS.includes(key))
      .filter((key) => !evidence.find((item) => item.key === key)?.detectedDefault || SECRET_NAME.test(key))
      .sort();
  }

  private async detectedDatabaseName(projectId: string, evidence: Evidence[]) {
    const detected = evidence.find((item) => item.key === "DB_NAME")?.detectedDefault;
    if (detected && /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(detected)) return detected;
    const row = await this.env.createQueryBuilder("env").addSelect("env.value").where("env.projectId = :projectId", { projectId }).andWhere("env.key = 'DB_NAME'").getOne();
    if (!row) return null;
    const value = this.crypto.decrypt(row.value).trim();
    return /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value) ? value : null;
  }

  private generatedDatabaseUser(projectId: string) {
    return `dg_${projectId.replace(/-/g, "").slice(0, 12)}`;
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
