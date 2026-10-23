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

const MANAGED_KEYS = new Set(["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DATABASE_URL"]);
const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|host\.docker\.internal)$/i;

export type EffectiveDeploymentConfiguration = {
  binding: ProjectServiceBinding | null;
  runtimeVariables: Record<string, string>;
  projectSecretValues: Record<string, string>;
  secretReferences: Record<string, string>;
  ownership: Record<string, { owner: string; sourceRevision: string }>;
  blockers: string[];
};

@Injectable()
export class DatabaseServiceBindingService {
  constructor(
    @InjectRepository(ProjectServiceBinding) private readonly bindings: Repository<ProjectServiceBinding>,
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectDeploymentContract) private readonly contracts: Repository<ProjectDeploymentContract>,
    @InjectRepository(ProjectDatabaseTier) private readonly tiers: Repository<ProjectDatabaseTier>,
    @InjectRepository(ProjectEnvironmentVariable) private readonly variables: Repository<ProjectEnvironmentVariable>,
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

  async resolveEffectiveDeploymentConfiguration(projectId: string, pipelineRunId: string, requireReady = false): Promise<EffectiveDeploymentConfiguration> {
    const [contract, binding, rows] = await Promise.all([
      this.contracts.findOne({ where: { projectId } }),
      this.bindings.findOne({ where: { projectId, pipelineRunId, serviceType: "database" } }),
      this.variables.createQueryBuilder("variable").addSelect("variable.value").where("variable.projectId = :projectId", { projectId }).andWhere("variable.isActive = true").orderBy("variable.key", "ASC").getMany(),
    ]);
    if (!contract) throw new BadRequestException("A deployment contract is required.");
    const runtimeVariables: Record<string, string> = {};
    const projectSecretValues: Record<string, string> = {};
    const secretReferences: Record<string, string> = {};
    const ownership: EffectiveDeploymentConfiguration["ownership"] = {};
    const blockers: string[] = [];
    for (const row of rows) {
      if (!["runtime", "both"].includes(row.scope)) continue;
      if (binding?.provider === "managed" && MANAGED_KEYS.has(row.key)) continue;
      const value = this.crypto.decrypt(row.value);
      if (row.isSecret) projectSecretValues[row.key] = value;
      else runtimeVariables[row.key] = value;
      ownership[row.key] = { owner: row.owner || "user_supplied", sourceRevision: row.updatedAt?.toISOString() || row.id };
    }
    if (contract.runtimeType === "server") {
      runtimeVariables.HOST = "0.0.0.0";
      runtimeVariables.PORT = String(contract.ecsPlan.containerPort);
      ownership.HOST = ownership.PORT = { owner: "platform_runtime", sourceRevision: contract.contractHash };
    }
    if (contract.databaseRequired) {
      if (!binding) blockers.push("The pipeline run has no immutable database binding.");
      else {
        const bindingOwner = binding.provider === "managed" ? "platform_service_binding" : "external_service_binding";
        const values = {
          DB_HOST: binding.hostReference,
          DB_PORT: String(binding.port),
          DB_NAME: binding.databaseName,
          DB_USER: binding.usernameReference || "",
        };
        for (const [key, value] of Object.entries(values)) {
          if (!value) blockers.push(`${key} is missing from the database binding.`);
          runtimeVariables[key] = value;
          ownership[key] = { owner: bindingOwner, sourceRevision: binding.id };
        }
        if (binding.passwordSecretReference) secretReferences.DB_PASSWORD = binding.passwordSecretReference;
        if (binding.databaseUrlSecretReference) secretReferences.DATABASE_URL = binding.databaseUrlSecretReference;
        ownership.DB_PASSWORD = ownership.DATABASE_URL = { owner: bindingOwner, sourceRevision: binding.id };
        if (LOCAL_HOST.test(binding.hostReference) || /(?:localhost|127\.0\.0\.1)/i.test(binding.databaseUrlSecretReference || "")) {
          blockers.push("Managed database binding resolved to a local address.");
        }
        if (requireReady && ![ServiceBindingStatus.READY, ServiceBindingStatus.VERIFIED].includes(binding.status)) {
          blockers.push(`Managed database binding is ${binding.status}; application deployment requires ready.`);
        }
      }
    }
    if (blockers.length) throw new BadRequestException(blockers.join(" "));
    return { binding, runtimeVariables, projectSecretValues, secretReferences, ownership, blockers };
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
