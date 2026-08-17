import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Repository } from "typeorm";
import { AwsCliService } from "../state-management/aws-cli.service";
import { ProjectBackupRecord, BackupRecordStatus } from "../storage/project-backup-record.entity";
import { canonicalEnvironmentName } from "./canonical-environment";
import { ProjectDatabaseTier, DatabaseTierProvider } from "./project-database-tier.entity";
import { ProjectServiceBinding, ServiceBindingStatus } from "./project-service-binding.entity";
import { Project } from "./project.entity";
import { ProjectDeploymentGeneration } from "./project-deployment-generation.entity";
import { MANAGED_DATABASE_PERSISTENCE_TAG, managedDatabaseEfsCreationToken } from "./managed-database-identity";
import {
  classifyManagedDatabase,
  ManagedDatabaseReconciliation,
  ManagedDatabaseReconciliationEvidence,
} from "./managed-database-reconciliation";

type AwsFileSystem = { FileSystemId?: string; CreationToken?: string; LifeCycleState?: string; Tags?: Array<{ Key?: string; Value?: string }> };
type AwsAccessPoint = { AccessPointId?: string; LifeCycleState?: string; Tags?: Array<{ Key?: string; Value?: string }> };
type RecoveryPoint = { RecoveryPointArn?: string; Status?: string; ResourceArn?: string; CreationDate?: string; CompletionDate?: string };

export type ManagedDatabaseReconciliationReport = ManagedDatabaseReconciliation & {
  evidence: ManagedDatabaseReconciliationEvidence;
  backup: {
    requested: boolean;
    infrastructureActive: boolean;
    lastSuccessfulBackupAt: string | null;
    recoverableRecoveryPointArn: string | null;
  };
  identity: { environment: string; generationId: string | null; currentCreationToken: string };
};

const DATABASE_STATE_TYPES = new Set([
  "aws_secretsmanager_secret", "aws_secretsmanager_secret_version",
  "aws_efs_file_system", "aws_efs_access_point", "aws_efs_mount_target",
  "aws_ecs_service", "aws_ecs_task_definition", "aws_service_discovery_service",
  "aws_service_discovery_private_dns_namespace",
  "aws_security_group", "aws_iam_role", "aws_iam_role_policy", "random_password",
]);

type TerraformStateResource = { module?: string; type?: string; name?: string; instances?: unknown[] };

export function activeTerraformDatabaseAddresses(state: { resources?: TerraformStateResource[] }) {
  return (state.resources || [])
    .filter((resource) => Array.isArray(resource.instances) && resource.instances.length > 0)
    .filter((resource) => Boolean(resource.type && resource.name && DATABASE_STATE_TYPES.has(resource.type)))
    .filter((resource) => /database/.test(resource.name!) || /database_service/.test(resource.module || ""))
    .map((resource) => `${resource.module ? `${resource.module}.` : ""}${resource.type}.${resource.name}`);
}

export function hasManagedDatabaseOwnership(
  tags: Array<{ Key?: string; Value?: string }> | undefined,
  projectId: string,
  environment: string,
  requirePersistenceTag: boolean,
) {
  const values = Object.fromEntries((tags || []).map((tag) => [tag.Key || "", tag.Value || ""]));
  return values.ManagedBy === "DeployGuard"
    && values.DeployGuardProjectId === projectId
    && (!requirePersistenceTag || (values.Environment === environment && values.Persistence === MANAGED_DATABASE_PERSISTENCE_TAG));
}

export function selectManagedDatabaseFileSystem(
  fileSystems: AwsFileSystem[],
  boundFileSystemId: string | null,
  creationToken: string,
  projectId: string,
  environment: string,
) {
  return fileSystems.find((item) =>
    item.FileSystemId === boundFileSystemId
    && hasManagedDatabaseOwnership(item.Tags, projectId, environment, true),
  ) || fileSystems.find((item) =>
    item.CreationToken === creationToken
    && hasManagedDatabaseOwnership(item.Tags, projectId, environment, true),
  ) || null;
}

@Injectable()
export class ManagedDatabaseReconciliationService {
  constructor(
    @InjectRepository(ProjectDatabaseTier) private readonly tiers: Repository<ProjectDatabaseTier>,
    @InjectRepository(ProjectServiceBinding) private readonly bindings: Repository<ProjectServiceBinding>,
    @InjectRepository(ProjectBackupRecord) private readonly backups: Repository<ProjectBackupRecord>,
    @InjectRepository(ProjectDeploymentGeneration) private readonly generations: Repository<ProjectDeploymentGeneration>,
    private readonly aws: AwsCliService,
    private readonly config: ConfigService,
  ) {}

  async reconcile(project: Project, requestedGenerationId?: string | null): Promise<ManagedDatabaseReconciliationReport> {
    const environment = canonicalEnvironmentName(project);
    const generation = requestedGenerationId
      ? await this.generations.findOne({ where: { id: requestedGenerationId, projectId: project.id, environmentName: environment } })
      : null;
    const generationId = generation?.id || null;
    const tier = await this.tiers.findOne({ where: { projectId: project.id } });
    const binding = await this.bindings.createQueryBuilder("binding")
      .where("binding.projectId = :projectId", { projectId: project.id })
      .andWhere("binding.generationId IS NULL")
      .andWhere("binding.provider = 'managed'")
      .andWhere("binding.status != :failed", { failed: ServiceBindingStatus.FAILED })
      .orderBy("CASE WHEN binding.status = 'verified' THEN 0 WHEN binding.status = 'applied' THEN 1 ELSE 2 END", "ASC")
      .addOrderBy("binding.updatedAt", "DESC")
      .getOne();
    const backupRecords = tier?.backupEnabled
      ? await this.backups.find({ where: { projectId: project.id }, order: { updatedAt: "DESC" } })
      : [];
    const currentCreationToken = managedDatabaseEfsCreationToken(project.id, environment);
    const fileSystems = await this.fileSystems();
    // A bound project-scoped filesystem is authoritative when its ownership
    // matches. The workflow-compatible creation token safely discovers the
    // same filesystem when a first run failed before binding-result ingestion.
    const boundFileSystemId = binding?.efsFileSystemId || tier?.efsFileSystemId || null;
    const current = selectManagedDatabaseFileSystem(
      fileSystems,
      boundFileSystemId,
      currentCreationToken,
      project.id,
      environment,
    );
    const accessPoint = current?.FileSystemId ? await this.accessPoint(current.FileSystemId, project.id, environment) : null;
    const passwordName = `deployguard/${project.id}/${environment}/database/password`;
    const urlName = `deployguard/${project.id}/${environment}/database/url`;
    const [passwordSecretPresent, urlSecretPresent, terraformDatabaseAddresses] = await Promise.all([
      this.secretPresent(passwordName, project.id, environment),
      this.secretPresent(urlName, project.id, environment),
      this.terraformDatabaseAddresses(project.id, environment),
    ]);
    const expectedFileSystemId = binding?.efsFileSystemId || tier?.efsFileSystemId || current?.FileSystemId || null;
    const recoveryPoints = expectedFileSystemId
      ? await this.recoveryPoints(expectedFileSystemId)
      : [];
    const usableRecoveryPoint = this.usableRecoveryPoint(recoveryPoints, backupRecords);
    const backupInfrastructureActive = await this.backupInfrastructureActive([
      tier?.backupPlanId || null,
      ...backupRecords.map((record) => record.backupPlanId || null),
    ]);
    const expectedStorageIdentity = Boolean(
      expectedFileSystemId
      || binding?.efsAccessPointId
      || [ServiceBindingStatus.VERIFIED, ServiceBindingStatus.APPLIED, ServiceBindingStatus.READY].includes(binding?.status as ServiceBindingStatus),
    );
    const evidence: ManagedDatabaseReconciliationEvidence = {
      managed: tier?.provider === DatabaseTierProvider.MANAGED,
      persistenceEnabled: Boolean(tier?.persistenceEnabled),
      expectedStorageIdentity,
      bindingStatus: binding?.status || null,
      bindingFileSystemId: binding?.efsFileSystemId || tier?.efsFileSystemId || null,
      bindingAccessPointId: binding?.efsAccessPointId || tier?.efsAccessPointId || null,
      currentFileSystem: this.fileSystemEvidence(current, "current", project.id, environment, true),
      accessPoint: accessPoint ? {
        id: accessPoint.AccessPointId || "",
        identity: "current",
        owned: this.owned(accessPoint.Tags, project.id, environment, true),
        available: accessPoint.LifeCycleState === "available",
      } : null,
      passwordSecretPresent,
      urlSecretPresent,
      terraformDatabaseAddresses,
      usableRecoveryPointArn: usableRecoveryPoint?.RecoveryPointArn || null,
    };
    const classification = classifyManagedDatabase(evidence);
    const successfulRecord = backupRecords.find((record) => record.status === BackupRecordStatus.BACKUP_AVAILABLE && record.recoveryPointArn);
    return {
      ...classification,
      evidence,
      identity: { environment, generationId, currentCreationToken },
      backup: {
        requested: Boolean(tier?.backupEnabled),
        infrastructureActive: backupInfrastructureActive,
        lastSuccessfulBackupAt: usableRecoveryPoint?.CompletionDate || usableRecoveryPoint?.CreationDate || successfulRecord?.updatedAt?.toISOString() || null,
        recoverableRecoveryPointArn: usableRecoveryPoint?.RecoveryPointArn || null,
      },
    };
  }

  private async fileSystems(): Promise<AwsFileSystem[]> {
    const result = await this.aws.run(["efs", "describe-file-systems", "--output", "json"]);
    return (JSON.parse(result.stdout || "{}") as { FileSystems?: AwsFileSystem[] }).FileSystems || [];
  }

  private async accessPoint(fileSystemId: string, projectId: string, environment: string): Promise<AwsAccessPoint | null> {
    const result = await this.aws.run(["efs", "describe-access-points", "--file-system-id", fileSystemId, "--output", "json"]);
    const points = (JSON.parse(result.stdout || "{}") as { AccessPoints?: AwsAccessPoint[] }).AccessPoints || [];
    return points.find((point) => this.owned(point.Tags, projectId, environment, false)) || null;
  }

  private async secretPresent(name: string, projectId: string, environment: string) {
    try {
      const result = await this.aws.run(["secretsmanager", "describe-secret", "--secret-id", name, "--output", "json"]);
      const secret = JSON.parse(result.stdout || "{}") as { DeletedDate?: string; Tags?: Array<{ Key?: string; Value?: string }> };
      return !secret.DeletedDate && this.owned(secret.Tags, projectId, environment, false);
    } catch (error) {
      if (/ResourceNotFoundException|can't find the specified secret/i.test(error instanceof Error ? error.message : String(error))) return false;
      throw error;
    }
  }

  private async recoveryPoints(fileSystemId: string): Promise<RecoveryPoint[]> {
    const region = this.config.get<string>("AWS_REGION", "us-east-1");
    const account = this.config.get<string>("AWS_ACCOUNT_ID", "");
    const resourceArn = account
      ? `arn:aws:elasticfilesystem:${region}:${account}:file-system/${fileSystemId}`
      : await this.fileSystemArn(fileSystemId, region);
    if (!resourceArn) return [];
    const result = await this.aws.run(["backup", "list-recovery-points-by-resource", "--resource-arn", resourceArn, "--output", "json"]);
    return (JSON.parse(result.stdout || "{}") as { RecoveryPoints?: RecoveryPoint[] }).RecoveryPoints || [];
  }

  private async fileSystemArn(fileSystemId: string, region: string) {
    try {
      const identity = await this.aws.run(["sts", "get-caller-identity", "--output", "json"]);
      const account = String((JSON.parse(identity.stdout || "{}") as { Account?: string }).Account || "");
      return account ? `arn:aws:elasticfilesystem:${region}:${account}:file-system/${fileSystemId}` : null;
    } catch { return null; }
  }

  private usableRecoveryPoint(points: RecoveryPoint[], records: ProjectBackupRecord[]) {
    const recorded = new Set(records
      .filter((record) => record.status === BackupRecordStatus.BACKUP_AVAILABLE && record.recoveryPointArn)
      .map((record) => record.recoveryPointArn));
    return points
      .filter((point) => point.Status === "COMPLETED" && point.RecoveryPointArn && recorded.has(point.RecoveryPointArn))
      .sort((left, right) => String(right.CompletionDate || right.CreationDate || "").localeCompare(String(left.CompletionDate || left.CreationDate || "")))[0] || null;
  }

  private async backupInfrastructureActive(candidatePlanIds: Array<string | null>) {
    const planIds = [...new Set(candidatePlanIds.filter((value): value is string => Boolean(value)))];
    for (const planId of planIds) {
      try {
        await this.aws.run(["backup", "get-backup-plan", "--backup-plan-id", planId, "--output", "json"]);
        const selections = await this.aws.run(["backup", "list-backup-selections", "--backup-plan-id", planId, "--output", "json"]);
        if (((JSON.parse(selections.stdout || "{}") as { BackupSelectionsList?: unknown[] }).BackupSelectionsList || []).length > 0) return true;
      } catch (error) {
        if (!/ResourceNotFoundException|not found/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
    return false;
  }

  private async terraformDatabaseAddresses(projectId: string, environment: string) {
    const bucket = this.config.get<string>("DEPLOYGUARD_TERRAFORM_STATE_BUCKET", "");
    if (!bucket) return [];
    const directory = await mkdtemp(join(tmpdir(), "deployguard-db-state-read-"));
    const output = join(directory, "terraform.tfstate");
    try {
      try {
        await this.aws.run(["s3api", "get-object", "--bucket", bucket, "--key", `projects/${projectId}/${environment}/project/terraform.tfstate`, output]);
      } catch (error) {
        if (/NoSuchKey|404|Not Found/i.test(error instanceof Error ? error.message : String(error))) return [];
        throw error;
      }
      const state = JSON.parse(await readFile(output, "utf8")) as { resources?: TerraformStateResource[] };
      return activeTerraformDatabaseAddresses(state);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private fileSystemEvidence(fileSystem: AwsFileSystem | null, identity: "current", projectId: string, environment: string, requireCurrentTags: boolean) {
    return fileSystem ? {
      id: fileSystem.FileSystemId || "",
      identity,
      owned: this.owned(fileSystem.Tags, projectId, environment, requireCurrentTags),
      available: fileSystem.LifeCycleState === "available",
    } : null;
  }

  private owned(tags: Array<{ Key?: string; Value?: string }> | undefined, projectId: string, environment: string, current: boolean) {
    return hasManagedDatabaseOwnership(tags, projectId, environment, current);
  }
}
