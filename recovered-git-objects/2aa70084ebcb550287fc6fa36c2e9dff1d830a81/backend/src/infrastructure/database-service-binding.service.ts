import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, DescribeTasksCommand, ECSClient, ListTasksCommand, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { createHash } from "node:crypto";
import { Repository } from "typeorm";
import { ProjectDatabaseTier, DatabaseTierProvider } from "../projects/project-database-tier.entity";
import { ProjectDeploymentContract } from "../projects/project-deployment-contract.entity";
import { ProjectEnvironmentCryptoService } from "../projects/project-environment-crypto.service";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { ProjectServiceBinding, ServiceBindingStatus } from "../projects/project-service-binding.entity";
import { ProjectConfigurationSnapshot } from "../projects/project-configuration-snapshot.entity";
import { ProjectDetectionProfile } from "../projects/project-detection-profile.entity";
import { ProjectPersistentStorage } from "../storage/project-persistent-storage.entity";
import {
  aliasesFor,
  ConfigurationOwner,
  isPlatformProjectProhibited,
  isSecretConfigurationKey,
  ManagedServiceKind,
  normalizeConfigurationKey,
  serviceAlias,
} from "../projects/configuration-ownership";

const MANAGED_KEYS = new Set(["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DATABASE_URL"]);
const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|host\.docker\.internal)$/i;

export type EffectiveDeploymentConfiguration = {
  binding: ProjectServiceBinding | null;
  environment: string;
  plainEnvironmentValues: Record<string, string>;
  buildArguments: Record<string, string>;
  runtimeVariables: Record<string, string>;
  projectSecretValues: Record<string, string>;
  secretReferences: Record<string, string>;
  ownership: Record<string, {
    owner: ConfigurationOwner;
    source: string;
    sourceRevision: string;
    required: boolean;
    secret: boolean;
    protected: boolean;
    serviceBindingId: string | null;
    detectedReference: string | null;
  }>;
  serviceBindingRevisions: Array<Record<string, unknown>>;
  unresolvedRequiredValues: string[];
  prohibitedOverrides: string[];
  duplicateOwnershipConflicts: string[];
  configurationFingerprint: string;
  blockers: string[];
  sanitizedDeveloperManifest: Record<string, unknown>;
};

type ResolveOptions = { requireReady?: boolean; throwOnBlockers?: boolean; useSnapshot?: boolean };

@Injectable()
export class DatabaseServiceBindingService {
  constructor(
    @InjectRepository(ProjectServiceBinding) private readonly bindings: Repository<ProjectServiceBinding>,
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectDeploymentContract) private readonly contracts: Repository<ProjectDeploymentContract>,
    @InjectRepository(ProjectDatabaseTier) private readonly tiers: Repository<ProjectDatabaseTier>,
    @InjectRepository(ProjectEnvironmentVariable) private readonly variables: Repository<ProjectEnvironmentVariable>,
    @InjectRepository(ProjectConfigurationSnapshot) private readonly snapshots: Repository<ProjectConfigurationSnapshot>,
    @InjectRepository(ProjectDetectionProfile) private readonly profiles: Repository<ProjectDetectionProfile>,
    @InjectRepository(ProjectPersistentStorage) private readonly storage: Repository<ProjectPersistentStorage>,
    private readonly crypto: ProjectEnvironmentCryptoService,
    private readonly config: ConfigService,
  ) {}

  async ensureIntent(projectId: string, pipelineRunId: string) {
    const [run, contract, tier] = await Promise.all([
      this.runs.findOne({ where: { id: pipelineRunId, projectId } }),
      this.contracts.findOne({ where: { projectId } }),
      this.tiers.findOne({ where: { projectId } }),
    ]);
    if (!run || !contract) throw new BadRequestException("The pipeline run or deployment contract is unavailable.");
    if (!contract.databaseRequired) return null;
    if (!tier?.provider || tier.provider === DatabaseTierProvider.NONE || !tier.engine) {
      throw new BadRequestException("A managed or external database binding is required before Terraform planning.");
    }
    const provider = tier.provider as "managed" | "external";
    const host = provider === "managed"
      ? tier.internalHost || `db.project-${projectId}.deployguard.local`
      : tier.externalHost || "";
    const port = provider === "managed" ? (tier.engine === "mysql" ? 3306 : 5432) : tier.externalPort || 0;
    if (!host || LOCAL_HOST.test(host) || !port || !tier.databaseName) {
      throw new BadRequestException("Database binding intent is incomplete or points to localhost.");
    }
    const fingerprint = this.fingerprint({
      requirements: contract.contractHash,
      provider,
      engine: tier.engine,
      host,
      port,
      databaseName: tier.databaseName,
      databaseUser: tier.databaseUser,
      externalTlsRequired: tier.externalTlsRequired,
      persistenceEnabled: tier.persistenceEnabled,
    });
    const existing = await this.bindings.findOne({ where: { projectId, pipelineRunId, serviceType: "database" } });
    if (existing) {
      if (existing.configurationFingerprint !== fingerprint) {
        throw new BadRequestException("This run references an older database binding revision. Start a selective resume from database binding reconciliation.");
      }
      return existing;
    }
    const binding = await this.bindings.save(this.bindings.create({
      projectId,
      pipelineRunId,
      serviceType: "database",
      provider,
      engine: tier.engine,
      status: ServiceBindingStatus.PENDING,
      databaseName: tier.databaseName,
      hostReference: host,
      port,
      usernameReference: tier.databaseUser,
      usernameSecretReference: null,
      passwordSecretReference: provider === "managed" ? "terraform://database/password" : null,
      databaseUrlSecretReference: provider === "managed" ? "terraform://database/url" : null,
      cloudMapNamespace: provider === "managed" ? `project-${projectId}.deployguard.local` : null,
      cloudMapServiceName: provider === "managed" ? "db" : null,
      cloudMapServiceArn: null,
      ecsDatabaseServiceArn: null,
      efsFileSystemId: null,
      efsAccessPointId: null,
      terraformOutputRevision: null,
      configurationFingerprint: fingerprint,
      sanitizedManifest: this.manifest(provider, tier.engine, host, port, tier.databaseName, tier.databaseUser, fingerprint, "pending"),
      failureReason: null,
      readyAt: null,
      appliedAt: null,
      verifiedAt: null,
    }));
    run.databaseServiceBindingId = binding.id;
    await this.runs.save(run);
    return binding;
  }

  async markProvisioning(projectId: string, pipelineRunId: string) {
    const binding = await this.ensureIntent(projectId, pipelineRunId);
    if (!binding) return null;
    binding.status = ServiceBindingStatus.PROVISIONING;
    binding.failureReason = null;
    return this.bindings.save(binding);
  }

  async applyTerraformOutputs(projectId: string, pipelineRunId: string, outputs: Record<string, unknown>, revision: string) {
    const binding = await this.ensureIntent(projectId, pipelineRunId);
    if (!binding || binding.provider !== "managed") return binding;
    const required = {
      host: this.string(outputs.database_internal_host),
      serviceArn: this.string(outputs.database_service_arn),
      cloudMapArn: this.string(outputs.database_cloud_map_service_arn),
      password: this.string(outputs.database_password_secret_arn),
      url: this.string(outputs.database_url_secret_arn),
      efs: this.string(outputs.database_efs_file_system_id),
      accessPoint: this.string(outputs.database_efs_access_point_id),
    };
    const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
    if (missing.length || LOCAL_HOST.test(required.host || "")) {
      binding.status = ServiceBindingStatus.FAILED;
      binding.failureReason = `Managed database Terraform outputs are incomplete: ${missing.join(", ") || "invalid host"}.`;
      await this.bindings.save(binding);
      throw new BadRequestException(binding.failureReason);
    }
    binding.hostReference = required.host!;
    binding.ecsDatabaseServiceArn = required.serviceArn;
    binding.cloudMapServiceArn = required.cloudMapArn;
    binding.passwordSecretReference = required.password;
    binding.databaseUrlSecretReference = required.url;
    binding.efsFileSystemId = required.efs;
    binding.efsAccessPointId = required.accessPoint;
    binding.terraformOutputRevision = revision;
    binding.status = ServiceBindingStatus.APPLIED;
    binding.appliedAt = new Date();
    binding.failureReason = null;
    binding.sanitizedManifest = this.manifest(binding.provider, binding.engine, binding.hostReference, binding.port, binding.databaseName, binding.usernameReference, binding.configurationFingerprint, "applied");
    return this.bindings.save(binding);
  }

  async markReady(projectId: string, pipelineRunId: string) {
    const binding = await this.requireRunBinding(projectId, pipelineRunId);
    binding.status = ServiceBindingStatus.READY;
    binding.readyAt = new Date();
    binding.failureReason = null;
    binding.sanitizedManifest = { ...binding.sanitizedManifest, status: "ready", readyAt: binding.readyAt.toISOString() };
    return this.bindings.save(binding);
  }

  async markVerified(projectId: string, pipelineRunId: string) {
    const binding = await this.requireRunBinding(projectId, pipelineRunId);
    binding.status = ServiceBindingStatus.VERIFIED;
    binding.verifiedAt = new Date();
    return this.bindings.save(binding);
  }

  async markFailed(projectId: string, pipelineRunId: string, reason: string) {
    const binding = await this.bindings.findOne({ where: { projectId, pipelineRunId, serviceType: "database" } });
    if (!binding) return null;
    binding.status = ServiceBindingStatus.FAILED;
    binding.failureReason = reason.slice(0, 500);
    return this.bindings.save(binding);
  }

  async resolveEffectiveDeploymentConfiguration(
    projectId: string,
    pipelineRunId: string | null,
    environmentOrRequireReady: string | boolean = "production",
    resolveOptions: ResolveOptions = {},
  ): Promise<EffectiveDeploymentConfiguration> {
    const environment = typeof environmentOrRequireReady === "string" ? environmentOrRequireReady : "production";
    const options: ResolveOptions = typeof environmentOrRequireReady === "boolean"
      ? { requireReady: environmentOrRequireReady, throwOnBlockers: true, useSnapshot: true }
      : { throwOnBlockers: true, useSnapshot: true, ...resolveOptions };
    const result = await this.buildEffectiveConfiguration(projectId, pipelineRunId, environment, options);
    if (options.throwOnBlockers !== false && result.blockers.length) throw new BadRequestException(result.blockers.join(" "));
    return result;
  }

  async createRunConfigurationSnapshot(projectId: string, pipelineRunId: string, environment = "production") {
    const existing = await this.snapshots.findOne({ where: { projectId, pipelineRunId } });
    if (existing) return existing;
    await this.ensureIntent(projectId, pipelineRunId);
    const effective = await this.buildEffectiveConfiguration(projectId, pipelineRunId, environment, { requireReady: false, useSnapshot: false });
    if (effective.blockers.length) throw new BadRequestException(effective.blockers.join(" "));
    const encryptedSecretPayload = Object.keys(effective.projectSecretValues).length
      ? this.crypto.encrypt(JSON.stringify(effective.projectSecretValues))
      : null;
    const snapshot = await this.snapshots.save(this.snapshots.create({
      projectId,
      pipelineRunId,
      environment,
      configurationFingerprint: effective.configurationFingerprint,
      plainValues: effective.plainEnvironmentValues,
      buildValues: effective.buildArguments,
      secretReferences: effective.secretReferences,
      bindingRevisions: effective.serviceBindingRevisions,
      ownershipManifest: effective.ownership,
      sourceRevisions: Object.fromEntries(Object.entries(effective.ownership).map(([key, value]) => [key, value.sourceRevision])),
      unresolvedRequired: effective.unresolvedRequiredValues,
      prohibitedOverrides: effective.prohibitedOverrides,
      duplicateConflicts: effective.duplicateOwnershipConflicts,
      validationBlockers: effective.blockers,
      encryptedSecretPayload,
      sanitizedManifest: effective.sanitizedDeveloperManifest,
    }));
    const run = await this.runs.findOne({ where: { id: pipelineRunId, projectId } });
    if (!run) throw new BadRequestException("Pipeline run is unavailable for configuration snapshot assignment.");
    run.configurationSnapshotId = snapshot.id;
    await this.runs.save(run);
    return snapshot;
  }

  async assertRunConfigurationCurrent(projectId: string, pipelineRunId: string) {
    const snapshot = await this.snapshots.findOne({ where: { projectId, pipelineRunId } });
    if (!snapshot) throw new BadRequestException("The pipeline run has no immutable configuration snapshot.");
    const current = await this.buildEffectiveConfiguration(projectId, pipelineRunId, snapshot.environment, { requireReady: false, useSnapshot: false });
    if (current.configurationFingerprint !== snapshot.configurationFingerprint) {
      throw new BadRequestException("Project configuration changed after this pipeline run was queued. Start a selective resume with a new configuration snapshot.");
    }
    return snapshot;
  }

  async getSanitizedConfiguration(projectId: string, pipelineRunId: string | null, environment = "production") {
    const effective = await this.resolveEffectiveDeploymentConfiguration(projectId, pipelineRunId, environment, { throwOnBlockers: false });
    return {
      configurationFingerprint: effective.configurationFingerprint,
      environment: effective.environment,
      ownership: effective.ownership,
      bindingRevisions: effective.serviceBindingRevisions,
      unresolvedRequiredValues: effective.unresolvedRequiredValues,
      prohibitedOverrides: effective.prohibitedOverrides,
      duplicateOwnershipConflicts: effective.duplicateOwnershipConflicts,
      blockers: effective.blockers,
      manifest: effective.sanitizedDeveloperManifest,
    };
  }

  private async buildEffectiveConfiguration(projectId: string, pipelineRunId: string | null, environment: string, options: ResolveOptions): Promise<EffectiveDeploymentConfiguration> {
    const snapshot = pipelineRunId && options.useSnapshot !== false
      ? await this.snapshots.createQueryBuilder("snapshot").addSelect("snapshot.encryptedSecretPayload").where("snapshot.projectId = :projectId", { projectId }).andWhere("snapshot.pipelineRunId = :pipelineRunId", { pipelineRunId }).getOne()
      : null;
    const [contract, profile, storedBinding, tier, rows, storage] = await Promise.all([
      this.contracts.findOne({ where: { projectId } }),
      this.profiles.findOne({ where: { projectId } }),
      pipelineRunId
        ? this.bindings.findOne({ where: { projectId, pipelineRunId, serviceType: "database" } })
        : this.bindings.findOne({ where: { projectId, serviceType: "database" }, order: { createdAt: "DESC" } }),
      this.tiers.findOne({ where: { projectId } }),
      this.variables.createQueryBuilder("variable").addSelect("variable.value").where("variable.projectId = :projectId", { projectId }).andWhere("variable.isActive = true").orderBy("variable.key", "ASC").getMany(),
      this.storage.findOne({ where: { projectId, environmentName: environment }, order: { updatedAt: "DESC" } }),
    ]);
    if (!contract) throw new BadRequestException("A deployment contract is required.");
    const binding = pipelineRunId || !tier?.provider || tier.provider === DatabaseTierProvider.NONE
      ? storedBinding
      : ({
          id: `intent:${tier.id}:${tier.updatedAt?.toISOString() || "current"}`,
          projectId,
          pipelineRunId: "preflight",
          serviceType: "database",
          provider: tier.provider,
          engine: tier.engine || contract.databaseEngine || "postgres",
          status: ServiceBindingStatus.PENDING,
          databaseName: tier.databaseName,
          hostReference: tier.provider === DatabaseTierProvider.MANAGED ? tier.internalHost || `db.project-${projectId}.deployguard.local` : tier.externalHost,
          port: tier.provider === DatabaseTierProvider.MANAGED ? (tier.engine === "mysql" ? 3306 : 5432) : tier.externalPort,
          usernameReference: tier.databaseUser,
          passwordSecretReference: tier.provider === DatabaseTierProvider.MANAGED ? "terraform://database/password" : null,
          databaseUrlSecretReference: tier.provider === DatabaseTierProvider.MANAGED ? "terraform://database/url" : null,
          configurationFingerprint: this.fingerprint([tier.provider, tier.engine, tier.internalHost, tier.externalHost, tier.externalPort, tier.externalTlsRequired, tier.databaseName, tier.databaseUser, tier.updatedAt]),
        } as ProjectServiceBinding);

    if (snapshot) {
      const snapshotSecrets = snapshot.encryptedSecretPayload ? JSON.parse(this.crypto.decrypt(snapshot.encryptedSecretPayload)) as Record<string, string> : {};
      const blockers = [...snapshot.validationBlockers];
      if (options.requireReady && binding?.provider === "managed" && ![ServiceBindingStatus.READY, ServiceBindingStatus.VERIFIED].includes(binding.status)) {
        blockers.push(`Managed database binding is ${binding.status}; application deployment requires ready.`);
      }
      const secretReferences = { ...snapshot.secretReferences };
      const snapshotService = (binding?.engine || contract.databaseEngine || "postgres") as ManagedServiceKind;
      if (binding?.passwordSecretReference && !binding.passwordSecretReference.startsWith("terraform://")) {
        for (const key of aliasesFor(snapshotService, "password")) {
          if (snapshot.ownershipManifest[key]) secretReferences[key] = binding.passwordSecretReference;
        }
      }
      if (binding?.databaseUrlSecretReference && !binding.databaseUrlSecretReference.startsWith("terraform://")) {
        for (const key of aliasesFor(snapshotService, "url")) {
          if (snapshot.ownershipManifest[key]) secretReferences[key] = binding.databaseUrlSecretReference;
        }
      }
      return {
        binding,
        environment: snapshot.environment,
        plainEnvironmentValues: { ...snapshot.plainValues },
        buildArguments: { ...snapshot.buildValues },
        runtimeVariables: { ...snapshot.plainValues },
        projectSecretValues: snapshotSecrets,
        secretReferences,
        ownership: snapshot.ownershipManifest as EffectiveDeploymentConfiguration["ownership"],
        serviceBindingRevisions: snapshot.bindingRevisions,
        unresolvedRequiredValues: snapshot.unresolvedRequired,
        prohibitedOverrides: snapshot.prohibitedOverrides,
        duplicateOwnershipConflicts: snapshot.duplicateConflicts,
        configurationFingerprint: snapshot.configurationFingerprint,
        blockers,
        sanitizedDeveloperManifest: snapshot.sanitizedManifest,
      };
    }

    const runtimeVariables: Record<string, string> = {};
    const buildArguments: Record<string, string> = {};
    const projectSecretValues: Record<string, string> = {};
    const secretReferences: Record<string, string> = {};
    const ownership: EffectiveDeploymentConfiguration["ownership"] = {};
    const prohibitedOverrides: string[] = [];
    const duplicateOwnershipConflicts: string[] = [];
    const blockers: string[] = [];
    const evidence = Array.isArray((profile?.rawProfile as Record<string, unknown> | null)?.environmentVariables)
      ? ((profile!.rawProfile as Record<string, unknown>).environmentVariables as Array<Record<string, unknown>>)
      : [];
    const service = (binding?.engine || contract.databaseEngine || "postgres") as ManagedServiceKind;
    const managed = binding?.provider === "managed";
    const expectedKeys = new Set([
      ...contract.requiredEnvVars,
      ...contract.optionalEnvVars,
      ...contract.runtimeEnvVars,
      ...contract.buildTimeEnvVars,
      ...evidence.map((item) => normalizeConfigurationKey(String(item.key || ""))).filter(Boolean),
    ]);
    const putOwnership = (key: string, entry: EffectiveDeploymentConfiguration["ownership"][string]) => {
      if (ownership[key] && (ownership[key].owner !== entry.owner || ownership[key].sourceRevision !== entry.sourceRevision)) {
        duplicateOwnershipConflicts.push(`${key} has competing owners ${ownership[key].owner} and ${entry.owner}.`);
      }
      ownership[key] = entry;
    };
    for (const row of rows) {
      const key = normalizeConfigurationKey(row.normalizedKey || row.key);
      const alias = serviceAlias(key, service);
      const storageAlias = serviceAlias(key, "storage");
      if (isPlatformProjectProhibited(key) && !expectedKeys.has(key)) {
        prohibitedOverrides.push(`${key} is platform configuration and cannot be set per project.`);
        continue;
      }
      if (managed && alias) {
        prohibitedOverrides.push(`${key} is owned by the attached managed ${service} service.`);
        continue;
      }
      if (contract.persistentStorageRequired && storageAlias) {
        prohibitedOverrides.push(`${key} is owned by the attached managed storage service.`);
        continue;
      }
      const value = this.crypto.decrypt(row.value);
      const secret = row.isSecret || isSecretConfigurationKey(key);
      if (secret) {
        if (["runtime", "both"].includes(row.scope)) {
          projectSecretValues[key] = value;
          secretReferences[key] = `project-env://${row.id}@${row.updatedAt?.toISOString() || "legacy"}`;
        }
      } else {
        if (["runtime", "both"].includes(row.scope)) runtimeVariables[key] = value;
        if (["build", "both"].includes(row.scope)) buildArguments[key] = value;
      }
      putOwnership(key, {
        owner: binding?.provider === "external" && alias ? "external_service" : row.isRequired ? "user_required" : "user_optional",
        source: row.source || row.detectedSource || "project variable",
        sourceRevision: row.configurationFingerprint || row.updatedAt?.toISOString() || row.id,
        required: row.isRequired,
        secret,
        protected: Boolean(row.protected || alias),
        serviceBindingId: row.serviceBindingId || (alias ? binding?.id || null : null),
        detectedReference: row.detectedReference || row.detectedSource || null,
      });
    }

    for (const item of evidence) {
      const key = normalizeConfigurationKey(String(item.key || ""));
      const value = typeof item.detectedDefault === "string" ? item.detectedDefault.trim() : "";
      if (!key || !value || item.secret === true || isSecretConfigurationKey(key) || runtimeVariables[key] || buildArguments[key] || projectSecretValues[key]) continue;
      if (["HOST", "PORT"].includes(key) && contract.runtimeType === "server") continue;
      if (managed && serviceAlias(key, service)) continue;
      if (LOCAL_HOST.test(value) && serviceAlias(key)) continue;
      if (item.phase === "build") buildArguments[key] = value;
      else runtimeVariables[key] = value;
      putOwnership(key, {
        owner: "repository_default", source: "repository scan", sourceRevision: profile?.inputFingerprint || contract.contractHash,
        required: item.required === true, secret: false, protected: false, serviceBindingId: null,
        detectedReference: Array.isArray(item.sources) ? item.sources.map(String).join(", ") : null,
      });
    }

    if (contract.runtimeType === "server") {
      runtimeVariables.HOST = "0.0.0.0";
      runtimeVariables.PORT = String(contract.ecsPlan.containerPort);
      for (const key of ["HOST", "PORT"]) putOwnership(key, {
        owner: "platform", source: "deployment contract", sourceRevision: contract.contractHash,
        required: true, secret: false, protected: true, serviceBindingId: null, detectedReference: contract.detectionProfileId,
      });
    }

    if (contract.persistentStorageRequired) {
      const storageRevision = storage?.updatedAt?.toISOString() || contract.contractHash;
      const selected = [...new Set([aliasesFor("storage", "path")[0], ...aliasesFor("storage", "path").filter((key) => expectedKeys.has(key))])].filter(Boolean);
      for (const key of selected) {
        runtimeVariables[key] = "/app/data";
        putOwnership(key, {
          owner: "managed_service",
          source: "persistent storage binding",
          sourceRevision: storageRevision,
          required: true,
          secret: false,
          protected: true,
          serviceBindingId: storage?.id || null,
          detectedReference: contract.detectionProfileId,
        });
      }
    }

    if (contract.databaseRequired) {
      if (!binding) blockers.push(pipelineRunId ? "The pipeline run has no immutable database binding." : "A database service binding must be selected before deployment.");
      else {
        const owner: ConfigurationOwner = binding.provider === "managed" ? "managed_service" : "external_service";
        const properties: Record<string, string | null> = {
          host: binding.hostReference,
          port: String(binding.port),
          database: binding.databaseName,
          username: binding.usernameReference || null,
        };
        for (const [property, value] of Object.entries(properties)) {
          const aliases = aliasesFor(service, property as never);
          const selected = [...new Set([aliases[0], ...aliases.filter((key) => expectedKeys.has(key))])].filter(Boolean);
          for (const key of selected) {
            if (!value) blockers.push(`${key} is missing from the database binding.`);
            else runtimeVariables[key] = value;
            putOwnership(key, { owner, source: `${service} service binding`, sourceRevision: binding.id, required: true, secret: false, protected: true, serviceBindingId: binding.id, detectedReference: null });
          }
        }
        const secretProperties = [
          ["password", binding.passwordSecretReference],
          ["url", binding.databaseUrlSecretReference],
        ] as const;
        for (const [property, reference] of secretProperties) {
          const aliases = aliasesFor(service, property);
          const selected = [...new Set([aliases[0], ...aliases.filter((key) => expectedKeys.has(key))])].filter(Boolean);
          const externalValueKey = binding.provider === "external"
            ? aliases.find((key) => projectSecretValues[key] !== undefined || secretReferences[key] !== undefined)
            : undefined;
          for (const key of selected) {
            if (reference) secretReferences[key] = reference;
            else if (externalValueKey && projectSecretValues[externalValueKey] !== undefined) {
              projectSecretValues[key] = projectSecretValues[externalValueKey];
              secretReferences[key] = secretReferences[externalValueKey];
            }
            else if (binding.provider === "managed") blockers.push(`${key} secret reference is missing from the managed binding.`);
            if (!(binding.provider === "external" && ownership[key]?.owner === "external_service")) {
              putOwnership(key, { owner, source: `${service} service binding`, sourceRevision: binding.id, required: true, secret: true, protected: true, serviceBindingId: binding.id, detectedReference: null });
            } else {
              ownership[key] = { ...ownership[key], protected: true, serviceBindingId: binding.id };
            }
          }
        }
        if (LOCAL_HOST.test(binding.hostReference) || /(?:localhost|127\.0\.0\.1)/i.test(binding.databaseUrlSecretReference || "")) blockers.push("Managed database binding resolved to a local address.");
        if (options.requireReady && binding.provider === "managed" && ![ServiceBindingStatus.READY, ServiceBindingStatus.VERIFIED].includes(binding.status)) blockers.push(`Managed database binding is ${binding.status}; application deployment requires ready.`);
      }
    }

    const resolvedKeys = new Set([...Object.keys(runtimeVariables), ...Object.keys(buildArguments), ...Object.keys(projectSecretValues), ...Object.keys(secretReferences)]);
    const unresolvedRequiredValues = contract.requiredEnvVars.filter((key) => {
      const normalized = normalizeConfigurationKey(key);
      if (resolvedKeys.has(normalized)) return false;
      const alias = serviceAlias(normalized, service);
      return !alias || !alias.aliases.some((candidate) => resolvedKeys.has(candidate));
    });
    if (unresolvedRequiredValues.length) blockers.push(`Required application configuration is unresolved: ${unresolvedRequiredValues.join(", ")}.`);
    blockers.push(...prohibitedOverrides, ...duplicateOwnershipConflicts);
    const sourceRevisions = Object.fromEntries(Object.entries(ownership).map(([key, value]) => [key, value.sourceRevision]));
    const configurationFingerprint = this.fingerprint({
      projectId, environment, contractHash: contract.contractHash, binding: binding ? [binding.id, binding.configurationFingerprint] : null,
      plainValues: runtimeVariables,
      buildValues: buildArguments,
      secretSources: Object.fromEntries(Object.entries(secretReferences).map(([key, value]) => [
        key,
        ownership[key]?.owner === "managed_service" ? binding?.configurationFingerprint || binding?.id : value.startsWith("project-env://") ? value : this.fingerprint(value),
      ])),
      sourceRevisions,
    });
    const serviceBindingRevisions = [
      ...(binding ? [{ id: binding.id, type: binding.serviceType, provider: binding.provider, engine: binding.engine, status: binding.status, configurationFingerprint: binding.configurationFingerprint }] : []),
      ...(contract.persistentStorageRequired ? [{
        id: storage?.id || `storage-contract:${projectId}`,
        type: "storage",
        provider: "managed",
        status: storage?.status || "pending",
        configurationFingerprint: this.fingerprint([storage?.id, storage?.updatedAt, storage?.ecsMountConfig, "/app/data"]),
      }] : []),
    ];
    const sanitizedDeveloperManifest = {
      environment,
      keys: Object.keys(ownership).sort().map((key) => ({ key, ...ownership[key], configured: true, value: ownership[key].secret ? "••••••••" : runtimeVariables[key] ?? buildArguments[key] ?? "managed reference" })),
      bindingRevisions: serviceBindingRevisions,
      unresolvedRequiredValues,
      prohibitedOverrides,
      duplicateOwnershipConflicts,
      configurationFingerprint,
    };
    return {
      binding, environment, plainEnvironmentValues: runtimeVariables, buildArguments, runtimeVariables, projectSecretValues, secretReferences, ownership,
      serviceBindingRevisions, unresolvedRequiredValues, prohibitedOverrides, duplicateOwnershipConflicts, configurationFingerprint,
      blockers: [...new Set(blockers)], sanitizedDeveloperManifest,
    };
  }

  async verifyManagedDatabaseReady(projectId: string, pipelineRunId: string) {
    const binding = await this.requireRunBinding(projectId, pipelineRunId);
    if (binding.provider !== "managed") return this.markReady(projectId, pipelineRunId);
    if (binding.status !== ServiceBindingStatus.APPLIED || !binding.ecsDatabaseServiceArn || !binding.cloudMapServiceArn) {
      throw new BadRequestException("Managed database outputs have not been applied to this run binding.");
    }
    const serviceParts = binding.ecsDatabaseServiceArn.split("/");
    const serviceName = serviceParts.at(-1)!;
    const clusterName = serviceParts.at(-2);
    if (!clusterName || !serviceName) throw new BadRequestException("Managed database ECS service reference is invalid.");
    const client = new ECSClient({ region: this.config.get<string>("AWS_REGION", "us-east-1") });
    const timeoutAt = Date.now() + Number(this.config.get<string>("DATABASE_READINESS_TIMEOUT_SECONDS", "180")) * 1000;
    let lastReason = "Managed PostgreSQL service has not reached readiness.";
    while (Date.now() < timeoutAt) {
      const service = (await client.send(new DescribeServicesCommand({ cluster: clusterName, services: [serviceName] }))).services?.[0];
      if (!service) throw new BadRequestException("Managed database ECS service was not found after Terraform apply.");
      const primary = service.deployments?.find((item) => item.status === "PRIMARY");
      if (primary?.rolloutState === "FAILED") {
        lastReason = primary.rolloutStateReason || "Managed database ECS deployment failed.";
        break;
      }
      const taskArns = (await client.send(new ListTasksCommand({ cluster: clusterName, serviceName, desiredStatus: "RUNNING" }))).taskArns || [];
      const tasks = taskArns.length ? (await client.send(new DescribeTasksCommand({ cluster: clusterName, tasks: taskArns }))).tasks || [] : [];
      const taskReady = tasks.some((task) => task.lastStatus === "RUNNING" && task.healthStatus === "HEALTHY");
      const cloudMapAttached = Boolean(service.serviceRegistries?.some((item) => item.registryArn === binding.cloudMapServiceArn));
      if ((service.desiredCount || 0) === 1 && (service.runningCount || 0) === 1 && taskReady && cloudMapAttached) {
        return this.markReady(projectId, pipelineRunId);
      }
      lastReason = `Managed database readiness pending: desired ${service.desiredCount || 0}, running ${service.runningCount || 0}, Cloud Map ${cloudMapAttached ? "attached" : "missing"}.`;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    await this.markFailed(projectId, pipelineRunId, lastReason);
    throw new BadRequestException(lastReason);
  }

  async validateApplicationTaskDefinition(projectId: string, pipelineRunId: string, taskDefinitionArn: string) {
    const effective = await this.resolveEffectiveDeploymentConfiguration(projectId, pipelineRunId, true);
    const response = await new ECSClient({ region: this.config.get<string>("AWS_REGION", "us-east-1") }).send(
      new DescribeTaskDefinitionCommand({ taskDefinition: taskDefinitionArn })
    );
    const container = response.taskDefinition?.containerDefinitions?.find((item) => item.name === "app") || response.taskDefinition?.containerDefinitions?.[0];
    const environment = Object.fromEntries((container?.environment || []).map((item) => [String(item.name), String(item.value || "")]));
    const secrets = Object.fromEntries((container?.secrets || []).map((item) => [String(item.name), String(item.valueFrom || "")]));
    const blockers: string[] = [];
    for (const key of ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER"]) {
      if (environment[key] !== effective.runtimeVariables[key]) blockers.push(`${key} does not match the immutable database binding.`);
    }
    if (LOCAL_HOST.test(environment.DB_HOST || "")) blockers.push("Application task definition contains a localhost database host.");
    for (const key of ["DB_PASSWORD", "DATABASE_URL"]) {
      if (effective.secretReferences[key] && secrets[key] !== effective.secretReferences[key]) blockers.push(`${key} does not use the binding secret reference.`);
    }
    if (blockers.length) throw new BadRequestException(blockers.join(" "));
    return { passed: true, bindingId: effective.binding?.id || null, taskDefinitionArn, environmentOwners: effective.ownership };
  }

  async activateApplicationService(projectId: string, pipelineRunId: string, outputs: Record<string, unknown>) {
    await this.resolveEffectiveDeploymentConfiguration(projectId, pipelineRunId, true);
    const cluster = this.string(outputs.ecs_cluster_arn) || this.string(outputs.ecs_cluster_name);
    const service = this.string(outputs.ecs_service_arn) || this.string(outputs.ecs_service_name);
    const taskDefinition = this.string(outputs.ecs_task_definition_arn);
    if (!cluster || !service || !taskDefinition) throw new BadRequestException("Application ECS activation outputs are incomplete.");
    await new ECSClient({ region: this.config.get<string>("AWS_REGION", "us-east-1") }).send(new UpdateServiceCommand({
      cluster,
      service,
      taskDefinition,
      desiredCount: Number(this.config.get<string>("DEPLOYGUARD_ECS_MIN_TASKS", "1")),
      forceNewDeployment: true,
    }));
    return { taskDefinitionArn: taskDefinition, bindingId: (await this.requireRunBinding(projectId, pipelineRunId)).id };
  }

  async requireRunBinding(projectId: string, pipelineRunId: string) {
    const binding = await this.bindings.findOne({ where: { projectId, pipelineRunId, serviceType: "database" } });
    if (!binding) throw new BadRequestException("The pipeline run has no immutable database binding.");
    return binding;
  }

  private fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
  private string(value: unknown) { return value === undefined || value === null || value === "" ? null : String(value); }
  private manifest(provider: string, engine: string, host: string, port: number, name: string, username: string | null, fingerprint: string, status: string) {
    return { provider, engine, host, port, databaseName: name, usernameConfigured: Boolean(username), secretValues: "not_persisted", fingerprint, status };
  }
}
