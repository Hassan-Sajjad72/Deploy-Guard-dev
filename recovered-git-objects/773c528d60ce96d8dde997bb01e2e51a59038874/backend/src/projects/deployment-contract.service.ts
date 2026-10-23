import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, Repository } from "typeorm";
import { acquireProjectConfigurationAdvisoryLock } from "../infrastructure/database-service-binding.service";
import { getOrchestrationConfig } from "../orchestration/orchestration.config";
import { analysisFingerprint, detectionFingerprint } from "./analysis-fingerprint";
import { ProjectDetectionProfile } from "./project-detection-profile.entity";
import {
  DeploymentEnvironmentMapping,
  DeploymentContractLanguage,
  DeploymentEcsPlan,
  DeploymentRuntimeType,
  ProjectDeploymentContract,
} from "./project-deployment-contract.entity";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { DatabaseTierProvider, DatabaseTierStatus, ProjectDatabaseTier } from "./project-database-tier.entity";
import { Project } from "./project.entity";
import { DockerTemplateEngineService } from "./templates/docker-template-engine.service";
import { TemplateRegistryService } from "./templates/template-registry.service";
import { SERVICE_ALIAS_GROUPS, serviceAlias } from "./configuration-ownership";

const SUPPORTED_FRAMEWORKS = new Set([
  "vite-react",
  "react",
  "nextjs",
  "express",
  "nestjs",
  "fastify",
  "flask",
  "fastapi",
  "django",
  "streamlit",
]);
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|DATABASE_URL|CREDENTIAL)/;
const BUILD_TIME_NAME = /^(VITE_|NEXT_PUBLIC_|REACT_APP_)/;

type EnvironmentEvidence = {
  key: string;
  required?: boolean;
  phase?: "build" | "runtime";
  secret?: boolean;
  public?: boolean;
  detectedDefault?: string;
};

@Injectable()
export class DeploymentContractService {
  constructor(
    @InjectRepository(ProjectDeploymentContract)
    private readonly contractRepository: Repository<ProjectDeploymentContract>,
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectDetectionProfile)
    private readonly profileRepository: Repository<ProjectDetectionProfile>,
    @InjectRepository(ProjectEnvironmentVariable)
    private readonly environmentRepository: Repository<ProjectEnvironmentVariable>,
    @InjectRepository(ProjectDatabaseTier)
    private readonly databaseTierRepository: Repository<ProjectDatabaseTier>,
    private readonly templateRegistry: TemplateRegistryService,
    private readonly dockerTemplateEngine: DockerTemplateEngineService,
    private readonly config: ConfigService,
    @Optional() private readonly dataSource?: DataSource,
  ) {}

  async refreshForProject(projectId: string, manager?: EntityManager) {
    if (!manager && this.dataSource) {
      return this.dataSource.transaction(async (transactionManager) => {
        await acquireProjectConfigurationAdvisoryLock(transactionManager, projectId, "production");
        return this.refreshForProject(projectId, transactionManager);
      });
    }
    const projects = manager?.getRepository(Project) || this.projectRepository;
    const profiles = manager?.getRepository(ProjectDetectionProfile) || this.profileRepository;
    const [project, profile] = await Promise.all([
      projects.findOne({ where: { id: projectId } }),
      profiles.findOne({ where: { projectId } }),
    ]);
    if (!project || !profile) return null;
    return this.upsertFromDetection(project, profile, manager);
  }

  async upsertFromDetection(project: Project, profile: ProjectDetectionProfile, manager?: EntityManager) {
    if (!manager && this.dataSource) {
      return this.dataSource.transaction(async (transactionManager) => {
        await acquireProjectConfigurationAdvisoryLock(transactionManager, project.id, "production");
        return this.upsertFromDetection(project, profile, transactionManager);
      });
    }
    const contracts = manager?.getRepository(ProjectDeploymentContract) || this.contractRepository;
    const environment = manager?.getRepository(ProjectEnvironmentVariable) || this.environmentRepository;
    const databaseTiers = manager?.getRepository(ProjectDatabaseTier) || this.databaseTierRepository;
    const [existing, environmentVariables, databaseTier] = await Promise.all([
      contracts.findOne({ where: { projectId: project.id } }),
      environment.find({ where: { projectId: project.id, isActive: true }, order: { key: "ASC" } }),
      databaseTiers.findOne({ where: { projectId: project.id } }),
    ]);
    const raw = (profile.rawProfile || {}) as Record<string, unknown>;
    const databaseRequired = profile.requiresDatabase || raw.databaseRequired === true;
    const detectedDatabaseEngine = this.databaseEngine(raw.databaseEngine || profile.databaseType);
    const databaseEngine = databaseTier?.engine || detectedDatabaseEngine;
    const managedDatabaseVariables = databaseRequired && databaseTier?.provider === DatabaseTierProvider.MANAGED
      ? new Set(SERVICE_ALIAS_GROUPS.filter((group) => group.service === (databaseTier.engine || detectedDatabaseEngine || "postgres")).flatMap((group) => [...group.aliases]))
      : new Set<string>();
    const evidence = this.environmentEvidence(raw);
    const repositoryRequired = evidence.filter((item) => item.required).map((item) => item.key);
    const detectedDatabaseName = evidence.find((item) => item.key === "DB_NAME")?.detectedDefault || null;
    const requiredEnvVars = this.unique(repositoryRequired);
    const optionalEnvVars = this.unique([
      ...this.stringArray(raw.optionalEnvironmentVariables),
      ...evidence.filter((item) => !item.required).map((item) => item.key),
    ]);
    const configured = new Map(environmentVariables.map((item) => [item.key, item]));
    const missingEnvVars = requiredEnvVars.filter((key) => !configured.has(key) && !managedDatabaseVariables.has(key));
    const missingOptionalEnvVars = optionalEnvVars.filter((key) => !configured.has(key));
    const buildTimeEnvVars = this.unique([
      ...evidence.filter((item) => item.phase === "build").map((item) => item.key),
      ...[...requiredEnvVars, ...optionalEnvVars].filter((key) => BUILD_TIME_NAME.test(key)),
    ]);
    const runtimeEnvVars = this.unique([
      ...evidence.filter((item) => item.phase !== "build").map((item) => item.key),
      ...[...requiredEnvVars, ...optionalEnvVars].filter((key) => !BUILD_TIME_NAME.test(key)),
    ]);
    const secretEnvVars = this.unique([
      ...evidence.filter((item) => item.secret).map((item) => item.key),
      ...[...requiredEnvVars, ...optionalEnvVars].filter((key) => SECRET_NAME.test(key)),
    ]);
    const runtimeType = this.runtimeType(raw, profile);
    const language = this.language(profile);
    const template = this.templateRegistry.getTemplate(profile.selectedTemplate || "");
    const port = profile.expectedPort || template?.defaultPort || null;
    const healthPath = profile.healthCheckPath || "/";
    const framework = profile.framework || null;
    const large = Boolean(framework && ["nextjs", "django"].includes(framework));
    const orchestration = getOrchestrationConfig(this.config);
    const configuredRuntime = runtimeEnvVars.filter((key) => configured.has(key));
    const secretRuntime = configuredRuntime.filter((key) => secretEnvVars.includes(key));
    const environmentMappings: DeploymentEnvironmentMapping[] = configuredRuntime
      .filter((key) => !secretEnvVars.includes(key))
      .map((name) => ({ name, source: "project" as const }));
    if (runtimeType === "server") {
      if (!environmentMappings.some((item) => item.name === "HOST")) {
        environmentMappings.push({ name: "HOST", source: "platform" });
      }
      if (!environmentMappings.some((item) => item.name === "PORT")) {
        environmentMappings.push({ name: "PORT", source: "platform" });
      }
    }
    const databaseHost = databaseTier?.provider === DatabaseTierProvider.MANAGED
      ? databaseTier.internalHost || `db.project-${project.id}.deployguard.local`
      : databaseTier?.provider === DatabaseTierProvider.EXTERNAL ? databaseTier.externalHost : null;
    const databasePort = databaseTier?.provider === DatabaseTierProvider.EXTERNAL
      ? databaseTier.externalPort
      : databaseEngine === "mysql" ? 3306 : databaseEngine === "postgres" ? 5432 : null;
    if (databaseRequired && databaseTier?.provider && databaseTier.provider !== DatabaseTierProvider.NONE) {
      const expectedDatabaseAliases = this.unique([...requiredEnvVars, ...optionalEnvVars, ...runtimeEnvVars])
        .filter((name) => Boolean(serviceAlias(name, databaseEngine || "postgres")))
        .filter((name) => !secretEnvVars.includes(name));
      for (const name of this.unique(["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", ...expectedDatabaseAliases])) {
        if (!environmentMappings.some((item) => item.name === name)) environmentMappings.push({ name, source: "platform" });
      }
    }
    const evidencedManagedSecrets = this.unique([...requiredEnvVars, ...optionalEnvVars, ...runtimeEnvVars])
      .filter((name) => serviceAlias(name, databaseEngine || "postgres")?.secret);
    const platformSecrets = databaseTier?.provider === DatabaseTierProvider.MANAGED
      ? this.unique([
          "DB_PASSWORD",
          ...evidencedManagedSecrets.filter((name) => serviceAlias(name, databaseEngine || "postgres")?.property !== "url"),
          ...evidencedManagedSecrets.filter((name) => serviceAlias(name, databaseEngine || "postgres")?.property === "url"),
        ]).map((name) => ({ name, source: "platform_secret" as const }))
      : [];
    const externalDatabaseSecrets = databaseTier?.provider === DatabaseTierProvider.EXTERNAL
      ? this.unique([...requiredEnvVars, ...optionalEnvVars, ...runtimeEnvVars]
          .filter((name) => serviceAlias(name, databaseEngine || "postgres")?.secret))
          .map((name) => ({ name, source: "project_secret" as const }))
      : [];
    const ecsPlan: DeploymentEcsPlan = {
      containerPort: port,
      targetGroupPort: port,
      healthCheckPath: healthPath,
      command: runtimeType === "static" ? "nginx static runtime" : profile.startCommand,
      cpu: large ? orchestration.largeCpu : orchestration.defaultCpu,
      memory: large ? orchestration.largeMemory : orchestration.defaultMemory,
      environmentMappings,
      secretMappings: [...secretRuntime.map((name) => ({ name, source: "project_secret" as const })), ...externalDatabaseSecrets, ...platformSecrets]
        .filter((item, index, items) => items.findIndex((candidate) => candidate.name === item.name) === index),
      database: {
        required: databaseRequired,
        provider: databaseTier?.provider || null,
        engine: databaseEngine,
        host: databaseHost,
        port: databasePort,
        databaseName: databaseTier?.databaseName || detectedDatabaseName,
        databaseUser: databaseTier?.databaseUser || null,
        image: databaseTier?.provider === DatabaseTierProvider.MANAGED ? (databaseEngine === "mysql" ? "mysql:8.4" : "postgres:16") : null,
        dataPath: databaseTier?.provider === DatabaseTierProvider.MANAGED ? (databaseEngine === "mysql" ? "/var/lib/mysql" : "/var/lib/postgresql/data") : null,
        persistenceEnabled: databaseTier?.provider === DatabaseTierProvider.MANAGED && databaseTier.persistenceEnabled,
      },
    };
    const blockers = this.unique([
      ...(profile.errors || []),
      ...this.stringArray(raw.deployabilityBlockers),
    ]);
    const warnings = this.unique([
      ...(profile.warnings || []),
      ...this.stringArray(raw.deployabilityWarnings),
    ]);
    if (raw.inputFingerprintVersion !== 2) {
      blockers.push("Detection evidence predates the current deployment contract. Run stack detection again.");
    }
    if (!language) blockers.push("Only JavaScript and Python web applications are supported.");
    if (!framework || !SUPPORTED_FRAMEWORKS.has(framework)) {
      blockers.push("A supported Python or JavaScript web framework could not be inferred safely.");
    }
    if (!profile.commitSha) blockers.push("Repository commit evidence is missing. Run stack detection again.");
    const dependencyManifest = this.selectDependencyManifest(language, this.stringArray(raw.dependencyFiles));
    if (!dependencyManifest) blockers.push("A supported dependency manifest could not be identified in the application root.");
    if (!this.stringValue(raw.installCommand)) blockers.push("A deterministic dependency installation command could not be inferred.");
    if (raw.appRootConfidence === "low") blockers.push("Application root could not be selected unambiguously. Configure the application directory and run detection again.");
    if (!profile.selectedTemplate || profile.selectedTemplate === "custom-dockerfile-required") {
      blockers.push("No safe Docker deployment strategy is available for this repository.");
    }
    if (!port) blockers.push("A container and ALB target port could not be inferred safely.");
    if (!healthPath.startsWith("/")) blockers.push("Health-check path must start with '/'.");
    if (databaseRequired && !databaseTier?.provider) {
      blockers.push(`Database tier required. This app needs ${databaseEngine === "mysql" ? "MySQL" : "PostgreSQL"}. Configure a DeployGuard-managed database or provide an external endpoint.`);
    }
    if (databaseRequired && !databaseEngine) blockers.push("Database engine could not be inferred. Choose PostgreSQL or MySQL in Project Settings.");
    if (databaseRequired && databaseTier?.provider === DatabaseTierProvider.NONE) blockers.push("Database setup cannot be skipped because the application requires a database.");
    if (databaseTier?.provider === DatabaseTierProvider.EXTERNAL && this.localDatabaseHost(databaseTier.externalHost)) {
      blockers.push("External database host cannot be localhost because the application runs in ECS.");
    }
    if (databaseRequired && raw.databaseLocalhostDetected === true && !databaseTier?.provider) {
      blockers.push("Local database configuration detected. 127.0.0.1 and localhost point to the ECS application container, not a database. Configure a managed or reachable external database.");
    }
    if (runtimeType === "static") {
      if (!profile.buildCommand) blockers.push("Static applications require a production build command.");
      if (!this.stringValue(raw.outputDirectory)) blockers.push("Static build output directory could not be inferred safely.");
    } else {
      if (!profile.startCommand) blockers.push("A safe production start command could not be inferred.");
      if (raw.bindsToPortEnv !== true && !profile.hasDockerfile) {
        blockers.push("Server does not prove that it binds to the platform PORT environment variable.");
      }
      if (raw.bindHost === "localhost") blockers.push("Server binds only to localhost instead of 0.0.0.0.");
      if (!this.stringValue(raw.bindHost)) blockers.push("Server bind host could not be proven safe for ECS.");
    }
    if (missingEnvVars.length) {
      blockers.push(`Missing required environment variables: ${missingEnvVars.join(", ")}.`);
    }
    if (missingOptionalEnvVars.length) warnings.push(`Optional environment variables are not configured: ${missingOptionalEnvVars.join(", ")}.`);
    const unsupportedSecretBuild = requiredEnvVars.filter(
      (key) => buildTimeEnvVars.includes(key) && secretEnvVars.includes(key) && configured.has(key)
    );
    if (unsupportedSecretBuild.length) {
      blockers.push(`Required build secrets need secure Docker BuildKit secret injection before deployment: ${unsupportedSecretBuild.join(", ")}.`);
    }
    const overridesHash = analysisFingerprint(project.deploymentOverrides || {});
    if (profile.inputFingerprint !== detectionFingerprint(project, profile.commitSha)) {
      blockers.push("Repository settings or deployment overrides changed after detection. Run stack detection again.");
    }
    const draft = {
      projectId: project.id,
      detectionProfileId: profile.id,
      repositoryFullName: project.repositoryFullName || null,
      branch: project.targetBranch,
      commitSha: profile.commitSha || null,
      appRoot: this.stringValue(raw.appDirectory) || ".",
      language,
      framework,
      runtimeType,
      packageManager: profile.packageManager || null,
      dependencyManifest,
      lockfile: this.selectLockfile(profile.packageManager, this.stringArray(raw.lockfiles)),
      nodeVersion: language === "javascript" ? profile.runtimeVersion || null : null,
      pythonVersion: language === "python" ? profile.runtimeVersion || null : null,
      installCommand: this.stringValue(raw.installCommand),
      buildCommand: profile.buildCommand || null,
      startCommand: profile.startCommand || null,
      outputDirectory: this.stringValue(raw.outputDirectory),
      port,
      portSource: project.deploymentOverrides?.port ? "override" : this.stringValue(raw.portSource) || (profile.expectedPort ? "detected" : template?.defaultPort ? "template_default" : null),
      bindsToPortEnv: raw.bindsToPortEnv === true,
      bindHost: this.stringValue(raw.bindHost),
      healthPath,
      requiredEnvVars,
      optionalEnvVars,
      buildTimeEnvVars,
      runtimeEnvVars,
      secretEnvVars,
      missingEnvVars,
      databaseRequired,
      databaseEngine,
      persistentStorageRequired: profile.requiresPersistentStorage || raw.persistentStorageRequired === true,
      privateRegistryRequired: raw.privateRegistryRequired === true || requiredEnvVars.includes("NPM_TOKEN"),
      dockerStrategy: profile.hasDockerfile ? "custom" as const : "generated" as const,
      dockerTemplate: profile.selectedTemplate || null,
      ecsPlan,
      blockers: this.unique(blockers),
      warnings: this.unique(warnings),
      confidence: profile.confidence || "low",
      generatedAt: new Date(),
      detectionSourceCommit: profile.commitSha || null,
      overridesHash,
      invalidatedReason: null,
      invalidatedAt: null,
    };
    const contractHash = analysisFingerprint({ version: 1, ...draft, generatedAt: undefined });
    const entity = contracts.create({
      ...(existing || {}),
      ...draft,
      contractHash,
      deployable: draft.blockers.length === 0,
      generatedDockerfile: null,
    });
    if (entity.dockerStrategy === "generated" && template) {
      try {
        entity.generatedDockerfile = this.dockerTemplateEngine.renderDockerfile(template, entity);
      } catch {
        entity.blockers = this.unique([...entity.blockers, "Dockerfile generation failed for the deployment contract."]);
        entity.deployable = false;
      }
    }
    const savedContract = await contracts.save(entity);
    if (databaseRequired || databaseTier) {
      const tierRecord = databaseTier || databaseTiers.create({
        projectId: project.id,
        provider: null,
        externalHost: null,
        externalPort: null,
        internalHost: null,
        databaseName: detectedDatabaseName,
        databaseUser: `dg_${project.id.replace(/-/g, "").slice(0, 12)}`,
        persistenceEnabled: true,
        backupEnabled: true,
        efsFileSystemId: null,
        efsAccessPointId: null,
        credentialsSecretArn: null,
        databaseUrlSecretArn: null,
        backupPlanId: null,
        lastBackupAt: null,
        lastRestoreAt: null,
        restoreMetadata: null,
        lastError: null,
      });
      tierRecord.requiredByDetection = databaseRequired;
      tierRecord.engine = tierRecord.engine || databaseEngine;
      if (!tierRecord.provider) tierRecord.status = databaseRequired ? DatabaseTierStatus.SETUP_REQUIRED : DatabaseTierStatus.NOT_REQUIRED;
      await databaseTiers.save(tierRecord);
    }
    return savedContract;
  }

  async getForProject(projectId: string, manager?: EntityManager) {
    return (manager?.getRepository(ProjectDeploymentContract) || this.contractRepository).findOne({ where: { projectId } });
  }

  async requireForProject(projectId: string) {
    const contract = await this.getForProject(projectId);
    if (!contract) throw new NotFoundException("Run stack detection to generate a deployment contract");
    return contract;
  }

  async invalidateProject(projectId: string, reason: string, manager?: EntityManager) {
    if (!manager && this.dataSource) {
      return this.dataSource.transaction(async (transactionManager) => {
        await acquireProjectConfigurationAdvisoryLock(transactionManager, projectId, "production");
        return this.invalidateProject(projectId, reason, transactionManager);
      });
    }
    const contracts = manager?.getRepository(ProjectDeploymentContract) || this.contractRepository;
    const contract = await contracts.findOne({ where: { projectId } });
    if (!contract) return null;
    contract.deployable = false;
    contract.invalidatedReason = reason;
    contract.invalidatedAt = new Date();
    contract.blockers = this.unique([...contract.blockers, reason]);
    return contracts.save(contract);
  }

  assertDeployable(contract: ProjectDeploymentContract, project: Project) {
    if (contract.invalidatedReason) throw new BadRequestException(contract.invalidatedReason);
    if (
      contract.repositoryFullName !== project.repositoryFullName ||
      contract.branch !== project.targetBranch ||
      contract.overridesHash !== analysisFingerprint(project.deploymentOverrides || {})
    ) {
      throw new BadRequestException("Deployment contract is stale. Run stack detection and pre-flight again.");
    }
    if (!contract.deployable) {
      throw new BadRequestException(`Deployability pre-flight failed. ${contract.blockers.slice(0, 3).join(" ")}`);
    }
  }

  private environmentEvidence(raw: Record<string, unknown>): EnvironmentEvidence[] {
    if (!Array.isArray(raw.environmentVariables)) return [];
    return raw.environmentVariables
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        key: String(item.key || ""),
        required: item.required === true,
        phase: item.phase === "build" ? "build" as const : "runtime" as const,
        secret: item.secret === true,
        public: item.public === true,
        detectedDefault: item.secret === true ? undefined : this.stringValue(item.detectedDefault) || undefined,
      }))
      .filter((item) => /^[A-Z][A-Z0-9_]*$/.test(item.key));
  }

  private runtimeType(raw: Record<string, unknown>, profile: ProjectDetectionProfile): DeploymentRuntimeType {
    return raw.runtimeType === "static" || profile.staticOutput ? "static" : "server";
  }

  private language(profile: ProjectDetectionProfile): DeploymentContractLanguage | null {
    if (profile.language === "javascript" || profile.ecosystem === "node") return "javascript";
    if (profile.language === "python" || profile.ecosystem === "python") return "python";
    return null;
  }

  private selectLockfile(packageManager: string | null, lockfiles: string[]) {
    const expected: Record<string, string> = { npm: "package-lock.json", yarn: "yarn.lock", pnpm: "pnpm-lock.yaml", bun: "bun.lock", poetry: "poetry.lock", pipenv: "Pipfile.lock", pip: "requirements.txt" };
    return lockfiles.find((item) => item === expected[packageManager || ""]) || lockfiles[0] || null;
  }

  private selectDependencyManifest(language: DeploymentContractLanguage | null, manifests: string[]) {
    const preference = language === "javascript"
      ? ["package.json"]
      : language === "python"
        ? ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg"]
        : [];
    return preference.find((name) => manifests.includes(name)) || null;
  }

  private stringArray(value: unknown) {
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  }

  private stringValue(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private unique(values: string[]) {
    return [...new Set(values.map((item) => item.trim()).filter(Boolean))].sort();
  }

  private databaseEngine(value: unknown): "postgres" | "mysql" | null {
    const engine = String(value || "").toLowerCase();
    if (/postgres|postgresql/.test(engine)) return "postgres";
    if (/mysql|mariadb/.test(engine)) return "mysql";
    return null;
  }

  private localDatabaseHost(host: string | null | undefined) {
    return /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|host\.docker\.internal)$/i.test((host || "").trim());
  }
}
