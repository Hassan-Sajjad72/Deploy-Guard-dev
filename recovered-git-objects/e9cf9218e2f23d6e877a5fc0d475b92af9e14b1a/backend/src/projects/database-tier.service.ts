import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { User } from "../users/user.entity";
import { UpdateDatabaseTierDto } from "./dto/update-database-tier.dto";
import { DeploymentContractService } from "./deployment-contract.service";
import { DatabaseTierProvider, DatabaseTierStatus, ProjectDatabaseTier } from "./project-database-tier.entity";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { ProjectsService } from "./projects.service";

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|host\.docker\.internal)$/i;

@Injectable()
export class DatabaseTierService {
  constructor(
    @InjectRepository(ProjectDatabaseTier) private readonly tiers: Repository<ProjectDatabaseTier>,
    @InjectRepository(ProjectEnvironmentVariable) private readonly environmentVariables: Repository<ProjectEnvironmentVariable>,
    private readonly projects: ProjectsService,
    private readonly contracts: DeploymentContractService,
    private readonly audit: AuditLogService
  ) {}

  async get(user: User, projectId: string) {
    await this.projects.getProjectEntityForView(user, projectId);
    const tier = await this.tiers.findOne({ where: { projectId } });
    return this.safe(tier);
  }

  async update(user: User, projectId: string, dto: UpdateDatabaseTierDto, req?: any) {
    await this.projects.getProjectEntityForManage(user, projectId);
    const contract = await this.contracts.getForProject(projectId);
    if (dto.provider === DatabaseTierProvider.NONE && contract?.databaseRequired) {
      throw new BadRequestException("Database setup cannot be skipped because repository analysis found a required database dependency.");
    }
    if (dto.provider === DatabaseTierProvider.EXTERNAL) {
      if (!dto.externalHost) throw new BadRequestException("External database host is required.");
      if (LOCAL_HOST.test(dto.externalHost.trim())) throw new BadRequestException("An ECS application cannot reach a database at localhost. Enter a reachable external database endpoint.");
    }
    const engine = dto.engine || (contract?.databaseEngine as "postgres" | "mysql" | null) || null;
    if (dto.provider === DatabaseTierProvider.MANAGED && !engine) {
      throw new BadRequestException("Choose PostgreSQL or MySQL for the managed database service.");
    }
    const existing = await this.tiers.findOne({ where: { projectId } });
    const internalHost = dto.provider === DatabaseTierProvider.MANAGED ? `db.project-${projectId}.deployguard.local` : null;
    const detectedDatabaseName = contract?.ecsPlan.database.databaseName || `app_${projectId.replace(/-/g, "").slice(0, 8)}`;
    const managedDatabaseUser = `dg_${projectId.replace(/-/g, "").slice(0, 12)}`;
    const tier = this.tiers.create({
      ...(existing || {}), projectId,
      requiredByDetection: Boolean(contract?.databaseRequired),
      provider: dto.provider,
      engine,
      status: dto.provider === DatabaseTierProvider.NONE ? DatabaseTierStatus.NOT_REQUIRED : DatabaseTierStatus.PENDING,
      externalHost: dto.provider === DatabaseTierProvider.EXTERNAL ? dto.externalHost!.trim() : null,
      externalPort: dto.provider === DatabaseTierProvider.EXTERNAL ? (dto.externalPort || (engine === "mysql" ? 3306 : 5432)) : null,
      internalHost,
      databaseName: dto.databaseName?.trim() || detectedDatabaseName,
      databaseUser: dto.provider === DatabaseTierProvider.MANAGED ? managedDatabaseUser : (dto.databaseUser?.trim() || null),
      persistenceEnabled: dto.provider === DatabaseTierProvider.MANAGED ? dto.persistenceEnabled !== false : false,
      backupEnabled: dto.provider === DatabaseTierProvider.MANAGED ? dto.backupEnabled !== false : false,
      lastError: null,
    });
    const saved = await this.tiers.save(tier);
    if (saved.provider === DatabaseTierProvider.MANAGED) {
      await this.environmentVariables.createQueryBuilder().update(ProjectEnvironmentVariable).set({
        isActive: false,
        supersededAt: new Date(),
        supersededReason: "Superseded by DeployGuard-managed database binding",
      }).where("project_id = :projectId", { projectId }).andWhere("key IN (:...keys)", {
        keys: ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DATABASE_URL"],
      }).execute();
    }
    await this.contracts.refreshForProject(projectId);
    await this.audit.record({ actorUser: user, action: "DATABASE_TIER_UPDATED", resourceType: "project", resourceId: projectId, status: "success", metadata: { provider: saved.provider, engine: saved.engine, persistenceEnabled: saved.persistenceEnabled }, req });
    return this.safe(saved);
  }

  private safe(tier: ProjectDatabaseTier | null) {
    if (!tier) return null;
    return {
      id: tier.id, projectId: tier.projectId, requiredByDetection: tier.requiredByDetection,
      provider: tier.provider, engine: tier.engine, status: tier.status,
      externalHost: tier.externalHost, externalPort: tier.externalPort,
      internalHost: tier.internalHost, databaseName: tier.databaseName, databaseUser: tier.databaseUser,
      persistenceEnabled: tier.persistenceEnabled, backupEnabled: tier.backupEnabled,
      efsConfigured: Boolean(tier.efsFileSystemId), credentialsConfigured: Boolean(tier.credentialsSecretArn),
      backupConfigured: Boolean(tier.backupPlanId), lastBackupAt: tier.lastBackupAt, lastRestoreAt: tier.lastRestoreAt,
      lastError: tier.lastError, updatedAt: tier.updatedAt,
    };
  }
}
