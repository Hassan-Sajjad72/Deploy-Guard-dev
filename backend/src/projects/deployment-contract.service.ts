import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, Repository } from "typeorm";
import { acquireProjectConfigurationAdvisoryLock } from "../infrastructure/database-service-binding.service";
import { canonicalEnvironmentName } from "./canonical-environment";
import { getOrchestrationConfig } from "../orchestration/orchestration.config";
import {
  DETECTION_INPUT_FINGERPRINT_VERSION,
  analysisFingerprint,
  deploymentContractFingerprint,
  detectionFingerprint,
} from "./analysis-fingerprint";
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
import { isPublicFrontendConfigurationKey, isSecretConfigurationKey, platformRuntimeVariableNames, SERVICE_ALIAS_GROUPS, serviceAlias } from "./configuration-ownership";
import { BUILD_PLAN_DETECTOR_VERSION, BUILD_PLAN_VERSION, BuildInitialization, BuildPlan, BuildPlanComponent, BuildPlanEnvironmentOwnership, BuildPlanImageFamily, buildPlanComponents, requireBuildPlan } from "./build-plan";
import type { DeploymentProfileDraft, DetectedApplicationTopology } from "./detection/stack-detection.service";
import { evaluateBuildPlanReadiness } from "./build-plan-readiness";
import { deploymentContractMatchesIdentity, RepositoryAnalysisIdentity } from "./deployment-contract-identity";
import { ManagedDatabaseEngine, managedDatabaseEngine, managedDatabaseProfile } from "./managed-database-engine";
import { hasCurrentCanonicalTopology } from "./detection/topology.types";
import { readinessWarningDetails, type ReadinessWarningDetail } from "./readiness-warning";
import { PLATFORM_BACKEND_MOUNT } from "./service-binding";

const SUPPORTED_FRAMEWORKS = new Set([
  "vite-react",
  "react",
  "create-react-app",
  "vite-vue",
  "nuxt",
  "angular",
  "sveltekit",
  "astro",
  "remix",
  "nextjs",
  "express",
  "nestjs",
  "fastify",
  "flask",
  "fastapi",
  "django",
  "streamlit",
]);
const BUILD_TIME_NAME = /^(VITE_|NEXT_PUBLIC_|REACT_APP_)/;

type EnvironmentEvidence = {
  key: string;
  required?: boolean;
  phase?: "build" | "runtime";
  secret?: boolean;
  public?: boolean;
  ownership: "user" | "repository_build" | "platform";
  component?: "frontend" | "backend" | "platform";
  componentId?: "frontend" | "backend" | "application";
  exposure?: "public" | "private";
  requirement?: "required" | "optional" | "unknown";
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
        const project = await transactionManager.getRepository(Project).findOne({ where: { id: projectId } });
        if (!project) return null;
        await acquireProjectConfigurationAdvisoryLock(transactionManager, projectId, canonicalEnvironmentName(project));
        return this.refreshForProject(projectId, transactionManager);
      });
    }
    const projects = manager?.getRepository(Project) || this.projectRepository;
    const profiles = manager?.getRepository(ProjectDetectionProfile) || this.profileRepository;
    const [project, profile] = await Promise.all([
      projects.findOne({ where: { id: projectId } }),
      profiles.findOne({ where: { projectId } }),
    ]);
    if (!project || !profile || !profile.commitSha || profile.repositoryFullName?.toLowerCase() !== project.repositoryFullName?.toLowerCase() || profile.targetBranch !== project.targetBranch || profile.inputFingerprint !== detectionFingerprint(project, profile.commitSha) || !hasCurrentCanonicalTopology(profile.rawProfile)) return null;
    return this.upsertFromDetection(project, profile, manager);
  }

  async upsertFromDetection(project: Project, profile: ProjectDetectionProfile, manager?: EntityManager) {
    if (!profile.commitSha || profile.repositoryFullName?.toLowerCase() !== project.repositoryFullName?.toLowerCase() || profile.targetBranch !== project.targetBranch || profile.inputFingerprint !== detectionFingerprint(project, profile.commitSha)) {
      throw new BadRequestException("Repository analysis identity does not match the selected repository and branch.");
    }
    if (!manager && this.dataSource) {
      return this.dataSource.transaction(async (transactionManager) => {
        await acquireProjectConfigurationAdvisoryLock(transactionManager, project.id, canonicalEnvironmentName(project));
        return this.upsertFromDetection(project, profile, transactionManager);
      });
    }
    const contracts = manager?.getRepository(ProjectDeploymentContract) || this.contractRepository;
    const environment = manager?.getRepository(ProjectEnvironmentVariable) || this.environmentRepository;
    const databaseTiers = manager?.getRepository(ProjectDatabaseTier) || this.databaseTierRepository;
    const [existing, environmentVariables, persistedDatabaseTier] = await Promise.all([
      contracts.findOne({ where: { projectId: project.id } }),
      environment.find({ where: { projectId: project.id, environment: canonicalEnvironmentName(project), isActive: true }, order: { key: "ASC" } }),
      databaseTiers.findOne({ where: { projectId: project.id } }),
    ]);
    const analysisRaw = (profile.rawProfile || {}) as Record<string, unknown>;
    const topology = this.applicationTopology(analysisRaw);
    const topologyDatabaseOwner = topology?.managedDatabase
      ? topology.components.find((component) => component.id === topology.managedDatabase!.ownerComponentId) || null
      : null;
    const unresolvedMultiComponentRuntimeOwner = Boolean(topology && topology.managedDatabase && !topologyDatabaseOwner);
    // The persisted aggregate profile remains the non-database contract
    // source. Database facts may refine it only through the topology's exact
    // ownerComponentId; a component-count fallback would reintroduce owner
    // inference after topology has already made that authority explicit.
    const contractProfile = topologyDatabaseOwner?.profile || profile;
    const raw = (contractProfile.rawProfile || {}) as Record<string, unknown>;
    const databaseRequired = topology
      ? Boolean(topologyDatabaseOwner && (topologyDatabaseOwner.profile.requiresDatabase || topology.managedDatabase))
      : contractProfile.requiresDatabase || raw.databaseRequired === true;
    const detectedDatabaseEngine = this.databaseEngine(topology
      ? topology.managedDatabase?.engine || topologyDatabaseOwner?.databaseType
      : raw.databaseEngine || contractProfile.databaseType);
    // Database detection is an authoritative platform decision.  A project that
    // needs a database never waits for a second, manual provider-selection
    // screen: DeployGuard owns the detected database service and its persistence.
    const generatedDatabaseUser = `dg_${project.id.replace(/-/g, "").slice(0, 12)}`;
    const detectedDatabaseName = this.environmentEvidence(raw).find((item) => item.key === "DB_NAME")?.detectedDefault || null;
    const establishedDatabaseEngine = persistedDatabaseTier?.provider === DatabaseTierProvider.MANAGED
      && Boolean(persistedDatabaseTier.efsFileSystemId || persistedDatabaseTier.credentialsSecretArn || persistedDatabaseTier.status === DatabaseTierStatus.READY)
      ? persistedDatabaseTier.engine
      : null;
    const databaseEngineMismatch = Boolean(establishedDatabaseEngine && detectedDatabaseEngine && establishedDatabaseEngine !== detectedDatabaseEngine);
    const databaseTier = databaseRequired && detectedDatabaseEngine
      ? databaseTiers.create({
          ...(persistedDatabaseTier || {}),
          projectId: project.id,
          requiredByDetection: true,
          provider: DatabaseTierProvider.MANAGED,
          engine: establishedDatabaseEngine || detectedDatabaseEngine,
          status: persistedDatabaseTier?.provider === DatabaseTierProvider.MANAGED
            ? persistedDatabaseTier.status
            : DatabaseTierStatus.PENDING,
          externalHost: null,
          externalPort: null,
          internalHost: `db.project-${project.id}.deployguard.local`,
          databaseName: detectedDatabaseName || persistedDatabaseTier?.databaseName || `app_${project.id.replace(/-/g, "").slice(0, 8)}`,
          databaseUser: persistedDatabaseTier?.provider === DatabaseTierProvider.MANAGED && persistedDatabaseTier.databaseUser
            ? persistedDatabaseTier.databaseUser
            : generatedDatabaseUser,
          persistenceEnabled: true,
          backupEnabled: false,
          lastError: persistedDatabaseTier?.provider === DatabaseTierProvider.MANAGED ? persistedDatabaseTier.lastError : null,
        })
      : persistedDatabaseTier;
    const databaseEngine = databaseRequired ? databaseTier?.engine || detectedDatabaseEngine : null;
    const managedDatabaseVariables = databaseRequired && databaseTier?.provider === DatabaseTierProvider.MANAGED
      ? new Set(SERVICE_ALIAS_GROUPS.filter((group) => group.service === (databaseTier.engine || detectedDatabaseEngine || "postgres")).flatMap((group) => [...group.aliases]))
      : new Set<string>();
    const evidence = topology
      ? this.uniqueEnvironmentEvidence(topology.components.flatMap((component) => this.topologyEnvironmentEvidence(component.environment, component.id)))
      : this.environmentEvidence(raw);
    const userEvidence = evidence.filter((item) => item.ownership === "user");
    const platformVariableNames = new Set([
      ...platformRuntimeVariableNames(this.language(contractProfile), this.runtimeType(raw, contractProfile)),
      ...(topology?.serviceBindings || []).map((binding) => binding.envAlias),
    ]);
    const repositoryRequired = userEvidence.filter((item) => item.required).map((item) => item.key).filter((key) => !platformVariableNames.has(key));
    const requiredEnvVars = this.unique(repositoryRequired);
    const optionalEnvVars = this.unique([
      ...(topology ? [] : this.stringArray(raw.optionalEnvironmentVariables)),
      ...userEvidence.filter((item) => !item.required).map((item) => item.key).filter((key) => !platformVariableNames.has(key)),
    ]);
    const unknownEnvVars = new Set(userEvidence.filter((item) => item.requirement === "unknown").map((item) => item.key));
    const configured = new Map(environmentVariables.map((item) => [item.key, item]));
    const missingEnvVars = requiredEnvVars.filter((key) => !configured.has(key) && !managedDatabaseVariables.has(key));
    const missingOptionalEnvVars = optionalEnvVars.filter((key) => !unknownEnvVars.has(key) && !configured.has(key));
    const missingUnknownEnvVars = optionalEnvVars.filter((key) => unknownEnvVars.has(key) && !configured.has(key) && !managedDatabaseVariables.has(key));
    const buildTimeEnvVars = this.unique([
      ...userEvidence.filter((item) => item.phase === "build").map((item) => item.key),
      ...[...requiredEnvVars, ...optionalEnvVars].filter((key) => BUILD_TIME_NAME.test(key)),
    ]);
    const runtimeEnvVars = this.unique([
      ...userEvidence.filter((item) => item.phase !== "build").map((item) => item.key),
      ...[...requiredEnvVars, ...optionalEnvVars].filter((key) => !BUILD_TIME_NAME.test(key)),
    ]);
    const secretEnvVars = this.unique([
      ...userEvidence.filter((item) => item.secret).map((item) => item.key),
      ...[...requiredEnvVars, ...optionalEnvVars].filter((key) => isSecretConfigurationKey(key) && !BUILD_TIME_NAME.test(key)),
    ]);
    const runtimeType = this.runtimeType(raw, contractProfile);
    const language = this.language(contractProfile);
    const template = this.templateRegistry.getTemplate(contractProfile.selectedTemplate || "");
    const dockerStrategy = contractProfile.selectedTemplate === "custom-dockerfile" ? "custom" as const : "generated" as const;
    const port = contractProfile.expectedPort || template?.defaultPort || null;
    const healthPath = contractProfile.healthCheckPath || "/";
    const framework = contractProfile.framework || null;
    const large = Boolean(framework && ["nextjs", "django"].includes(framework));
    const orchestration = getOrchestrationConfig(this.config);
    const environmentName = canonicalEnvironmentName(project);
    const configuredRuntime = runtimeEnvVars.filter((key) => configured.has(key));
    const secretRuntime = configuredRuntime.filter((key) => secretEnvVars.includes(key));
    const environmentMappings: DeploymentEnvironmentMapping[] = configuredRuntime
      .filter((key) => !secretEnvVars.includes(key))
      .map((name) => ({ name, source: "project" as const }));
    for (const name of platformRuntimeVariableNames(language, runtimeType)) {
      if (!environmentMappings.some((item) => item.name === name)) environmentMappings.push({ name, source: "platform" });
    }
    const databaseHost = databaseTier?.provider === DatabaseTierProvider.MANAGED
      ? databaseTier.internalHost || `db.project-${project.id}.deployguard.local`
      : databaseTier?.provider === DatabaseTierProvider.EXTERNAL ? databaseTier.externalHost : null;
    const databaseProfile = managedDatabaseProfile(databaseEngine);
    const databasePort = databaseTier?.provider === DatabaseTierProvider.EXTERNAL
      ? databaseTier.externalPort
      : databaseProfile?.port || null;
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
      command: runtimeType === "static" ? "nginx static runtime" : contractProfile.startCommand,
      cpu: large ? orchestration.largeCpu : orchestration.defaultCpu,
      memory: large ? orchestration.largeMemory : orchestration.defaultMemory,
      environmentMappings,
      secretMappings: [...secretRuntime.map((name) => ({ name, source: "project_secret" as const })), ...externalDatabaseSecrets, ...platformSecrets]
        .filter((item, index, items) => items.findIndex((candidate) => candidate.name === item.name) === index),
      logGroups: {
        app: `/deployguard/${project.id}/${environmentName}/app`,
        database: `/deployguard/${project.id}/${environmentName}/database`,
        deployment: `/deployguard/${project.id}/${environmentName}/deployment`,
      },
      database: {
        required: databaseRequired,
        provider: databaseTier?.provider || null,
        engine: databaseEngine,
        host: databaseHost,
        port: databasePort,
        databaseName: databaseTier?.databaseName || detectedDatabaseName,
        databaseUser: databaseTier?.databaseUser || null,
        image: databaseTier?.provider === DatabaseTierProvider.MANAGED ? databaseProfile?.image || null : null,
        dataPath: databaseTier?.provider === DatabaseTierProvider.MANAGED ? databaseProfile?.dataPath || null : null,
        healthCheck: databaseTier?.provider === DatabaseTierProvider.MANAGED ? databaseProfile?.healthCheck || null : null,
        initializationEnvironment: databaseTier?.provider === DatabaseTierProvider.MANAGED ? databaseProfile?.initializationEnvironment || [] : [],
        initializationSecretNames: databaseTier?.provider === DatabaseTierProvider.MANAGED ? databaseProfile?.initializationSecretNames || [] : [],
        urlScheme: databaseTier?.provider === DatabaseTierProvider.MANAGED ? databaseProfile?.urlScheme || null : null,
        urlQuery: databaseTier?.provider === DatabaseTierProvider.MANAGED ? databaseProfile?.urlQuery || "" : "",
        persistenceEnabled: databaseTier?.provider === DatabaseTierProvider.MANAGED && databaseTier.persistenceEnabled,
      },
    };
    const blockers = this.unique(topology
      ? [
          ...topology.blockers,
          ...topology.components.flatMap((component) => component.profile.errors || []),
          ...topology.components.flatMap((component) => this.stringArray(component.profile.rawProfile?.deployabilityBlockers)),
        ]
      : [
          ...(contractProfile.errors || []),
          ...this.stringArray(raw.deployabilityBlockers),
        ]);
    // A selectable topology is intentionally INPUT_REQUIRED. Do not replace
    // that actionable choice with a terminal runtime-owner blocker before a
    // component selection has been made.
    if (unresolvedMultiComponentRuntimeOwner && topology?.analysisState !== "INPUT_REQUIRED") {
      blockers.push("A runtime configuration owner could not be resolved for this multi-component repository.");
    }
    if (databaseEngineMismatch) {
      blockers.push(`Repository analysis requires ${managedDatabaseProfile(detectedDatabaseEngine)?.label}, but this project owns established ${managedDatabaseProfile(establishedDatabaseEngine)?.label} persistence. Full project Destroy is required before changing database engines.`);
    }
    const applicationPersistentStorageRequired = topology
      ? topology.components.some((component) => component.profile.requiresPersistentStorage || component.profile.rawProfile?.persistentStorageRequired === true)
      : contractProfile.requiresPersistentStorage || raw.persistentStorageRequired === true;
    if (applicationPersistentStorageRequired) {
      blockers.push("Application file-system persistence is not supported by the active GitHub Actions deployment engine. Use external object storage or remove the local persistent-file requirement.");
    }
    const warnings = this.unique(topology
      ? [
          ...topology.warnings,
          ...topology.components.flatMap((component) => component.profile.warnings || []),
          ...topology.components.flatMap((component) => this.stringArray(component.profile.rawProfile?.deployabilityWarnings)),
        ]
      : [
          ...(contractProfile.warnings || []),
          ...this.stringArray(raw.deployabilityWarnings),
        ]);
    const explicitWarningDetails = topology
      ? topology.components.flatMap((component) => this.warningDetails(component.profile.rawProfile?.deployabilityWarningDetails))
      : this.warningDetails(raw.deployabilityWarningDetails);
    if (analysisRaw.inputFingerprintVersion !== DETECTION_INPUT_FINGERPRINT_VERSION || !hasCurrentCanonicalTopology(analysisRaw)) {
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
    if (!contractProfile.selectedTemplate || contractProfile.selectedTemplate === "custom-dockerfile-required") {
      blockers.push("No safe Docker deployment strategy is available for this repository.");
    }
    if (contractProfile.selectedTemplate !== "custom-dockerfile" && template && contractProfile.packageManager && !template.supportedPackageManagers.includes(contractProfile.packageManager)) {
      blockers.push(`Package manager ${contractProfile.packageManager} is not supported by the selected Docker template.`);
    }
    if (!port) blockers.push("A container and ALB target port could not be inferred safely.");
    if (!healthPath.startsWith("/")) blockers.push("Health-check path must start with '/'.");
    if (databaseRequired && !databaseTier?.provider) {
      blockers.push(`Database tier required. This app needs ${databaseProfile?.label || "a supported database"}. Configure the DeployGuard-managed database.`);
    }
    if (databaseRequired && !databaseEngine) blockers.push("Database engine could not be inferred. Choose PostgreSQL, MySQL, or MongoDB in Project Settings.");
    if (databaseRequired && databaseTier?.provider === DatabaseTierProvider.NONE) blockers.push("Database setup cannot be skipped because the application requires a database.");
    if (databaseTier?.provider === DatabaseTierProvider.EXTERNAL && this.localDatabaseHost(databaseTier.externalHost)) {
      blockers.push("External database host cannot be localhost because the application runs in ECS.");
    }
    // Localhost may be a repository's documented development default.  Once a
    // managed tier is selected, its exact database aliases are superseded by
    // the generated service binding, so that default is not an ECS endpoint.
    // Keep the guard for unresolved or external configuration, where a local
    // host could still reach the generated runtime unchanged.
    if (databaseRequired && raw.databaseLocalhostDetected === true && databaseTier?.provider !== DatabaseTierProvider.MANAGED) {
      blockers.push("Local database configuration detected. Localhost and Docker Compose service aliases are not valid ECS database hosts; use the DeployGuard-managed database environment contract.");
    }
    if (runtimeType === "static") {
      if (!contractProfile.buildCommand) blockers.push("Static applications require a production build command.");
      if (!this.stringValue(raw.outputDirectory)) blockers.push("Static build output directory could not be inferred safely.");
    } else {
      if (!contractProfile.startCommand) blockers.push("A safe production start command could not be inferred.");
      if (raw.bindsToPortEnv !== true && dockerStrategy === "generated") {
        blockers.push("Server does not prove that it binds to the platform PORT environment variable.");
      }
      if (raw.bindHost === "localhost") blockers.push("Server binds only to localhost instead of 0.0.0.0.");
      if (!this.stringValue(raw.bindHost)) blockers.push("Server bind host could not be proven safe for ECS.");
    }
    if (missingOptionalEnvVars.length) warnings.push(`Optional environment variables are not configured: ${missingOptionalEnvVars.join(", ")}.`);
    if (missingUnknownEnvVars.length) warnings.push(`Configuration requiredness could not be proven; provide or explicitly classify these values before deployment: ${missingUnknownEnvVars.join(", ")}.`);
    const warningDetails = readinessWarningDetails(warnings, explicitWarningDetails);
    const unsupportedSecretBuild = buildTimeEnvVars.filter((key) => secretEnvVars.includes(key));
    if (unsupportedSecretBuild.length) {
      blockers.push(`Secret variables cannot be used during image build: ${unsupportedSecretBuild.join(", ")}.`);
    }
    const overridesHash = analysisFingerprint(project.deploymentOverrides || {});
    if (profile.inputFingerprint !== detectionFingerprint(project, profile.commitSha)) {
      blockers.push("Repository settings or deployment overrides changed after detection. Run stack detection again.");
    }
    const lockfile = this.selectLockfile(contractProfile.packageManager, this.stringArray(raw.lockfiles));
    const runtimeVersion = this.pinnedRuntimeVersion(language, contractProfile.runtimeVersion, template?.baseImage || null);
    const environmentOwnership = this.buildPlanEnvironmentOwnership(evidence, managedDatabaseVariables, platformVariableNames);
    const plan: BuildPlan = {
      planVersion: BUILD_PLAN_VERSION,
      detectorVersion: BUILD_PLAN_DETECTOR_VERSION,
      repositoryFullName: project.repositoryFullName || "",
      branch: project.targetBranch,
      commitSha: profile.commitSha || "",
      detectorId: this.stringValue(raw.detectorId) || `${contractProfile.framework || "unknown"}:${contractProfile.frameworkVariant || contractProfile.selectedTemplate || "unknown"}`,
      language: language || "javascript",
      framework: framework || "unknown",
      frameworkMode: contractProfile.frameworkVariant || contractProfile.selectedTemplate || "unknown",
      confidence: contractProfile.confidence || "low",
      platformBackendMount: PLATFORM_BACKEND_MOUNT,
      evidence: this.buildPlanEvidence(raw, profile),
      appRoot: this.stringValue(raw.appDirectory) || ".",
      repositoryInstallRoot: this.stringValue(raw.repositoryInstallRoot) || this.stringValue(raw.appDirectory) || ".",
      packageManager: contractProfile.packageManager || "",
      dependencyManifest: dependencyManifest || "",
      lockfile,
      runtimeVersion,
      baseImage: dockerStrategy === "custom" ? this.stringValue(raw.dockerfileBuildImage) || "" : this.stringValue(raw.resolvedBaseImage) || template?.baseImage || "",
      runtimeImage: dockerStrategy === "custom" ? this.stringValue(raw.dockerfileRuntimeImage) || "" : this.stringValue(raw.resolvedRuntimeImage) || template?.runtimeImage || "",
      ...(dockerStrategy === "generated" ? {
        buildImageFamily: this.imageFamily(this.stringValue(raw.resolvedBaseImage) || template?.baseImage || ""),
        runtimeImageFamily: this.imageFamily(this.stringValue(raw.resolvedRuntimeImage) || template?.runtimeImage || ""),
      } : {}),
      installCommand: this.stringValue(raw.installCommand) || "",
      buildCommand: contractProfile.buildCommand || null,
      buildCommands: contractProfile.buildCommand ? [contractProfile.buildCommand] : [],
      ...(this.buildInitialization(raw, contractProfile.buildCommand || null, language, framework) ? {
        buildInitialization: this.buildInitialization(raw, contractProfile.buildCommand || null, language, framework),
      } : {}),
      releaseCommand: this.stringValue(raw.releaseCommand),
      releaseCommands: this.stringValue(raw.releaseCommand) ? [this.stringValue(raw.releaseCommand)!] : [],
      runCommand: contractProfile.startCommand || null,
      runtimeFiles: this.stringArray(raw.runtimeFiles),
      outputDirectory: this.stringValue(raw.outputDirectory),
      buildSystemDependencies: this.unique(this.stringArray(raw.buildSystemDependencies)),
      runtimeSystemDependencies: this.unique(this.stringArray(raw.runtimeSystemDependencies)),
      systemDependencyEvidence: {
        build: this.unique(this.stringArray(raw.buildSystemDependencies)),
        runtime: this.unique(this.stringArray(raw.runtimeSystemDependencies)),
      },
      port: port || 0,
      portSource: project.deploymentOverrides?.port ? "override" : this.stringValue(raw.portSource) || (contractProfile.expectedPort ? "detected" : template?.defaultPort ? "template_default" : "unknown"),
      healthPath,
      bindHost: this.stringValue(raw.bindHost),
      bindsToPortEnv: raw.bindsToPortEnv === true,
      runtimeType,
      database: {
        required: databaseRequired,
        provider: databaseRequired ? "managed" : "none",
        engine: databaseEngine,
      },
      environmentOwnership,
      requiredInputs: requiredEnvVars,
      // A repository-proven required alias is an actionable configuration
      // boundary, not a deployable default. Keep the exact alias and stop
      // before image/preflight/Terraform until it is supplied.
      requiredUserInputs: this.unique([...this.stringArray(raw.detectorRequiredInputs), ...(topology?.requiredUserInputs || []), ...missingEnvVars, ...missingUnknownEnvVars]),
      optionalInputs: optionalEnvVars,
      buildTimeEnvVars,
      runtimeEnvVars,
      secretEnvVars,
      dockerStrategy,
      ...(dockerStrategy === "custom" && this.stringValue(raw.dockerfilePath) ? { dockerfilePath: this.stringValue(raw.dockerfilePath)! } : {}),
      dockerTemplate: contractProfile.selectedTemplate || "custom-dockerfile-required",
      warnings: this.unique(warnings),
      warningDetails,
      blockers: this.unique(blockers),
      serviceBindings: (topology?.serviceBindings || []).map((binding) => ({ ...binding })),
    };
    plan.components = topology
      ? topology.components.map((component) => this.componentBuildPlan(component, plan, databaseEngine))
      : buildPlanComponents(plan);
    const publicComponent = plan.components.find((component) => component.role === "frontend") || plan.components[0];
    plan.relationships = (topology?.relationships || [])
      .filter((relationship) => relationship.kind === "CALLS")
      .map((relationship) => ({
        from: "frontend" as const,
        to: "backend" as const,
        kind: "http" as const,
        mode: relationship.mode,
        pathPrefix: relationship.pathPrefix,
        stripPathPrefix: relationship.stripPathPrefix,
        buildTimeVariable: relationship.buildTimeVariable,
        verificationPath: relationship.verificationPath,
      }));
    if (topology) plan.topology = {
      schemaVersion: 3,
      shape: topology.shape,
      analysisState: topology.analysisState,
      confidence: topology.confidence,
      artifacts: topology.artifacts,
      relationships: topology.relationships as unknown as Array<Record<string, unknown>>,
      serviceBindings: plan.serviceBindings,
    };
    if (topology) {
      for (const component of topology.components) {
        for (const error of component.profile.errors || []) if (!plan.blockers.includes(error)) plan.blockers.push(error);
      }
      for (const blocker of topology.blockers || []) if (!plan.blockers.includes(blocker)) plan.blockers.push(blocker);
      if (plan.components.length > 2) plan.blockers.push("The bounded deployment contract supports no more than one frontend and one backend component.");
    }
    blockers.splice(0, blockers.length, ...this.unique(plan.blockers));
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
      packageManager: contractProfile.packageManager || null,
      dependencyManifest,
      lockfile,
      nodeVersion: language === "javascript" ? contractProfile.runtimeVersion || null : null,
      pythonVersion: language === "python" ? contractProfile.runtimeVersion || null : null,
      installCommand: this.stringValue(raw.installCommand),
      buildCommand: contractProfile.buildCommand || null,
      startCommand: contractProfile.startCommand || null,
      outputDirectory: this.stringValue(raw.outputDirectory),
      port,
      portSource: project.deploymentOverrides?.port ? "override" : this.stringValue(raw.portSource) || (contractProfile.expectedPort ? "detected" : template?.defaultPort ? "template_default" : null),
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
      persistentStorageRequired: applicationPersistentStorageRequired,
      privateRegistryRequired: raw.privateRegistryRequired === true || requiredEnvVars.includes("NPM_TOKEN"),
      dockerStrategy,
      dockerTemplate: contractProfile.selectedTemplate || null,
      ecsPlan,
      blockers: this.unique(blockers),
      warnings: this.unique(warnings),
      confidence: contractProfile.confidence || "low",
      generatedAt: new Date(),
      detectionSourceCommit: profile.commitSha || null,
      overridesHash,
      invalidatedReason: null,
      invalidatedAt: null,
      buildPlan: plan,
    };
    const contractHash = deploymentContractFingerprint(draft);
    const entity = contracts.create({
      ...(existing || {}),
      ...draft,
      contractHash,
      deployable: draft.blockers.length === 0,
      generatedDockerfile: null,
    });
    const readiness = evaluateBuildPlanReadiness(entity.buildPlan);
    if (entity.dockerStrategy === "generated" && template && (readiness.status === "READY" || readiness.status === "READY_WITH_WARNINGS")) {
      try {
        const authoritativePlan = requireBuildPlan(entity);
        const fullStack = buildPlanComponents(authoritativePlan).some((component) => component.role === "backend")
          && buildPlanComponents(authoritativePlan).some((component) => component.role === "frontend");
        const componentDockerfiles = Object.fromEntries(buildPlanComponents(authoritativePlan).map((component) => {
          const componentTemplate = this.templateRegistry.getTemplate(component.dockerTemplate);
          if (!componentTemplate) throw new Error(`Docker template '${component.dockerTemplate}' is unavailable for component '${component.id}'.`);
          const componentPlan = this.componentAsBuildPlan(authoritativePlan, component);
          const rendered = this.dockerTemplateEngine.renderDockerfile(componentTemplate, componentPlan);
          const staticBindingProxy = fullStack && component.role === "frontend" && component.runtimeType === "static";
          const webBindingProxy = fullStack && component.role === "frontend" && component.runtimeType === "server" && component.language === "javascript";
          // Static services retain their nginx runtime. JavaScript web
          // frontends retain their detected application command behind a
          // non-root nginx wrapper, so the same platform-owned mount works
          // without turning SSR into a static application.
          const dockerfile = staticBindingProxy && rendered
            ? rendered.replace(/\n(?:USER nginx\n)?EXPOSE /, "\nCOPY --chown=101:101 .deployguard-nginx.conf /etc/nginx/conf.d/default.conf\nUSER nginx\nEXPOSE ")
            : webBindingProxy && rendered
              ? `${rendered}\nUSER root\nRUN apk add --no-cache nginx && mkdir -p /var/lib/nginx/tmp /run/nginx && chown -R app:app /var/lib/nginx /run/nginx /var/log/nginx\nCOPY --chown=app:app .deployguard-web-frontend-nginx.conf /etc/nginx/http.d/default.conf\nCOPY --chown=app:app .deployguard-web-frontend-entrypoint.sh /usr/local/bin/deployguard-web-frontend\nRUN chmod 0755 /usr/local/bin/deployguard-web-frontend\nUSER app\nCMD [\"/usr/local/bin/deployguard-web-frontend\"]\n`
              : rendered;
          return [component.id, dockerfile];
        }));
        entity.generatedDockerfile = authoritativePlan.components && authoritativePlan.components.length > 1
          ? JSON.stringify({ schemaVersion: 1, components: componentDockerfiles })
          : String(Object.values(componentDockerfiles)[0] || "");
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown contract rendering error.";
        entity.blockers = this.unique([...entity.blockers, `Dockerfile generation failed for the deployment contract: ${reason}`]);
        entity.buildPlan = { ...entity.buildPlan, blockers: [...entity.blockers] };
        entity.deployable = false;
      }
    }
    entity.contractHash = deploymentContractFingerprint(entity);
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
        backupEnabled: false,
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

  async getMatchingForProject(projectId: string, identity: RepositoryAnalysisIdentity, manager?: EntityManager) {
    const contract = await this.getForProject(projectId, manager);
    return contract && deploymentContractMatchesIdentity(contract, identity) ? contract : null;
  }

  async requireForProject(projectId: string) {
    const contract = await this.getForProject(projectId);
    if (!contract) throw new NotFoundException("Run stack detection to generate a deployment contract");
    return contract;
  }

  async invalidateProject(projectId: string, reason: string, manager?: EntityManager) {
    if (!manager && this.dataSource) {
      return this.dataSource.transaction(async (transactionManager) => {
        const project = await transactionManager.getRepository(Project).findOne({ where: { id: projectId } });
        if (!project) return null;
        await acquireProjectConfigurationAdvisoryLock(transactionManager, projectId, canonicalEnvironmentName(project));
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
    try { requireBuildPlan(contract); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Authoritative BuildPlan is unavailable."); }
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

  private applicationTopology(raw: Record<string, unknown>): DetectedApplicationTopology | null {
    if (!hasCurrentCanonicalTopology(raw)) return null;
    const candidate = raw.componentTopology;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const topology = candidate as DetectedApplicationTopology;
    return topology;
  }

  private componentBuildPlan(
    component: DetectedApplicationTopology["components"][number],
    parent: BuildPlan,
    databaseEngine: ManagedDatabaseEngine | null,
  ): BuildPlanComponent {
    const profile = component.profile as DeploymentProfileDraft;
    const raw = (profile.rawProfile || {}) as Record<string, unknown>;
    const staticWeb = component.framework === "static-web";
    const language: BuildPlanComponent["language"] = staticWeb
      ? "static"
      : profile.language === "python" || profile.ecosystem === "python" ? "python" : "javascript";
    const template = this.templateRegistry.getTemplate(profile.selectedTemplate || component.frameworkVariant);
    const evidence = this.topologyEnvironmentEvidence(component.environment, component.id);
    // A server-rendered frontend is an application runtime, not a static
    // asset host.  It may therefore be the proven owner of the managed
    // database in a single-service SSR topology.
    // The topology producer already established this component's managed
    // database relationship.  Do not narrow it again from its role label.
    const componentDatabase = Boolean(component.databaseType);
    const databaseAliases = new Set(componentDatabase
      ? SERVICE_ALIAS_GROUPS.filter((group) => group.service === (databaseEngine || component.databaseType || "postgres")).flatMap((group) => [...group.aliases])
      : []);
    const platformNames = new Set(platformRuntimeVariableNames(language === "static" ? "javascript" : language, component.runtimeType));
    const dependencyManifest = staticWeb ? "index.html" : this.selectDependencyManifest(language === "static" ? null : language, this.stringArray(raw.dependencyFiles)) || "";
    const packageManager = staticWeb ? "none" : profile.packageManager || "";
    const dockerStrategy = profile.selectedTemplate === "custom-dockerfile" ? "custom" as const : "generated" as const;
    return {
      id: component.id,
      role: component.role,
      root: component.root,
      buildContext: component.buildContext,
      repositoryInstallRoot: this.stringValue(raw.repositoryInstallRoot) || parent.repositoryInstallRoot,
      detectorId: this.stringValue(raw.detectorId) || `${component.framework}:${component.frameworkVariant}`,
      language,
      framework: component.framework,
      frameworkMode: component.frameworkVariant,
      runtimeType: component.runtimeType,
      packageManager,
      dependencyManifest,
      lockfile: staticWeb ? null : this.selectLockfile(profile.packageManager, this.stringArray(raw.lockfiles)),
      runtimeVersion: staticWeb ? "static" : this.pinnedRuntimeVersion(language as DeploymentContractLanguage, profile.runtimeVersion, template?.baseImage || null),
      baseImage: dockerStrategy === "custom" ? this.stringValue(raw.dockerfileBuildImage) || "" : this.stringValue(raw.resolvedBaseImage) || template?.baseImage || "",
      runtimeImage: dockerStrategy === "custom" ? this.stringValue(raw.dockerfileRuntimeImage) || "" : this.stringValue(raw.resolvedRuntimeImage) || template?.runtimeImage || "",
      ...(dockerStrategy === "generated" ? {
        buildImageFamily: this.imageFamily(this.stringValue(raw.resolvedBaseImage) || template?.baseImage || ""),
        runtimeImageFamily: this.imageFamily(this.stringValue(raw.resolvedRuntimeImage) || template?.runtimeImage || ""),
      } : {}),
      installCommand: staticWeb ? "true" : this.stringValue(raw.installCommand) || "",
      buildSystemDependencies: this.unique(this.stringArray(raw.buildSystemDependencies)),
      runtimeSystemDependencies: this.unique(this.stringArray(raw.runtimeSystemDependencies)),
      systemDependencyEvidence: {
        build: this.unique(this.stringArray(raw.buildSystemDependencies)),
        runtime: this.unique(this.stringArray(raw.runtimeSystemDependencies)),
      },
      buildCommand: profile.buildCommand || null,
      ...(this.buildInitialization(raw, profile.buildCommand || null, language, component.framework) ? {
        buildInitialization: this.buildInitialization(raw, profile.buildCommand || null, language, component.framework),
      } : {}),
      releaseCommand: this.stringValue(raw.releaseCommand),
      runCommand: profile.startCommand || null,
      runtimeFiles: this.stringArray(raw.runtimeFiles),
      outputDirectory: staticWeb ? "." : this.stringValue(raw.outputDirectory),
      port: component.port,
      healthPath: component.healthCheckPath,
      healthCheckMode: component.healthCheckMode,
      bindHost: this.stringValue(raw.bindHost),
      bindsToPortEnv: raw.bindsToPortEnv === true,
      dockerStrategy,
      ...(dockerStrategy === "custom" && this.stringValue(raw.dockerfilePath) ? { dockerfilePath: this.stringValue(raw.dockerfilePath)! } : {}),
      dockerTemplate: profile.selectedTemplate || component.frameworkVariant,
      environmentOwnership: this.buildPlanEnvironmentOwnership(evidence, databaseAliases, platformNames, component.id),
      database: {
        required: componentDatabase,
        provider: componentDatabase ? "managed" : "none",
        engine: componentDatabase ? databaseEngine || component.databaseType : null,
      },
      persistentStorageRequired: profile.requiresPersistentStorage || raw.persistentStorageRequired === true,
    };
  }

  private componentAsBuildPlan(parent: BuildPlan, component: BuildPlanComponent): BuildPlan {
    const environmentOwnership = component.environmentOwnership;
    const requiredInputs = environmentOwnership.filter((item) => item.required && item.source !== "repository").map((item) => item.key);
    const requiredUserInputs = environmentOwnership
      .filter((item) => item.owner === "application" && item.source !== "repository" && (item.required || item.requirement === "unknown"))
      .map((item) => item.key);
    const optionalInputs = environmentOwnership.filter((item) => !item.required && item.owner === "application" && item.source !== "repository").map((item) => item.key);
    return {
      planVersion: parent.planVersion,
      detectorVersion: parent.detectorVersion,
      repositoryFullName: parent.repositoryFullName,
      branch: parent.branch,
      commitSha: parent.commitSha,
      detectorId: component.detectorId,
      language: component.language === "static" ? "javascript" : component.language,
      framework: component.framework,
      frameworkMode: component.frameworkMode,
      confidence: parent.confidence,
      platformBackendMount: parent.platformBackendMount || PLATFORM_BACKEND_MOUNT,
      evidence: parent.evidence,
      appRoot: component.root,
      repositoryInstallRoot: component.repositoryInstallRoot,
      packageManager: component.packageManager,
      dependencyManifest: component.dependencyManifest,
      lockfile: component.lockfile,
      runtimeVersion: component.runtimeVersion,
      baseImage: component.baseImage,
      runtimeImage: component.runtimeImage,
      ...(component.buildImageFamily ? { buildImageFamily: component.buildImageFamily } : {}),
      ...(component.runtimeImageFamily ? { runtimeImageFamily: component.runtimeImageFamily } : {}),
      installCommand: component.installCommand,
      buildSystemDependencies: component.buildSystemDependencies || [],
      runtimeSystemDependencies: component.runtimeSystemDependencies || [],
      systemDependencyEvidence: component.systemDependencyEvidence || { build: [], runtime: [] },
      buildCommand: component.buildCommand,
      buildCommands: component.buildCommand ? [component.buildCommand] : [],
      ...(component.buildInitialization ? { buildInitialization: component.buildInitialization } : {}),
      releaseCommand: component.releaseCommand || null,
      releaseCommands: component.releaseCommand ? [component.releaseCommand] : [],
      runCommand: component.runCommand,
      runtimeFiles: component.runtimeFiles,
      outputDirectory: component.outputDirectory,
      portSource: "component_topology",
      port: component.port,
      healthPath: component.healthCheckMode === "tcp" ? parent.healthPath : component.healthPath || parent.healthPath,
      bindHost: component.bindHost,
      bindsToPortEnv: component.bindsToPortEnv,
      runtimeType: component.runtimeType,
      database: component.database,
      environmentOwnership,
      requiredInputs,
      requiredUserInputs,
      optionalInputs,
      buildTimeEnvVars: environmentOwnership.filter((item) => item.phase === "build" && item.source !== "repository").map((item) => item.key),
      runtimeEnvVars: environmentOwnership.filter((item) => item.phase === "runtime" && item.source !== "repository").map((item) => item.key),
      secretEnvVars: environmentOwnership.filter((item) => item.secret && item.source !== "repository").map((item) => item.key),
      dockerStrategy: component.dockerStrategy,
      ...(component.dockerfilePath ? { dockerfilePath: component.dockerfilePath } : {}),
      dockerTemplate: component.dockerTemplate,
      warnings: parent.warnings,
      warningDetails: parent.warningDetails,
      blockers: parent.blockers,
      components: [component],
      relationships: (parent.relationships || []).filter((relationship) => relationship.from === component.id || relationship.to === component.id),
      serviceBindings: (parent.serviceBindings || []).filter((binding) => binding.sourceComponent === component.id || binding.targetComponent === component.id),
      topology: parent.topology,
    };
  }

  private buildInitialization(
    raw: Record<string, unknown>,
    buildCommand: string | null,
    language: string,
    framework: string,
  ): BuildInitialization | undefined {
    const candidate = raw.buildInitialization;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const value = candidate as Record<string, unknown>;
      if (value.contractVersion === "deployguard.build-initialization/v1"
        && (value.mode === "none" || value.mode === "runtime_placeholders" || value.mode === "external_service_required")
        && typeof value.reason === "string" && value.reason.trim().length > 0) {
        return { contractVersion: value.contractVersion, mode: value.mode, reason: value.reason.trim() };
      }
    }
    // Old immutable BuildPlans remain deployable while being conservative: the
    // one known settings-initializing Django build gets the same ephemeral
    // contract, rather than silently running with missing runtime values.
    if (language === "python" && framework === "django" && /(?:^|\s)manage\.py\s+collectstatic(?:\s|$)/.test(buildCommand || "")) {
      return {
        contractVersion: "deployguard.build-initialization/v1",
        mode: "runtime_placeholders",
        reason: "Legacy Django collectstatic imports settings before managed runtime services are provisioned.",
      };
    }
    return undefined;
  }

  private uniqueEnvironmentEvidence(items: EnvironmentEvidence[]) {
    const merged = new Map<string, EnvironmentEvidence>();
    for (const item of items) {
      const current = merged.get(item.key);
      merged.set(item.key, current ? {
        ...current,
        required: current.required || item.required,
        secret: current.secret || item.secret,
        phase: current.phase === "build" || item.phase === "build" ? "build" : "runtime",
        ownership: current.ownership === "platform" || item.ownership === "platform" ? "platform" : current.ownership,
        detectedDefault: current.detectedDefault || item.detectedDefault,
        component: current.component === item.component ? current.component : current.component || item.component,
        exposure: current.exposure === "public" && item.exposure === "public" ? "public" : "private",
        requirement: current.requirement === "required" || item.requirement === "required" ? "required" : current.requirement === "unknown" || item.requirement === "unknown" ? "unknown" : "optional",
      } : item);
    }
    return [...merged.values()];
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
        component: (item.component === "frontend" || item.component === "backend" || item.component === "platform" ? item.component : undefined) as EnvironmentEvidence["component"],
        exposure: item.exposure === "public" ? "public" as const : "private" as const,
        requirement: (item.requirement === "required" || item.requirement === "optional" ? item.requirement : "unknown") as EnvironmentEvidence["requirement"],
        ownership: (item.ownership === "repository_build" || item.ownership === "platform"
          ? item.ownership
          : "user") as EnvironmentEvidence["ownership"],
        detectedDefault: item.secret === true ? undefined : this.stringValue(item.detectedDefault) || undefined,
      }))
      .filter((item) => /^[A-Z][A-Z0-9_]*$/.test(item.key));
  }

  private topologyEnvironmentEvidence(environment: DetectedApplicationTopology["components"][number]["environment"], componentId: "frontend" | "backend" | "application"): EnvironmentEvidence[] {
    return environment.map((item) => ({
      key: item.name,
      required: item.requirement === "required",
      phase: item.phase === "build" ? "build" as const : "runtime" as const,
      secret: item.exposure === "private" && isSecretConfigurationKey(item.name),
      public: item.exposure === "public",
      component: item.owner === "frontend" ? "frontend" as const : item.owner === "platform" ? "platform" as const : "backend" as const,
      componentId: item.owner === "platform" ? undefined : componentId,
      exposure: item.exposure,
      requirement: item.requirement,
      ownership: item.owner === "database" || item.owner === "platform"
        ? "platform" as const
        : item.management === "repository-default" ? "repository_build" as const : "user" as const,
    })).filter((item) => /^[A-Z][A-Z0-9_]*$/.test(item.key));
  }

  private runtimeType(raw: Record<string, unknown>, profile: { staticOutput: boolean }): DeploymentRuntimeType {
    return raw.runtimeType === "static" || profile.staticOutput ? "static" : "server";
  }

  private language(profile: { language: string | null; ecosystem: string }): DeploymentContractLanguage | null {
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

  private warningDetails(value: unknown): ReadinessWarningDetail[] {
    if (!Array.isArray(value)) return [];
    const valid = value.filter((item): item is ReadinessWarningDetail => Boolean(
      item && typeof item === "object"
      && typeof item.code === "string"
      && item.severity === "warning"
      && (item.scope === "application" || item.scope === "platform")
      && item.deploymentAllowed === true
      && typeof item.message === "string",
    ));
    return valid.filter((item, index) => valid.findIndex((candidate) => candidate.code === item.code) === index);
  }

  private unique(values: string[]) {
    return [...new Set(values.map((item) => item.trim()).filter(Boolean))].sort();
  }

  private imageFamily(image: string): BuildPlanImageFamily | undefined {
    const normalized = image.toLowerCase();
    if (!normalized) return undefined;
    if (/(?:^|[-:.])alpine(?:\d|[-:.]|$)/.test(normalized)) return { distro: "alpine", packageManager: "apk" };
    if (/(?:^|[-:.])(?:slim|bookworm|bullseye|buster)(?:[-:.]|$)/.test(normalized)
      || /^(?:python|node):\d/.test(normalized)) return { distro: "debian", packageManager: "apt" };
    return undefined;
  }

  private databaseEngine(value: unknown): ManagedDatabaseEngine | null {
    return managedDatabaseEngine(value);
  }

  private localDatabaseHost(host: string | null | undefined) {
    return /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|host\.docker\.internal)$/i.test((host || "").trim());
  }

  private pinnedRuntimeVersion(language: DeploymentContractLanguage | null, detected: string | null, baseImage: string | null) {
    const imageVersion = language === "javascript"
      ? baseImage?.match(/^node:(\d+(?:\.\d+){0,2})-/)?.[1]
      : language === "python" ? baseImage?.match(/^python:(3\.\d+(?:\.\d+)?)-/)?.[1] : null;
    return imageVersion || String(detected || "").replace(/^(?:node-lts|python-)/, language === "javascript" ? "22" : "");
  }

  private buildPlanEnvironmentOwnership(evidence: EnvironmentEvidence[], managed: Set<string>, platform: Set<string>, componentId?: "frontend" | "backend" | "application"): BuildPlanEnvironmentOwnership[] {
    const entries = new Map<string, BuildPlanEnvironmentOwnership>();
    for (const item of evidence) entries.set(item.key, {
      key: item.key,
      owner: platform.has(item.key) ? "platform" : managed.has(item.key) ? "infrastructure" : item.ownership === "repository_build" || item.detectedDefault ? "repository" : "application",
      component: platform.has(item.key) ? "platform" : item.component || "application",
      ...(!platform.has(item.key) && (item.componentId || componentId) ? { componentId: item.componentId || componentId } : {}),
      source: platform.has(item.key) ? "platform" : managed.has(item.key) ? "managed_database" : item.ownership === "repository_build" || item.detectedDefault ? "repository" : "application",
      exposure: item.exposure || (isPublicFrontendConfigurationKey(item.key) && item.phase === "build" ? "public" : "private"),
      requirement: item.requirement || (item.required ? "unknown" : "optional"),
      required: item.required === true,
      phase: item.phase || "runtime",
      secret: item.secret === true,
      ...(item.detectedDefault ? { repositoryValue: item.detectedDefault } : {}),
    });
    for (const key of platform) if (!entries.has(key)) entries.set(key, { key, owner: "platform", component: "platform", source: "platform", exposure: "private", requirement: "required", required: true, phase: "runtime", secret: false });
    return [...entries.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  private buildPlanEvidence(raw: Record<string, unknown>, profile: ProjectDetectionProfile) {
    const detectorEvidence = Array.isArray(raw.detectorEvidence)
      ? raw.detectorEvidence.filter((item): item is { source: string; description: string } => Boolean(item && typeof item === "object" && typeof (item as any).source === "string" && typeof (item as any).description === "string"))
      : [];
    const evidence = [
      ...detectorEvidence,
      { source: "detection-profile", description: `profile=${profile.id}; confidence=${profile.confidence || "low"}` },
      { source: "application-root", description: this.stringValue(raw.appRootReason) || "Repository application root evidence" },
      ...this.stringArray(raw.dependencyFiles).map((file) => ({ source: file, description: "Dependency manifest evidence" })),
      ...this.stringArray(raw.lockfiles).map((file) => ({ source: file, description: "Lockfile evidence" })),
    ];
    return evidence.filter((item, index, items) => items.findIndex((candidate) => candidate.source === item.source && candidate.description === item.description) === index).slice(0, 50);
  }
}
