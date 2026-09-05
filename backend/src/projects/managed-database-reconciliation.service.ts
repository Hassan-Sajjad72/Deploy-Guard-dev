import { ServiceUnavailableException } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Repository } from "typeorm";
import { AwsCliService } from "../state-management/aws-cli.service";
import { canonicalEnvironmentName } from "./canonical-environment";
import {
  classifyManagedDatabase,
  ManagedDatabaseReconciliation,
  ManagedDatabaseReconciliationEvidence,
} from "./managed-database-reconciliation";
import { DatabaseTierProvider, DatabaseTierStatus, ProjectDatabaseTier } from "./project-database-tier.entity";
import { Project } from "./project.entity";

type AwsFileSystem = { FileSystemId?: string; LifeCycleState?: string; Tags?: Array<{ Key?: string; Value?: string }> };
type AwsAccessPoint = { AccessPointId?: string; LifeCycleState?: string; Tags?: Array<{ Key?: string; Value?: string }> };
type TerraformStateResource = { module?: string; type?: string; name?: string; instances?: unknown[] };

const DATABASE_STATE_TYPES = new Set([
  "aws_secretsmanager_secret", "aws_secretsmanager_secret_version", "aws_efs_file_system", "aws_efs_access_point",
  "aws_efs_mount_target", "aws_ecs_service", "aws_ecs_task_definition", "aws_service_discovery_service",
  "aws_service_discovery_private_dns_namespace", "aws_security_group", "aws_iam_role", "aws_iam_role_policy", "random_password",
]);

export type ManagedDatabaseReconciliationReport = ManagedDatabaseReconciliation & {
  evidence: ManagedDatabaseReconciliationEvidence;
  tierUpdatedAt: string | null;
  engine: "postgres" | "mysql" | "mongodb" | null;
  attachedServiceId: string | null;
  identity: { environment: string; activeGenerationId: string | null };
};

export function activeTerraformDatabaseAddresses(state: { resources?: TerraformStateResource[] }) {
  return (state.resources || [])
    .filter((resource) => Array.isArray(resource.instances) && resource.instances.length > 0)
    .filter((resource) => Boolean(resource.type && resource.name && DATABASE_STATE_TYPES.has(resource.type)))
    .filter((resource) => /database/.test(resource.name!) || /database/.test(resource.module || ""))
    .map((resource) => `${resource.module ? `${resource.module}.` : ""}${resource.type}.${resource.name}`)
    .sort();
}

@Injectable()
export class ManagedDatabaseReconciliationService {
  constructor(
    @InjectRepository(ProjectDatabaseTier) private readonly tiers: Repository<ProjectDatabaseTier>,
    private readonly aws: AwsCliService,
    private readonly config: ConfigService,
  ) {}

  async reconcile(project: Project): Promise<ManagedDatabaseReconciliationReport> {
    const tier = await this.tiers.findOne({ where: { projectId: project.id } });
    const environment = canonicalEnvironmentName(project);
    if (tier?.provider !== DatabaseTierProvider.MANAGED) return this.classify(tier, environment, {
      managed: false, persistenceEnabled: false, expectedStorageIdentity: false, bindingStatus: null,
      bindingFileSystemId: null, bindingAccessPointId: null, currentFileSystem: null, accessPoint: null,
      passwordSecretPresent: false, urlSecretPresent: false, terraformDatabaseAddresses: [], usableRecoveryPointArn: null,
    });

    try {
      const [fileSystems, secretPresent, terraformDatabaseAddresses] = await Promise.all([
        this.fileSystems(), this.secretPresent(project.id, environment), this.terraformDatabaseAddresses(project.id, environment),
      ]);
      const current = this.selectFileSystem(fileSystems, tier, project.id, environment);
      const accessPoint = current?.FileSystemId ? await this.accessPoint(current.FileSystemId, project.id, environment) : null;
      const expectedStorageIdentity = Boolean(
        tier.efsFileSystemId || tier.efsAccessPointId || tier.activeGenerationId || tier.status === DatabaseTierStatus.READY,
      );
      return this.classify(tier, environment, {
        managed: true,
        persistenceEnabled: tier.persistenceEnabled,
        expectedStorageIdentity,
        bindingStatus: tier.status,
        bindingFileSystemId: tier.efsFileSystemId,
        bindingAccessPointId: tier.efsAccessPointId,
        currentFileSystem: current ? {
          id: current.FileSystemId || "", identity: "current", owned: this.owned(current.Tags, project.id, environment), available: current.LifeCycleState === "available",
        } : null,
        accessPoint: accessPoint ? {
          id: accessPoint.AccessPointId || "", identity: "current", owned: this.owned(accessPoint.Tags, project.id, environment), available: accessPoint.LifeCycleState === "available",
        } : null,
        // The active Terraform runtime stores password and URL in one owned
        // project secret, so its verified presence satisfies both aliases.
        passwordSecretPresent: secretPresent,
        urlSecretPresent: secretPresent,
        terraformDatabaseAddresses,
        // AWS Backup is not part of the active managed-database runtime.
        usableRecoveryPointArn: null,
      });
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException({
        code: "DG_AWS_PROVIDER_FAILED",
        message: "Managed database state could not be verified before deployment.",
        stage: "managed_database_admission",
      });
    }
  }

  private classify(tier: ProjectDatabaseTier | null, environment: string, evidence: ManagedDatabaseReconciliationEvidence): ManagedDatabaseReconciliationReport {
    return {
      ...classifyManagedDatabase(evidence), evidence,
      tierUpdatedAt: tier?.updatedAt?.toISOString?.() || null,
      engine: tier?.engine || null,
      attachedServiceId: tier?.attachedServiceId || null,
      identity: { environment, activeGenerationId: tier?.activeGenerationId || null },
    };
  }

  private async fileSystems(): Promise<AwsFileSystem[]> {
    const result = await this.aws.run(["efs", "describe-file-systems", "--output", "json"]);
    return (JSON.parse(result.stdout || "{}") as { FileSystems?: AwsFileSystem[] }).FileSystems || [];
  }

  private selectFileSystem(fileSystems: AwsFileSystem[], tier: ProjectDatabaseTier, projectId: string, environment: string) {
    return fileSystems.find((item) => item.FileSystemId === tier.efsFileSystemId && this.owned(item.Tags, projectId, environment))
      || fileSystems.find((item) => this.owned(item.Tags, projectId, environment))
      || null;
  }

  private async accessPoint(fileSystemId: string, projectId: string, environment: string): Promise<AwsAccessPoint | null> {
    const result = await this.aws.run(["efs", "describe-access-points", "--file-system-id", fileSystemId, "--output", "json"]);
    const points = (JSON.parse(result.stdout || "{}") as { AccessPoints?: AwsAccessPoint[] }).AccessPoints || [];
    return points.find((item) => this.owned(item.Tags, projectId, environment)) || null;
  }

  private async secretPresent(projectId: string, environment: string) {
    try {
      const result = await this.aws.run(["secretsmanager", "describe-secret", "--secret-id", `deployguard/${projectId}/${environment}/database`, "--output", "json"]);
      const secret = JSON.parse(result.stdout || "{}") as { DeletedDate?: string; Tags?: Array<{ Key?: string; Value?: string }> };
      return !secret.DeletedDate && this.owned(secret.Tags, projectId, environment);
    } catch (error) {
      if (/ResourceNotFoundException|can't find the specified secret|not found/i.test(error instanceof Error ? error.message : String(error))) return false;
      throw error;
    }
  }

  private async terraformDatabaseAddresses(projectId: string, environment: string) {
    const bucket = this.config.get<string>("DEPLOYGUARD_TERRAFORM_STATE_BUCKET", "").trim();
    if (!bucket) throw new ServiceUnavailableException({ code: "DG_AWS_PROVIDER_FAILED", message: "Terraform state storage is unavailable for managed database admission.", stage: "managed_database_admission" });
    const directory = await mkdtemp(join(tmpdir(), "deployguard-db-admission-"));
    const output = join(directory, "terraform.tfstate");
    try {
      try {
        await this.aws.run(["s3api", "get-object", "--bucket", bucket, "--key", `projects/${projectId}/${environment}/runtime/terraform.tfstate`, output]);
      } catch (error) {
        if (/NoSuchKey|404|Not Found/i.test(error instanceof Error ? error.message : String(error))) return [];
        throw error;
      }
      return activeTerraformDatabaseAddresses(JSON.parse(await readFile(output, "utf8")) as { resources?: TerraformStateResource[] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private owned(tags: Array<{ Key?: string; Value?: string }> | undefined, projectId: string, environment: string) {
    const values = Object.fromEntries((tags || []).map((tag) => [tag.Key || "", tag.Value || ""]));
    return values.ManagedBy === "DeployGuard"
      && values.DeployGuardProjectId === projectId
      && values.Environment === environment
      && values.DeployGuardResource === "managed-database";
  }
}
