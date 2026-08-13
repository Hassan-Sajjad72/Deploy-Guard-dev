import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectPersistentStorage } from "../../storage/project-persistent-storage.entity";
import { ProjectDatabaseTier } from "../project-database-tier.entity";
import { ProjectDeploymentContract } from "../project-deployment-contract.entity";
import { ProjectEnvironmentVariable } from "../project-environment-variable.entity";
import { ProjectPipelineRun } from "../project-pipeline-run.entity";
import { ProjectServiceBinding } from "../project-service-binding.entity";
import { ProjectStageCheckpoint } from "./project-stage-checkpoint.entity";
import { RecoveryStage } from "./stage-selective-resume.types";
import { DatabaseServiceBindingService } from "../../infrastructure/database-service-binding.service";

export type CheckpointFingerprintSet = Record<RecoveryStage, string>;

@Injectable()
export class StageCheckpointService {
  constructor(
    @InjectRepository(ProjectStageCheckpoint) private readonly checkpoints: Repository<ProjectStageCheckpoint>,
    @InjectRepository(ProjectDeploymentContract) private readonly contracts: Repository<ProjectDeploymentContract>,
    @InjectRepository(ProjectEnvironmentVariable) private readonly variables: Repository<ProjectEnvironmentVariable>,
    @InjectRepository(ProjectDatabaseTier) private readonly databases: Repository<ProjectDatabaseTier>,
    @InjectRepository(ProjectServiceBinding) private readonly bindings: Repository<ProjectServiceBinding>,
    @InjectRepository(ProjectPersistentStorage) private readonly storage: Repository<ProjectPersistentStorage>,
    private readonly config: ConfigService,
    private readonly effectiveConfiguration: DatabaseServiceBindingService,
  ) {}

  async currentFingerprints(projectId: string, run: ProjectPipelineRun): Promise<CheckpointFingerprintSet> {
    const [contract, variables, database, binding, storage, effective] = await Promise.all([
      this.contracts.findOne({ where: { projectId } }),
      this.variables.createQueryBuilder("variable").where("variable.projectId = :projectId", { projectId }).andWhere("variable.isActive = true").orderBy("variable.key", "ASC").getMany(),
      this.databases.findOne({ where: { projectId } }),
      this.bindings.findOne({ where: { projectId, pipelineRunId: run.id, serviceType: "database" } }),
      this.storage.findOne({ where: { projectId }, order: { updatedAt: "DESC" } }),
      this.effectiveConfiguration.resolveEffectiveDeploymentConfiguration(projectId, null, "production", { throwOnBlockers: false, requireReady: false, useSnapshot: false }),
    ]);
    if (!contract) throw new Error("A deployment contract is required before creating stage checkpoints.");
    const source = this.hash([contract.detectionSourceCommit, contract.appRoot, contract.repositoryFullName, contract.branch]);
    const buildVariables = variables.filter((item) => ["build", "both"].includes(item.scope)).map((item) => [item.key, item.scope, item.configurationFingerprint || item.updatedAt]);
    const runtimeConfiguration = effective.configurationFingerprint;
    const build = this.hash([source, contract.dependencyManifest, contract.lockfile, contract.installCommand, contract.buildCommand, contract.startCommand, contract.dockerStrategy, contract.dockerTemplate, contract.generatedDockerfile, buildVariables]);
    const image = this.hash([build, run.imageTag]);
    const registryImage = this.hash([image, run.ecrImageUri]);
    const securityPolicy = this.hash([
      this.config.get("TRIVY_SCAN_ENABLED"),
      this.config.get("SECURITY_GATE_MODE"),
      this.config.get("SECURITY_BYPASS_ENABLED"),
      this.config.get("SECURITY_BLOCK_CRITICAL"),
      this.config.get("SECURITY_BLOCK_HIGH"),
      this.config.get("SECURITY_BLOCK_BASE_IMAGE_CRITICAL"),
    ]);
    const security = this.hash([image, securityPolicy]);
    const desiredDatabase = database ? [database.provider, database.engine, database.externalHost, database.externalPort, database.externalTlsRequired, database.internalHost, database.databaseName, database.databaseUser, database.persistenceEnabled] : [contract.databaseRequired, contract.databaseEngine];
    const databaseFingerprint = binding
      ? this.hash([desiredDatabase, binding.id, binding.configurationFingerprint, binding.provider, binding.engine, binding.hostReference, binding.port, binding.databaseName, binding.usernameReference, binding.passwordSecretReference, binding.databaseUrlSecretReference, binding.terraformOutputRevision])
      : this.hash(database ? [database.provider, database.engine, database.externalHost, database.externalPort, database.internalHost, database.databaseName, database.databaseUser, database.persistenceEnabled, database.credentialsSecretArn, database.databaseUrlSecretArn] : [contract.databaseRequired, contract.databaseEngine]);
    const storageFingerprint = this.hash(storage ? [storage.enabled, storage.rootDirectory, storage.efsFileSystemId, storage.efsAccessPointId, storage.ecsMountConfig, storage.encrypted] : [contract.persistentStorageRequired]);
    const runtime = this.hash([image, runtimeConfiguration, contract.startCommand, contract.port, contract.bindHost, contract.ecsPlan?.environmentMappings, contract.ecsPlan?.secretMappings, databaseFingerprint, storageFingerprint]);
    const health = this.hash([runtime, contract.healthPath, contract.ecsPlan?.healthCheckPath, contract.ecsPlan?.containerPort, contract.ecsPlan?.targetGroupPort]);
    const infrastructure = this.hash([contract.ecsPlan?.cpu, contract.ecsPlan?.memory, databaseFingerprint, storageFingerprint, health]);
    const cleanup = this.hash([projectId, "cleanup-inventory"]);
    return {
      repo_clone: source,
      stack_detection: source,
      preflight: this.hash([source, contract.contractHash]),
      dockerfile_generation: build,
      docker_build: build,
      security_scan: security,
      ecr_push: registryImage,
      terraform_plan: infrastructure,
      terraform_apply: infrastructure,
      database_tier_setup: databaseFingerprint,
      ecs_task_definition_update: runtime,
      ecs_service_deploy: runtime,
      health_check: health,
      stable_release: health,
      cleanup_inventory: cleanup,
      cleanup_safe_leftovers: cleanup,
    };
  }

  async recordPassed(run: ProjectPipelineRun, stage: RecoveryStage, artifactReference: Record<string, unknown> | null = null, terraformMetadata: Record<string, unknown> | null = null) {
    const fingerprints = await this.currentFingerprints(run.projectId, run);
    const existing = await this.checkpoints.findOne({ where: { pipelineRunId: run.id, stage } });
    const row = this.checkpoints.create({
      ...(existing || {}), projectId: run.projectId, pipelineRunId: run.id, stage,
      fingerprint: fingerprints[stage], status: "passed", sourceCheckpointId: null,
      artifactReference: this.safeArtifact(artifactReference), imageTag: run.imageTag || null,
      imageDigest: typeof artifactReference?.imageDigest === "string"
        ? artifactReference.imageDigest
        : this.imageDigest(run.ecrImageUri),
      terraformMetadata: this.safeArtifact(terraformMetadata),
      metadata: { checkpointVersion: 1 },
    });
    return this.checkpoints.save(row);
  }

  async recordReused(run: ProjectPipelineRun, source: ProjectStageCheckpoint) {
    return this.checkpoints.save(this.checkpoints.create({
      projectId: run.projectId, pipelineRunId: run.id, stage: source.stage,
      fingerprint: source.fingerprint, status: "reused", sourceCheckpointId: source.id,
      artifactReference: source.artifactReference, imageTag: source.imageTag,
      imageDigest: source.imageDigest, terraformMetadata: source.terraformMetadata,
      metadata: { checkpointVersion: 1, reusedFromRunId: source.pipelineRunId },
    }));
  }

  async latestPassedByStage(projectId: string) {
    const rows = await this.checkpoints.find({ where: { projectId }, order: { createdAt: "DESC" } });
    const result = new Map<RecoveryStage, ProjectStageCheckpoint>();
    for (const row of rows) if (["passed", "reused"].includes(row.status) && !result.has(row.stage as RecoveryStage)) result.set(row.stage as RecoveryStage, row);
    return result;
  }

  private safeArtifact(value: Record<string, unknown> | null) {
    if (!value) return null;
    const allowed = new Set(["imageName", "imageTag", "imageDigest", "ecrImageUri", "deploymentId", "infrastructureEnvironmentId", "terraformStateKey", "terraformPlanSummary", "taskDefinitionArn", "healthCheckPath", "bindingId", "bindingFingerprint"]);
    return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)));
  }
  private imageDigest(uri: string | null) { return uri?.match(/@(sha256:[a-f0-9]{64})$/i)?.[1] || null; }
  private hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
}
