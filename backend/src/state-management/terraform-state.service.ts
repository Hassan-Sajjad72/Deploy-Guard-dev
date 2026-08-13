import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash } from "crypto";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Repository } from "typeorm";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { Project } from "../projects/project.entity";
import { AwsCliService } from "./aws-cli.service";
import { ProjectTerraformState, TerraformStateStatus } from "./project-terraform-state.entity";
import { getStateManagementConfig } from "./state-management.config";

@Injectable()
export class TerraformStateService {
  private readonly logger = new Logger(TerraformStateService.name);
  constructor(
    @InjectRepository(ProjectTerraformState)
    private readonly stateRepository: Repository<ProjectTerraformState>,
    private readonly config: ConfigService,
    private readonly awsCli: AwsCliService
  ) {}

  async ensureStateBucket() {
    const stateConfig = getStateManagementConfig(this.config);
    if (stateConfig.mockMode) return;
    this.assertRemoteStateConfig(stateConfig);

    try {
      await this.awsCli.run(["s3api", "head-bucket", "--bucket", stateConfig.bucket]);
    } catch (error) {
      this.throwStateAccessError(error, stateConfig.bucket);
    }
  }

  async ensureStateBucketVersioning() {
    const stateConfig = getStateManagementConfig(this.config);
    const result = await this.awsCli.run([
      "s3api",
      "get-bucket-versioning",
      "--bucket",
      stateConfig.bucket,
    ]);
    const versioning = this.parseJson(result.stdout);
    if (versioning.Status !== "Enabled") throw new Error("Terraform state bucket versioning is not enabled.");
  }

  async ensureStateBucketEncryption() {
    const stateConfig = getStateManagementConfig(this.config);
    await this.awsCli.run([
      "s3api",
      "get-bucket-encryption",
      "--bucket",
      stateConfig.bucket,
    ]);
  }

  async ensureStateBucketPublicAccessBlock() {
    const stateConfig = getStateManagementConfig(this.config);
    await this.awsCli.run([
      "s3api",
      "get-public-access-block",
      "--bucket",
      stateConfig.bucket,
    ]);
  }

  ensureNativeLockfileConfiguration() {
    const stateConfig = getStateManagementConfig(this.config);
    if (!stateConfig.mockMode && !stateConfig.useLockfile) {
      throw new Error("TERRAFORM_STATE_USE_LOCKFILE=true is required for remote Terraform state locking.");
    }
  }

  buildStateKey(project: Project | { id: string }, environmentName = "dev", generationId?: string | null) {
    const stateConfig = getStateManagementConfig(this.config);
    const prefix = stateConfig.prefix.replace(/^\/+|\/+$/g, "");
    const scope = generationId || "project";
    return `${prefix}/${project.id}/${environmentName}/${scope}/terraform.tfstate`;
  }

  buildLockfileKey(project: Project | { id: string }, environmentName = "dev") {
    return `${this.buildStateKey(project, environmentName)}.tflock`;
  }

  generateTerraformBackendConfig(project: Project | { id: string }, environmentName = "dev") {
    const stateConfig = getStateManagementConfig(this.config);
    if (!stateConfig.mockMode) this.assertRemoteStateConfig(stateConfig);
    const key = this.buildStateKey(project, environmentName);

    const lines = [
      `bucket = "${stateConfig.bucket}"`,
      `key = "${key}"`,
      `region = "${stateConfig.region}"`,
      "encrypt = true",
    ];
    if (stateConfig.useLockfile) lines.push("use_lockfile = true");
    return lines.join("\n");
  }

  async writeBackendConfig(workdir: string, project: Project | { id: string }, environmentName = "dev") {
    const backendConfig = this.generateTerraformBackendConfig(project, environmentName);
    const path = join(workdir, "backend.hcl");
    await writeFile(path, backendConfig, "utf8");
    return path;
  }

  private assertRemoteStateConfig(stateConfig: ReturnType<typeof getStateManagementConfig>) {
    if (!stateConfig.bucket) throw new Error("TERRAFORM_STATE_BUCKET is required for remote Terraform state.");
    if (!stateConfig.region) throw new Error("Terraform state region is not configured.");
  }

  async validateRemoteBackend(project: Project | { id: string }, environmentName = "dev") {
    const stateConfig = getStateManagementConfig(this.config);
    const stateKey = this.buildStateKey(project, environmentName);
    const lockfileKey = this.buildLockfileKey(project, environmentName);
    const mode = stateConfig.mockMode ? "local" as const : "s3" as const;
    this.logger.log(`Terraform state preflight mode=${mode} bucket=${stateConfig.bucket || "mock"} region=${stateConfig.region || "local"} stateKey=${stateKey} lockMode=${stateConfig.useLockfile ? "s3_lockfile" : "none"}`);
    if (stateConfig.mockMode) return { mode, stateKey, lockfileKey, lockfile: { exists: false, stale: false, key: lockfileKey, lastModified: null } };
    this.assertRemoteStateConfig(stateConfig);
    this.ensureNativeLockfileConfiguration();
    await this.ensureStateBucket();
    try {
      await this.ensureStateBucketVersioning();
      await this.ensureStateBucketEncryption();
      await this.ensureStateBucketPublicAccessBlock();
    } catch (error) {
      if (error instanceof Error && /Terraform state bucket versioning is not enabled/i.test(error.message)) throw error;
      this.throwStateAccessError(error, stateConfig.bucket);
    }
    const lockfile = await this.inspectNativeLockfile(project, environmentName);
    if (lockfile.exists) {
      throw new Error(
        `${lockfile.stale ? "Terraform S3 lockfile exists and may be stale." : "Terraform S3 lockfile is currently active."} Lockfile: ${lockfile.key}`
      );
    }
    return { mode, stateKey, lockfileKey, lockfile };
  }

  async validateDestroyBackend(project: Project | { id: string }, environmentName = "dev") {
    const stateConfig = getStateManagementConfig(this.config);
    const stateKey = this.buildStateKey(project, environmentName);
    const expectedStateKey = `projects/${project.id}/${environmentName}/project/terraform.tfstate`;

    if (stateConfig.mockMode) throw new Error("Live infrastructure destroy requires the S3 Terraform backend.");
    if (stateConfig.bucket !== "deployguard-state-bucket") {
      throw new Error("Infrastructure destroy is restricted to the configured DeployGuard state bucket.");
    }
    if (stateKey !== expectedStateKey) {
      throw new Error(`Infrastructure destroy is restricted to project state key ${expectedStateKey}.`);
    }
    if (!stateConfig.useLockfile) {
      throw new Error("TERRAFORM_STATE_USE_LOCKFILE=true is required before infrastructure destroy.");
    }

    const backend = await this.validateRemoteBackend(project, environmentName);
    let objectVersionId: string | null = null;
    try {
      const result = await this.awsCli.run([
        "s3api",
        "head-object",
        "--bucket",
        stateConfig.bucket,
        "--key",
        expectedStateKey,
      ]);
      const payload = this.parseJson(result.stdout);
      objectVersionId = typeof payload.VersionId === "string" && payload.VersionId !== "null"
        ? payload.VersionId
        : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b404\b|Not Found|NoSuchKey/i.test(message)) {
        throw new Error("Terraform state object not found.");
      }
      if (/credentials|AccessDenied|Forbidden|InvalidAccessKeyId|SignatureDoesNotMatch|Unable to locate/i.test(message)) {
        throw new Error("AWS credentials cannot read Terraform state object.");
      }
      throw error;
    }
    if (!objectVersionId) throw new Error("Unable to record Terraform state backup reference.");

    return { ...backend, bucket: stateConfig.bucket, region: stateConfig.region, objectVersionId };
  }

  async recordDestroyStateBackup(input: {
    project: Project | { id: string };
    environment?: ProjectInfrastructureEnvironment | null;
    environmentName?: string;
    pipelineRunId?: string | null;
    operationId: string;
  }) {
    const environmentName = input.environmentName || "dev";
    let backend: Awaited<ReturnType<TerraformStateService["validateDestroyBackend"]>>;
    try {
      backend = await this.validateDestroyBackend(input.project, environmentName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/versioning is not enabled/i.test(message)) throw new Error("Terraform state bucket versioning is not enabled. Enable versioning before live destroy.");
      if (/state object not found|No Terraform state/i.test(message)) throw new Error("Terraform state object not found.");
      if (/credential|AccessDenied|Forbidden|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(message)) throw new Error("AWS credentials cannot read Terraform state object.");
      if (/backup reference/i.test(message)) throw new Error("Unable to record Terraform state backup reference.");
      throw error;
    }

    const recordedAt = new Date();
    await this.upsertStateMetadata({
      project: input.project,
      environment: input.environment,
      environmentName,
      versionId: backend.objectVersionId,
      status: TerraformStateStatus.ACTIVE,
      metadata: {
        destroyStateBackup: {
          bucket: backend.bucket,
          stateKey: backend.stateKey,
          versionId: backend.objectVersionId,
          recordedAt: recordedAt.toISOString(),
          projectId: input.project.id,
          pipelineRunId: input.pipelineRunId || null,
          operationId: input.operationId,
        },
      },
    });

    return {
      bucket: backend.bucket,
      stateKey: backend.stateKey,
      region: backend.region,
      versionId: backend.objectVersionId,
      recordedAt,
    };
  }

  async inspectNativeLockfile(project: Project | { id: string }, environmentName = "dev") {
    const stateConfig = getStateManagementConfig(this.config);
    const key = this.buildLockfileKey(project, environmentName);
    if (stateConfig.mockMode) return { exists: false, stale: false, key, lastModified: null as string | null };
    this.assertRemoteStateConfig(stateConfig);
    try {
      const result = await this.awsCli.run(["s3api", "head-object", "--bucket", stateConfig.bucket, "--key", key]);
      const payload = this.parseJson(result.stdout);
      const lastModified = typeof payload.LastModified === "string" ? payload.LastModified : null;
      const modifiedAt = lastModified ? new Date(lastModified).getTime() : Number.NaN;
      const stale = Number.isFinite(modifiedAt) && Date.now() - modifiedAt > stateConfig.staleAfterSeconds * 1000;
      return { exists: true, stale, key, lastModified };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b404\b|Not Found|NoSuchKey/i.test(message)) return { exists: false, stale: false, key, lastModified: null };
      this.throwStateAccessError(error, stateConfig.bucket);
    }
  }

  async clearStaleNativeLockfile(project: Project | { id: string }, environmentName = "dev") {
    const stateConfig = getStateManagementConfig(this.config);
    if (stateConfig.mockMode) throw new Error("S3 lockfile recovery is unavailable in mock state mode.");
    const lockfile = await this.inspectNativeLockfile(project, environmentName);
    if (!lockfile.exists) return { ...lockfile, cleared: false };
    if (!lockfile.stale) throw new Error("Terraform S3 lockfile is active and cannot be cleared.");
    await this.awsCli.run(["s3api", "delete-object", "--bucket", stateConfig.bucket, "--key", lockfile.key]);
    return { ...lockfile, exists: false, cleared: true };
  }

  async listStateVersions(project: Project, environmentName = "dev") {
    const stateConfig = getStateManagementConfig(this.config);
    if (!stateConfig.mockMode) this.assertRemoteStateConfig(stateConfig);
    const key = this.buildStateKey(project, environmentName);
    const result = await this.awsCli.run([
      "s3api",
      "list-object-versions",
      "--bucket",
      stateConfig.bucket,
      "--prefix",
      key,
    ]);

    try {
      const parsed = JSON.parse(result.stdout || "{}") as { Versions?: unknown[] };
      return parsed.Versions || [];
    } catch {
      return [];
    }
  }

  async getStateObject(project: Project | { id: string }, environmentName = "dev") {
    const stateConfig = getStateManagementConfig(this.config);
    if (stateConfig.mockMode) return JSON.stringify({ version: 4, serial: 0, resources: [] });
    if (!stateConfig.mockMode) this.assertRemoteStateConfig(stateConfig);
    const key = this.buildStateKey(project, environmentName);
    const directory = await mkdtemp(join(tmpdir(), "deployguard-state-read-"));
    const outputPath = join(directory, "terraform.tfstate");
    try {
      await this.awsCli.run([
        "s3api",
        "get-object",
        "--bucket",
        stateConfig.bucket,
        "--key",
        key,
        outputPath,
      ]);
      return await readFile(outputPath, "utf8");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async getPreviousStateVersion(project: Project, environmentName = "dev") {
    const versions = await this.listStateVersions(project, environmentName);
    return versions[1] || null;
  }

  async restoreStateVersion(project: Project, environmentName: string, versionId: string) {
    const stateConfig = getStateManagementConfig(this.config);
    if (!stateConfig.mockMode) this.assertRemoteStateConfig(stateConfig);
    const key = this.buildStateKey(project, environmentName);
    await this.awsCli.run([
      "s3api",
      "copy-object",
      "--bucket",
      stateConfig.bucket,
      "--copy-source",
      `${stateConfig.bucket}/${key}?versionId=${encodeURIComponent(versionId)}`,
      "--key",
      key,
    ]);
  }

  async upsertStateMetadata(input: {
    project: Project | { id: string };
    environment?: ProjectInfrastructureEnvironment | null;
    environmentName?: string;
    rawState?: string | null;
    versionId?: string | null;
    resourceCount?: number | null;
    dependencyGraphHash?: string | null;
    status?: string;
    metadata?: Record<string, unknown> | null;
  }) {
    const stateConfig = getStateManagementConfig(this.config);
    const environmentName = input.environmentName || "dev";
    const stateKey = this.buildStateKey(input.project, environmentName);
    const existing = await this.stateRepository.findOne({
      where: { projectId: input.project.id, environmentName },
    });
    const state = existing || this.stateRepository.create({ projectId: input.project.id, environmentName });

    state.infrastructureEnvironmentId = input.environment?.id || state.infrastructureEnvironmentId || null;
    state.stateBucket = stateConfig.bucket || "mock-state-bucket";
    state.stateKey = stateKey;
    state.stateRegion = stateConfig.region;
    if (input.versionId && input.versionId !== state.currentVersionId) {
      state.previousVersionId = state.currentVersionId || null;
      state.currentVersionId = input.versionId;
    } else {
      state.currentVersionId = state.currentVersionId || null;
    }
    state.checksum = input.rawState ? this.sha256(input.rawState) : state.checksum || null;
    state.resourceCount = input.resourceCount ?? state.resourceCount ?? null;
    state.dependencyGraphHash = input.dependencyGraphHash || state.dependencyGraphHash || null;
    state.status = input.status || TerraformStateStatus.ACTIVE;
    state.metadata = input.metadata ? { ...(state.metadata || {}), ...input.metadata } : state.metadata || null;
    state.lastValidatedAt = new Date();

    return this.stateRepository.save(state);
  }

  async getStateMetadata(projectId: string, environmentName = "dev") {
    return this.stateRepository.findOne({ where: { projectId, environmentName } });
  }

  sha256(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }

  private parseJson(value: string) {
    try { return JSON.parse(value || "{}") as Record<string, unknown>; } catch { return {}; }
  }

  private throwStateAccessError(error: unknown, bucket: string): never {
    const message = error instanceof Error ? error.message : String(error);
    if (/AccessDenied|Forbidden|\b403\b|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(message)) {
      throw new Error("AWS credentials cannot access Terraform state bucket or lockfile.");
    }
    if (/NoSuchBucket|Not Found|\b404\b/i.test(message)) {
      throw new Error(`Terraform state bucket ${bucket} was not found or is not accessible.`);
    }
    throw new Error(`Terraform state bucket ${bucket} was not found or is not accessible.`);
  }
}
