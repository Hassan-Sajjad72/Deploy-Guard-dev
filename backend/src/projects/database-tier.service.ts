import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { acquireProjectConfigurationAdvisoryLock } from "./project-configuration-lock";
import { User } from "../users/user.entity";
import { UpdateDatabaseTierDto } from "./dto/update-database-tier.dto";
import { DatabaseTierProvider, DatabaseTierStatus, ProjectDatabaseTier } from "./project-database-tier.entity";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { ProjectsService } from "./projects.service";
import { canonicalEnvironmentName } from "./canonical-environment";
import { isSupportedManagedDatabaseEngine, ManagedDatabaseEngine, managedDatabaseProfile } from "./managed-database-engine";
import { SERVICE_ALIAS_GROUPS } from "./configuration-ownership";
import { ProjectDeployableService } from "./project-deployable-service.entity";

@Injectable()
export class DatabaseTierService {
  constructor(
    @InjectRepository(ProjectDatabaseTier) private readonly tiers: Repository<ProjectDatabaseTier>,
    @InjectRepository(ProjectEnvironmentVariable) private readonly environmentVariables: Repository<ProjectEnvironmentVariable>,
    @InjectRepository(ProjectDeployableService) private readonly deployableServices: Repository<ProjectDeployableService>,
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
    if (dto.provider === DatabaseTierProvider.MANAGED && !isSupportedManagedDatabaseEngine(dto.engine)) {
      throw new BadRequestException("Select a supported managed database engine: PostgreSQL, MySQL, or MongoDB.");
    }
    const saved = await this.dataSource.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager, projectId, canonicalEnvironmentName(project));
      const engine: ManagedDatabaseEngine | null = dto.provider === DatabaseTierProvider.MANAGED ? dto.engine! : null;
      const tiers = manager.getRepository(ProjectDatabaseTier);
      const environmentVariables = manager.getRepository(ProjectEnvironmentVariable);
      const services = manager.getRepository(ProjectDeployableService);
      const configuredServices = await services.find({ where: { projectId }, order: { position: "ASC" } });
      if (!configuredServices.length) throw new BadRequestException("A managed database requires a deployable service.");
      const attachedServiceId = dto.provider === DatabaseTierProvider.MANAGED
        ? (dto.attachedServiceId || (configuredServices.length === 1 ? configuredServices[0].id : null))
        : null;
      if (dto.provider === DatabaseTierProvider.MANAGED && !attachedServiceId) throw new BadRequestException("Select the service that receives managed database credentials.");
      if (attachedServiceId && !configuredServices.some((service) => service.id === attachedServiceId)) throw new BadRequestException("The database attachment must reference a service in this project.");
      if (dto.provider === DatabaseTierProvider.MANAGED) {
        const conflictingAliases = [...new Set(SERVICE_ALIAS_GROUPS.filter((group) => group.service === engine).flatMap((group) => [...group.aliases]))];
        const conflicts = await environmentVariables.createQueryBuilder("variable")
          .where("variable.projectId = :projectId", { projectId })
          .andWhere("variable.serviceId = :attachedServiceId", { attachedServiceId })
          .andWhere("variable.isActive = true")
          .andWhere("variable.key IN (:...keys)", { keys: conflictingAliases })
          .orderBy("variable.key", "ASC")
          .getMany();
        if (conflicts.length) throw new BadRequestException(`Managed database conflicts with existing application ENV: ${conflicts.map((variable) => variable.key).join(", ")}. Remove these variables or keep the managed database disabled.`);
      }
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
        attachedServiceId,
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
      return current;
    });
    await this.audit.record({ actorUser: user, action: "DATABASE_TIER_UPDATED", resourceType: "project", resourceId: projectId, status: "success", metadata: { provider: saved.provider, engine: saved.engine, persistenceEnabled: saved.persistenceEnabled }, req });
    return this.safe(saved);
  }

  private safe(tier: ProjectDatabaseTier | null) {
    if (!tier) return null;
    return {
      id: tier.id, projectId: tier.projectId, attachedServiceId: tier.attachedServiceId,
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
