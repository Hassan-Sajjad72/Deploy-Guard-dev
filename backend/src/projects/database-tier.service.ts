import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { acquireProjectConfigurationAdvisoryLock } from "../infrastructure/database-service-binding.service";
import { User } from "../users/user.entity";
import { UpdateDatabaseTierDto } from "./dto/update-database-tier.dto";
import { DatabaseTierProvider, DatabaseTierStatus, ProjectDatabaseTier } from "./project-database-tier.entity";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { ProjectsService } from "./projects.service";
import { canonicalEnvironmentName } from "./canonical-environment";
import { ManagedDatabaseEngine, managedDatabaseProfile } from "./managed-database-engine";
import { SERVICE_ALIAS_GROUPS } from "./configuration-ownership";

@Injectable()
export class DatabaseTierService {
  constructor(
    @InjectRepository(ProjectDatabaseTier) private readonly tiers: Repository<ProjectDatabaseTier>,
    @InjectRepository(ProjectEnvironmentVariable) private readonly environmentVariables: Repository<ProjectEnvironmentVariable>,
    private readonly projects: ProjectsService,
    private readonly audit: AuditLogService,
    private readonly dataSource: DataSource,
  ) {}

  async get(user: User, projectId: string) {
    await this.projects.getProjectEntityForView(user, projectId);
    const tier = await this.tiers.findOne({ where: { projectId } });
    return this.safe(tier);
  }

  async update(user: User, projectId: string, dto: UpdateDatabaseTierDto, req?: any) {
    const project = await this.projects.getProjectEntityForManage(user, projectId);
    if (dto.provider === DatabaseTierProvider.EXTERNAL) {
      throw new BadRequestException("External databases are not part of the DeployGuard managed container database runtime.");
    }
    const saved = await this.dataSource.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager, projectId, canonicalEnvironmentName(project));
      const engine: ManagedDatabaseEngine | null = dto.provider === DatabaseTierProvider.MANAGED ? (dto.engine || "postgres") : null;
      const tiers = manager.getRepository(ProjectDatabaseTier);
      const environmentVariables = manager.getRepository(ProjectEnvironmentVariable);
      const existing = await tiers.findOne({ where: { projectId } });
      const established = existing?.provider === DatabaseTierProvider.MANAGED
        && Boolean(existing.efsFileSystemId || existing.credentialsSecretArn || existing.status === DatabaseTierStatus.READY);
      if (established && engine !== existing.engine) {
        throw new BadRequestException("The managed database engine is immutable after project persistence is established. Full project Destroy is required before selecting another engine.");
      }
      const internalHost = dto.provider === DatabaseTierProvider.MANAGED ? `db.project-${projectId}.deployguard.local` : null;
      const databaseName = `app_${projectId.replace(/-/g, "").slice(0, 8)}`;
      const managedDatabaseUser = `dg_${projectId.replace(/-/g, "").slice(0, 12)}`;
      const tier = tiers.create({
        ...(existing || {}), projectId,
        provider: dto.provider,
        engine,
        status: dto.provider === DatabaseTierProvider.NONE ? DatabaseTierStatus.NOT_REQUIRED : DatabaseTierStatus.PENDING,
        externalHost: dto.provider === DatabaseTierProvider.EXTERNAL ? dto.externalHost!.trim() : null,
        externalPort: dto.provider === DatabaseTierProvider.EXTERNAL ? (dto.externalPort || managedDatabaseProfile(engine)?.port || 0) : null,
        internalHost,
        databaseName: dto.databaseName?.trim() || databaseName,
        databaseUser: dto.provider === DatabaseTierProvider.MANAGED ? managedDatabaseUser : (dto.databaseUser?.trim() || null),
        persistenceEnabled: dto.provider === DatabaseTierProvider.MANAGED ? dto.persistenceEnabled !== false : false,
        // AWS Backup is not part of the active GitHub Actions contract.
        backupEnabled: false,
        lastError: null,
      });
      const current = await tiers.save(tier);
      if (current.provider === DatabaseTierProvider.MANAGED) {
        await environmentVariables.createQueryBuilder().update(ProjectEnvironmentVariable).set({
          isActive: false,
          supersededAt: new Date(),
          supersededReason: "Superseded by DeployGuard-managed database binding",
        }).where("project_id = :projectId", { projectId }).andWhere("key IN (:...keys)", {
          keys: [...new Set(SERVICE_ALIAS_GROUPS.filter((group) => group.service === current.engine).flatMap((group) => [...group.aliases]))],
        }).execute();
      }
      return current;
    });
    await this.audit.record({ actorUser: user, action: "DATABASE_TIER_UPDATED", resourceType: "project", resourceId: projectId, status: "success", metadata: { provider: saved.provider, engine: saved.engine, persistenceEnabled: saved.persistenceEnabled }, req });
    return this.safe(saved);
  }

  private safe(tier: ProjectDatabaseTier | null) {
    if (!tier) return null;
    return {
      id: tier.id, projectId: tier.projectId,
      provider: tier.provider, engine: tier.engine, status: tier.status,
      externalHost: tier.externalHost, externalPort: tier.externalPort,
      internalHost: tier.internalHost, databaseName: tier.databaseName, databaseUser: tier.databaseUser,
      persistenceEnabled: tier.persistenceEnabled, backupEnabled: tier.backupEnabled,
      efsConfigured: Boolean(tier.efsFileSystemId), credentialsConfigured: Boolean(tier.credentialsSecretArn),
      backupRequested: tier.backupEnabled,
      backupInfrastructureActive: Boolean(tier.backupPlanId),
      backupConfigured: Boolean(tier.backupPlanId),
      lastSuccessfulBackupAt: tier.lastBackupAt,
      recoverableRecoveryPoint: false,
      lastBackupAt: tier.lastBackupAt, lastRestoreAt: tier.lastRestoreAt,
      lastError: tier.lastError, updatedAt: tier.updatedAt,
    };
  }
}
