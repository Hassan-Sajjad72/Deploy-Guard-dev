import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { DataSource, In, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { AwsCliService } from "../state-management/aws-cli.service";
import { User } from "../users/user.entity";
import { canonicalEnvironmentName } from "./canonical-environment";
import { ManagedDatabaseReconciliationState } from "./managed-database-reconciliation";
import { ManagedDatabaseReconciliationService } from "./managed-database-reconciliation.service";
import { DatabaseTierStatus, ProjectDatabaseTier } from "./project-database-tier.entity";
import { PipelineRunStatus, ProjectPipelineRun } from "./project-pipeline-run.entity";
import { ProjectServiceBinding, ServiceBindingStatus } from "./project-service-binding.entity";
import { ProjectsService } from "./projects.service";

const RESETTABLE_STATE_TYPES = new Set([
  "aws_secretsmanager_secret",
  "aws_secretsmanager_secret_version",
  "aws_efs_file_system",
  "aws_efs_access_point",
  "aws_efs_mount_target",
  "random_password",
]);

@Injectable()
export class ManagedDatabaseResetService {
  constructor(
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectServiceBinding) private readonly bindings: Repository<ProjectServiceBinding>,
    @InjectRepository(ProjectDatabaseTier) private readonly tiers: Repository<ProjectDatabaseTier>,
    private readonly projects: ProjectsService,
    private readonly reconciliation: ManagedDatabaseReconciliationService,
    private readonly aws: AwsCliService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
  ) {}

  async reset(user: User, projectId: string, confirmationPhrase: string, req?: unknown) {
    if (confirmationPhrase !== "RESET MANAGED DATABASE") {
      throw new BadRequestException("Type RESET MANAGED DATABASE to confirm that the previous database contents are lost.");
    }
    const project = await this.projects.getProjectEntityForManage(user, projectId);
    const active = await this.runs.findOne({ where: { projectId, status: In([PipelineRunStatus.QUEUED, PipelineRunStatus.RUNNING]) } });
    if (active) throw new ConflictException("Wait for the active deployment operation to finish before resetting the managed database.");
    const report = await this.reconciliation.reconcile(project);
    if (![ManagedDatabaseReconciliationState.DATA_LOST_RESET_REQUIRED, ManagedDatabaseReconciliationState.STALE_METADATA].includes(report.state)) {
      throw new ConflictException({ code: report.state, message: "Managed database reset is allowed only when storage loss or stale metadata has been proven.", databaseReconciliation: report });
    }
    if (report.evidence.currentFileSystem || report.backup.recoverableRecoveryPointArn) {
      throw new ConflictException("Reset was rejected because retained storage or recoverable backup evidence exists.");
    }

    const environment = canonicalEnvironmentName(project);
    const stateAddressesRemoved = await this.removeDatabaseState(project.id, environment);
    const secretsRemoved: string[] = [];
    for (const purpose of ["password", "url"] as const) {
      const name = `deployguard/${project.id}/${environment}/database/${purpose}`;
      if (await this.deleteOwnedSecret(name, project.id, environment)) secretsRemoved.push(name);
    }

    const resetAt = new Date();
    await this.dataSource.transaction(async (manager) => {
      const bindings = manager.getRepository(ProjectServiceBinding);
      const tiers = manager.getRepository(ProjectDatabaseTier);
      const staleBindings = await bindings.find({ where: { projectId, generationId: null, provider: "managed" } });
      for (const binding of staleBindings) {
        binding.status = ServiceBindingStatus.FAILED;
        binding.failureReason = "Retired by explicit managed database reset after verified data loss.";
        binding.efsFileSystemId = null;
        binding.efsAccessPointId = null;
        binding.passwordSecretReference = null;
        binding.databaseUrlSecretReference = null;
      }
      await bindings.save(staleBindings);
      const tier = await tiers.findOne({ where: { projectId } });
      if (tier) {
        tier.status = DatabaseTierStatus.PENDING;
        tier.efsFileSystemId = null;
        tier.efsAccessPointId = null;
        tier.credentialsSecretArn = null;
        tier.databaseUrlSecretArn = null;
        tier.backupPlanId = null;
        tier.lastBackupAt = null;
        tier.lastRestoreAt = null;
        tier.lastError = "Previous managed database contents were lost. An operator explicitly reset the database identity; the next deployment may provision a fresh empty database.";
        tier.restoreMetadata = {
          kind: "data_lost_reset",
          resetAt: resetAt.toISOString(),
          resetByUserId: user.id,
          retiredBindingIds: staleBindings.map((binding) => binding.id),
          stateAddressesRemoved,
          secretsRemoved,
        };
        await tiers.save(tier);
      }
    });
    await this.audit.record({
      actorUser: user,
      action: "MANAGED_DATABASE_RESET",
      resourceType: "project",
      resourceId: projectId,
      status: "success",
      metadata: { environment, previousDataLost: true, stateAddressCount: stateAddressesRemoved.length, secretCount: secretsRemoved.length },
      req,
    });
    return {
      state: "RESET_COMPLETE",
      message: "The lost managed database identity was reset. No new database was created; the next deployment may provision a fresh instance.",
      previousDataLost: true,
      stateAddressesRemoved,
      secretsRemoved: secretsRemoved.length,
    };
  }

  private async deleteOwnedSecret(name: string, projectId: string, environment: string) {
    let description: { DeletedDate?: string; Tags?: Array<{ Key?: string; Value?: string }> };
    try {
      const response = await this.aws.run(["secretsmanager", "describe-secret", "--secret-id", name, "--output", "json"]);
      description = JSON.parse(response.stdout || "{}") as typeof description;
    } catch (error) {
      if (/ResourceNotFoundException|can't find the specified secret/i.test(error instanceof Error ? error.message : String(error))) return false;
      throw error;
    }
    const tags = Object.fromEntries((description.Tags || []).map((tag) => [tag.Key || "", tag.Value || ""]));
    if (tags.ManagedBy !== "DeployGuard" || tags.DeployGuardProjectId !== projectId || tags.Environment !== environment || tags.DeployGuardScope !== "project") {
      throw new ConflictException("Managed database reset found a secret that failed project/environment ownership verification.");
    }
    if (description.DeletedDate) {
      await this.aws.run(["secretsmanager", "restore-secret", "--secret-id", name, "--output", "json"]);
    }
    await this.aws.run(["secretsmanager", "delete-secret", "--secret-id", name, "--force-delete-without-recovery", "--output", "json"]);
    return true;
  }

  private async removeDatabaseState(projectId: string, environment: string) {
    const bucket = this.config.get<string>("DEPLOYGUARD_TERRAFORM_STATE_BUCKET", "");
    if (!bucket) throw new ConflictException("Terraform state bucket is not configured; database reset cannot safely reconcile state.");
    const key = `projects/${projectId}/${environment}/project/terraform.tfstate`;
    const lockKey = `${key}.tflock`;
    try {
      await this.aws.run(["s3api", "head-object", "--bucket", bucket, "--key", lockKey]);
      throw new ConflictException("Terraform state is locked; database reset cannot continue.");
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (!/NoSuchKey|404|Not Found/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
    const directory = await mkdtemp(join(tmpdir(), "deployguard-db-reset-"));
    const statePath = join(directory, "terraform.tfstate");
    try {
      let downloaded: { VersionId?: string } = {};
      try {
        const response = await this.aws.run(["s3api", "get-object", "--bucket", bucket, "--key", key, statePath]);
        downloaded = JSON.parse(response.stdout || "{}") as { VersionId?: string };
      } catch (error) {
        if (/NoSuchKey|404|Not Found/i.test(error instanceof Error ? error.message : String(error))) return [];
        throw error;
      }
      const state = JSON.parse(await readFile(statePath, "utf8")) as { serial?: number; resources?: Array<{ module?: string; type?: string; name?: string }> };
      const resources = state.resources || [];
      const removed = resources.filter((resource) => this.resettable(resource)).map((resource) => `${resource.module ? `${resource.module}.` : ""}${resource.type}.${resource.name}`);
      if (!removed.length) return [];
      state.resources = resources.filter((resource) => !this.resettable(resource));
      state.serial = Number(state.serial || 0) + 1;
      const head = await this.aws.run(["s3api", "head-object", "--bucket", bucket, "--key", key]);
      const currentVersion = (JSON.parse(head.stdout || "{}") as { VersionId?: string }).VersionId;
      if (downloaded.VersionId && currentVersion !== downloaded.VersionId) throw new ConflictException("Terraform state changed during database reset; retry after the active operation finishes.");
      await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
      await this.aws.run(["s3api", "put-object", "--bucket", bucket, "--key", key, "--body", statePath, "--content-type", "application/json"]);
      return removed.sort();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private resettable(resource: { module?: string; type?: string; name?: string }) {
    if (!resource.type || !resource.name || !RESETTABLE_STATE_TYPES.has(resource.type)) return false;
    return /database/.test(resource.name) || /database_service/.test(resource.module || "");
  }
}
