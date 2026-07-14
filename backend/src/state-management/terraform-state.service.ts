import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash } from "crypto";
import { writeFile } from "fs/promises";
import { join } from "path";
import { Repository } from "typeorm";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { Project } from "../projects/project.entity";
import { AwsCliService } from "./aws-cli.service";
import { ProjectTerraformState, TerraformStateStatus } from "./project-terraform-state.entity";
import { getStateManagementConfig } from "./state-management.config";

@Injectable()
export class TerraformStateService {
  constructor(
    @InjectRepository(ProjectTerraformState)
    private readonly stateRepository: Repository<ProjectTerraformState>,
    private readonly config: ConfigService,
    private readonly awsCli: AwsCliService
  ) {}

  async ensureStateBucket() {
    const stateConfig = getStateManagementConfig(this.config);

    if (!stateConfig.bucket) {
      if (stateConfig.mockMode) {
        return;
      }

      throw new Error("DEPLOYGUARD_TF_STATE_BUCKET is required for remote Terraform state.");
    }

    await this.awsCli.run(["s3api", "head-bucket", "--bucket", stateConfig.bucket]);
  }

  async ensureStateBucketVersioning() {
    const stateConfig = getStateManagementConfig(this.config);
    await this.awsCli.run([
      "s3api",
      "put-bucket-versioning",
      "--bucket",
      stateConfig.bucket,
      "--versioning-configuration",
      "Status=Enabled",
    ]);
  }

  async ensureStateBucketEncryption() {
    const stateConfig = getStateManagementConfig(this.config);
    await this.awsCli.run([
      "s3api",
      "put-bucket-encryption",
      "--bucket",
      stateConfig.bucket,
      "--server-side-encryption-configuration",
      JSON.stringify({
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
      }),
    ]);
  }

  async ensureStateBucketPublicAccessBlock() {
    const stateConfig = getStateManagementConfig(this.config);
    await this.awsCli.run([
      "s3api",
      "put-public-access-block",
      "--bucket",
      stateConfig.bucket,
      "--public-access-block-configuration",
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
    ]);
  }

  async ensureLockTable() {
    const stateConfig = getStateManagementConfig(this.config);
    await this.awsCli.run([
      "dynamodb",
      "describe-table",
      "--table-name",
      stateConfig.lockTable,
    ]);
  }

  buildStateKey(project: Project | { id: string; ownerUserId?: number }, environmentName = "dev") {
    const stateConfig = getStateManagementConfig(this.config);
    const owner = project.ownerUserId || "unknown";
    const prefix = stateConfig.prefix.replace(/^\/+|\/+$/g, "");

    return `${prefix}/user-${owner}/project-${project.id}/${environmentName}/terraform.tfstate`;
  }

  generateTerraformBackendConfig(project: Project, environmentName = "dev") {
    const stateConfig = getStateManagementConfig(this.config);
    const key = this.buildStateKey(project, environmentName);

    return [
      `bucket = "${stateConfig.bucket}"`,
      `key = "${key}"`,
      `region = "${stateConfig.region}"`,
      `dynamodb_table = "${stateConfig.lockTable}"`,
      "encrypt = true",
    ].join("\n");
  }

  async writeBackendConfig(workdir: string, project: Project, environmentName = "dev") {
    const backendConfig = this.generateTerraformBackendConfig(project, environmentName);
    const path = join(workdir, "backend.hcl");
    await writeFile(path, backendConfig, "utf8");
    return path;
  }

  async listStateVersions(project: Project, environmentName = "dev") {
    const stateConfig = getStateManagementConfig(this.config);
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

  async getStateObject(project: Project, environmentName = "dev") {
    const stateConfig = getStateManagementConfig(this.config);
    const key = this.buildStateKey(project, environmentName);
    const result = await this.awsCli.run([
      "s3api",
      "get-object",
      "--bucket",
      stateConfig.bucket,
      "--key",
      key,
      "/dev/stdout",
    ]);

    return result.stdout;
  }

  async getPreviousStateVersion(project: Project, environmentName = "dev") {
    const versions = await this.listStateVersions(project, environmentName);
    return versions[1] || null;
  }

  async restoreStateVersion(project: Project, environmentName: string, versionId: string) {
    const stateConfig = getStateManagementConfig(this.config);
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
    project: Project;
    environment?: ProjectInfrastructureEnvironment | null;
    environmentName?: string;
    rawState?: string | null;
    versionId?: string | null;
    resourceCount?: number | null;
    dependencyGraphHash?: string | null;
    status?: string;
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
    state.previousVersionId = state.currentVersionId || null;
    state.currentVersionId = input.versionId || state.currentVersionId || null;
    state.checksum = input.rawState ? this.sha256(input.rawState) : state.checksum || null;
    state.resourceCount = input.resourceCount ?? state.resourceCount ?? null;
    state.dependencyGraphHash = input.dependencyGraphHash || state.dependencyGraphHash || null;
    state.status = input.status || TerraformStateStatus.ACTIVE;
    state.lastValidatedAt = new Date();

    return this.stateRepository.save(state);
  }

  async getStateMetadata(projectId: string, environmentName = "dev") {
    return this.stateRepository.findOne({ where: { projectId, environmentName } });
  }

  sha256(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }
}
