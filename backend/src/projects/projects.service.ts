import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, Not, Repository } from "typeorm";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { AuditLogService } from "../audit-log/audit-log.service";
import { User, UserRole } from "../users/user.entity";
import { CreateEnvVarDto } from "./dto/create-env-var.dto";
import { CreateProjectDto } from "./dto/create-project.dto";
import { UpdateBranchDto } from "./dto/update-branch.dto";
import { UpdateEnvVarDto } from "./dto/update-env-var.dto";
import { UpdateProjectDto } from "./dto/update-project.dto";
import { UpdateRepositoryDto } from "./dto/update-repository.dto";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { Project, ProjectStatus, ProjectVisibility } from "./project.entity";
import { UsersService } from "../users/users.service";
import { ProjectEnvironmentCryptoService } from "./project-environment-crypto.service";
import { BulkEnvVarsDto } from "./dto/bulk-env-vars.dto";
import { ProjectActivityService } from "./project-activity.service";
import { ProjectDatabaseTier, DatabaseTierProvider } from "./project-database-tier.entity";
import { classifyConfigurationVariable, isSecretConfigurationKey, normalizeConfigurationKey, partitionSubmittedEnvironmentVariables, RESERVED_VARIABLE_REGISTRY, reservedVariable, reservedVariableError, SERVICE_ALIAS_GROUPS } from "./configuration-ownership";
import { canonicalEnvironmentName } from "./canonical-environment";
import {
  acquireProjectConfigurationAdvisoryLock,
  DatabaseServiceBindingService,
} from "../infrastructure/database-service-binding.service";
import { GithubAppService } from "./github-app.service";
import { ProjectDeployableService } from "./project-deployable-service.entity";
import { normalizeServiceDirectory } from "./deployable-service-path";
import { DeployableServiceInputDto, UpdateDeployableServiceDto } from "./dto/deployable-service.dto";

type RequestInfo = { ip?: string; headers?: Record<string, string | string[] | undefined> };

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectEnvironmentVariable)
    private readonly envVarRepository: Repository<ProjectEnvironmentVariable>,
    @InjectRepository(ProjectDatabaseTier)
    private readonly databaseTierRepository: Repository<ProjectDatabaseTier>,
    @InjectRepository(ProjectDeployableService)
    private readonly deployableServices: Repository<ProjectDeployableService>,
    private readonly auditLogService: AuditLogService,
    private readonly usersService: UsersService,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly environmentCrypto: ProjectEnvironmentCryptoService,
    private readonly projectActivity: ProjectActivityService,
    private readonly githubApp: GithubAppService
  ) {}

  async githubConnectionStatus(user: User) {
    const repositories = this.githubApp.configured() ? await this.githubApp.listRepositories(user.id) : [];
    const availableInstallations = this.githubApp.configured() ? await this.githubApp.availableInstallations(user) : [];
    return {
      appConfigured: this.githubApp.configured(),
      connected: repositories.length > 0,
      installUrl: this.githubApp.statusUrl(),
      repositoryCount: repositories.length,
      availableInstallations,
      message: this.githubApp.configured() ? (repositories.length ? "DeployGuard GitHub App repository access is connected." : availableInstallations.length ? "Connect the existing GitHub App installation to this DeployGuard account." : "Install the DeployGuard GitHub App to select a repository.") : "DeployGuard GitHub App is not configured on the server.",
    };
  }

  async connectGithubInstallation(user: User, installationId: string) {
    const installation = await this.githubApp.connectInstallation(user, installationId);
    return { connected: true, installationId: installation.installationId, accountLogin: installation.accountLogin };
  }

  async listGithubRepositories(user: User) {
    const repositories = await this.githubApp.listRepositories(user.id);
    return repositories.map((repository) => ({
      id: String(repository.id || ""),
      fullName: String(repository.full_name || ""),
      name: String(repository.name || ""),
      description: typeof repository.description === "string" ? repository.description : null,
      private: Boolean(repository.private),
      defaultBranch: String(repository.default_branch || "main"),
      updatedAt: repository.updated_at || null,
      language: typeof repository.language === "string" ? repository.language : null,
      installationId: String(repository.installationId || ""),
    })).filter((repository) => repository.fullName);
  }

  async listGithubRepositoryBranches(user: User, repositoryFullName: string) {
    return (await this.inspectGithubRepository(user, repositoryFullName)).branches;
  }

  async listGithubRepositoryDirectories(user: User, repositoryIdentity: string, ref: string) {
    const fullName = this.normalizeRepositoryFullName(repositoryIdentity);
    const { token } = await this.githubApp.tokenForRepository(user.id, fullName);
    const commitResponse = await fetch(`https://api.github.com/repos/${fullName}/commits/${encodeURIComponent(ref)}`, { headers: this.githubHeaders(token) });
    if (!commitResponse.ok) this.throwGithubError(commitResponse, true);
    const commit = await commitResponse.json() as { sha?: string; commit?: { tree?: { sha?: string } } };
    const sourceSha = String(commit.sha || ""); const treeSha = String(commit.commit?.tree?.sha || "");
    if (!/^[0-9a-f]{40}$/i.test(sourceSha) || !/^[0-9a-f]{40}$/i.test(treeSha)) throw new BadRequestException("GitHub did not return an exact repository tree identity.");
    const treeResponse = await fetch(`https://api.github.com/repos/${fullName}/git/trees/${treeSha}?recursive=1`, { headers: this.githubHeaders(token) });
    if (!treeResponse.ok) this.throwGithubError(treeResponse, true);
    const tree = await treeResponse.json() as { truncated?: boolean; tree?: Array<{ path?: string; type?: string }> };
    if (tree.truncated) throw new BadRequestException("Repository tree is too large to browse safely. Enter the repository-relative service directory explicitly.");
    const directories = [".", ...(tree.tree || []).filter((item) => item.type === "tree" && item.path).map((item) => normalizeServiceDirectory(item.path!))];
    return { sourceSha, directories: [...new Set(directories)].slice(0, 5_000) };
  }

  async inspectGithubRepository(user: User, repositoryIdentity: string) {
    const fullName = this.normalizeRepositoryFullName(repositoryIdentity);
    const { token, installationId } = await this.githubApp.tokenForRepository(user.id, fullName);
    const metadataResponse = await fetch(`https://api.github.com/repos/${fullName}`, { headers: this.githubHeaders(token) });
    if (!metadataResponse.ok) this.throwGithubError(metadataResponse, Boolean(token));
    const metadata = await metadataResponse.json() as Record<string, unknown>;
    const branchesResponse = await fetch(`https://api.github.com/repos/${fullName}/branches?per_page=100`, { headers: this.githubHeaders(token) });
    if (!branchesResponse.ok) this.throwGithubError(branchesResponse, Boolean(token));
    const branches = ((await branchesResponse.json()) as Array<{ name?: string }>).map((branch) => branch.name).filter((name): name is string => Boolean(name));
    if (!branches.length) throw new BadRequestException("This repository/branch is empty and cannot be analyzed.");
    const defaultBranch = String(metadata.default_branch || branches[0]);
    if (!branches.includes(defaultBranch)) branches.unshift(defaultBranch);
    return {
      id: String(metadata.id || ""),
      fullName: String(metadata.full_name || fullName),
      name: String(metadata.name || fullName.split("/")[1]),
      description: typeof metadata.description === "string" ? metadata.description : null,
      url: String(metadata.html_url || `https://github.com/${fullName}`),
      private: Boolean(metadata.private),
      defaultBranch,
      branches,
      language: typeof metadata.language === "string" ? metadata.language : null,
      installationId,
    };
  }

  async listProjects(user: User) {
    const where =
      user.role === UserRole.ADMIN
        ? { status: Not(ProjectStatus.ARCHIVED) }
        : user.role === UserRole.DEVELOPER
          ? { ownerUserId: user.id, status: Not(ProjectStatus.ARCHIVED) }
          : [
              { ownerUserId: user.id, status: Not(ProjectStatus.ARCHIVED) },
              {
                visibility: ProjectVisibility.WORKSPACE,
                status: Not(ProjectStatus.ARCHIVED),
              },
            ];

    const [projects, activities] = await Promise.all([
      this.projectRepository.find({ where, relations: { services: true } }),
      this.projectActivity.forUser(user.id),
    ]);
    const byProject = new Map(activities.map((activity) => [activity.projectId, activity]));
    return projects
      .sort((left, right) => {
        const leftActivity = byProject.get(left.id);
        const rightActivity = byProject.get(right.id);
        if (Boolean(leftActivity?.pinned) !== Boolean(rightActivity?.pinned)) return leftActivity?.pinned ? -1 : 1;
        const leftTime = leftActivity?.lastMeaningfulActivityAt?.getTime() || left.createdAt.getTime();
        const rightTime = rightActivity?.lastMeaningfulActivityAt?.getTime() || right.createdAt.getTime();
        return rightTime - leftTime || right.createdAt.getTime() - left.createdAt.getTime();
      })
      .map((project) => this.toProjectResponse(project, user, byProject.get(project.id)));
  }

  async createProject(user: User, dto: CreateProjectDto, req?: RequestInfo) {
    this.assertCanWrite(user);
    const repositoryFullName = dto.repositoryFullName
      ? this.normalizeRepositoryFullName(dto.repositoryFullName)
      : this.parseGitHubRepositoryFullName(dto.repositoryUrl || "");
    const metadata = await this.inspectGithubRepository(user, repositoryFullName);
    const targetBranch = dto.targetBranch || metadata.defaultBranch;
    const environmentName = dto.environmentName || "dev";
    await this.assertGithubBranchHasCommit(user, metadata.fullName, targetBranch);
    const creation = await this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-create:${user.id}`]);
      const repository = manager.getRepository(Project);
      const existing = await repository.createQueryBuilder("project")
        .where("project.ownerUserId = :userId", { userId: user.id })
        .andWhere("(project.githubRepositoryId = :githubRepositoryId OR lower(project.repositoryFullName) = lower(:repositoryFullName))", { githubRepositoryId: metadata.id || null, repositoryFullName: metadata.fullName })
        .andWhere("project.targetBranch = :targetBranch", { targetBranch })
        .andWhere("project.environmentName = :environmentName", { environmentName })
        .andWhere("project.status <> :archived", { archived: ProjectStatus.ARCHIVED })
        .andWhere("project.archivedAt IS NULL")
        .getOne();
      if (existing) {
        throw new ConflictException({
          code: "EXISTING_PROJECT",
          message: "This repository already has an existing project for the selected branch and environment.",
          existingProject: this.toProjectResponse(existing, user),
          repositoryFullName: metadata.fullName,
          targetBranch,
          environmentName,
        });
      }
      const configuredServices = this.normalizeServices(dto.services);
      const project = repository.create({
        ownerUserId: user.id,
        name: String(dto.name || metadata.name).trim(),
        description: dto.description !== undefined ? dto.description.trim() || null : metadata.description,
        repositoryUrl: this.normalizeRepositoryUrl(metadata.url),
        repositoryProvider: "github",
        githubRepositoryId: metadata.id || null,
        githubInstallationId: metadata.installationId,
        repositoryFullName: metadata.fullName,
        targetBranch,
        environmentName,
        visibility: dto.visibility || ProjectVisibility.PRIVATE,
        status: ProjectStatus.CREATED,
      });
      const saved = await repository.save(project);
      const services = configuredServices.map((service, position) => manager.getRepository(ProjectDeployableService).create({
        projectId: saved.id,
        name: service.name,
        serviceDirectory: service.serviceDirectory,
        position,
      }));
      await manager.getRepository(ProjectDeployableService).save(services);
      saved.services = services;
      return { project: saved };
    });
    const savedProject = creation.project;

    await this.auditLogService.record({
      actorUser: user,
      action: "PROJECT_CREATED",
      resourceType: "project",
      resourceId: savedProject.id,
      status: "success",
      metadata: {
        projectId: savedProject.id,
        projectName: savedProject.name,
        repositoryFullName: savedProject.repositoryFullName,
        targetBranch: savedProject.targetBranch,
        githubRepositoryId: savedProject.githubRepositoryId,
        environmentName: savedProject.environmentName,
      },
      req: req as never,
    });
    await this.projectActivity.recordUserAction(user.id, savedProject.id, "project_created", {
      route: `/projects/${savedProject.id}/requirements`,
      section: "requirements",
    });

    return this.toProjectResponse(savedProject, user);
  }

  async getProjectForView(user: User, projectId: string) {
    const project = await this.findProject(projectId);
    this.assertCanView(user, project);

    return this.toProjectResponse(project, user);
  }

  async listDeployableServices(user: User, projectId: string) {
    const project = await this.findProject(projectId);
    this.assertCanView(user, project);
    return this.deployableServices.find({ where: { projectId }, order: { position: "ASC", createdAt: "ASC" } });
  }

  async createDeployableService(user: User, projectId: string, dto: DeployableServiceInputDto) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);
    const services = await this.deployableServices.find({ where: { projectId }, order: { position: "ASC" } });
    const normalized = this.normalizeServices([...services.map((service) => ({ name: service.name, serviceDirectory: service.serviceDirectory })), dto]);
    const service = this.deployableServices.create({ projectId, ...normalized[normalized.length - 1], position: services.length });
    return this.deployableServices.save(service);
  }

  async updateDeployableService(user: User, projectId: string, serviceId: string, dto: UpdateDeployableServiceDto) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);
    const service = await this.deployableServices.findOne({ where: { id: serviceId, projectId } });
    if (!service) throw new NotFoundException("Deployable service not found");
    const all = await this.deployableServices.find({ where: { projectId }, order: { position: "ASC" } });
    if (dto.position !== undefined && dto.position >= all.length) throw new BadRequestException("Service position is outside the configured service set.");
    const candidate = all.map((item) => ({
      name: item.id === serviceId && dto.name !== undefined ? dto.name : item.name,
      serviceDirectory: item.id === serviceId && dto.serviceDirectory !== undefined ? dto.serviceDirectory : item.serviceDirectory,
    }));
    const normalized = this.normalizeServices(candidate)[all.findIndex((item) => item.id === serviceId)];
    service.name = normalized.name;
    service.serviceDirectory = normalized.serviceDirectory;
    if (dto.position !== undefined && dto.position !== service.position) {
      const other = await this.deployableServices.findOne({ where: { projectId, position: dto.position } });
      if (other) { const old = service.position; service.position = -1; await this.deployableServices.save(service); other.position = old; await this.deployableServices.save(other); }
      service.position = dto.position;
    }
    return this.deployableServices.save(service);
  }

  async deleteDeployableService(user: User, projectId: string, serviceId: string) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);
    const services = await this.deployableServices.find({ where: { projectId }, order: { position: "ASC" } });
    if (services.length <= 1) throw new BadRequestException("A deployable project must retain at least one service.");
    const service = services.find((item) => item.id === serviceId);
    if (!service) throw new NotFoundException("Deployable service not found");
    const attached = await this.databaseTierRepository.findOne({ where: { projectId, attachedServiceId: serviceId } });
    if (attached) throw new BadRequestException("Move or disable the managed database before removing its attached service.");
    await this.deployableServices.remove(service);
    const remaining = services.filter((item) => item.id !== serviceId);
    for (const [position, item] of remaining.entries()) { item.position = position; await this.deployableServices.save(item); }
  }

  async getProjectEntityForView(user: User, projectId: string) {
    const project = await this.findProject(projectId);
    this.assertCanView(user, project);

    return project;
  }

  async getProjectEntityForManage(user: User, projectId: string) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);

    return project;
  }

  async updateProject(
    user: User,
    projectId: string,
    dto: UpdateProjectDto,
    req?: RequestInfo
  ) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);
    const persist = async (target: Project, repository: Repository<Project>, manager?: EntityManager) => {
      this.applyProjectUpdate(target, dto);
      return repository.save(target);
    };

    const savedProject = await persist(project, this.projectRepository);

    await this.auditLogService.record({
      actorUser: user,
      action: "PROJECT_UPDATED",
      resourceType: "project",
      resourceId: savedProject.id,
      status: "success",
      metadata: {
        projectId: savedProject.id,
        projectName: savedProject.name,
      },
      req: req as never,
    });

    return this.toProjectResponse(savedProject, user);
  }

  async archiveProject(user: User, projectId: string, req?: RequestInfo) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);

    project.status = ProjectStatus.ARCHIVED;
    project.archivedAt = new Date();
    await this.projectRepository.save(project);

    await this.auditLogService.record({
      actorUser: user,
      action: "PROJECT_ARCHIVED",
      resourceType: "project",
      resourceId: project.id,
      status: "success",
      metadata: {
        projectId: project.id,
        projectName: project.name,
      },
      req: req as never,
    });
  }

  async updateRepository(
    user: User,
    projectId: string,
    dto: UpdateRepositoryDto,
    req?: RequestInfo
  ) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);
    const metadata = await this.inspectGithubRepository(user, dto.repositoryUrl);
    const nextBranch = metadata.branches.includes(project.targetBranch) ? project.targetBranch : metadata.defaultBranch;
    await this.assertProjectIdentityAvailable(project.ownerUserId, metadata.id || null, metadata.fullName, nextBranch, project.environmentName || "dev", project.id);
    const savedProject = await this.dataSource.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager, projectId, canonicalEnvironmentName(project));
      const repository = manager.getRepository(Project);
      const current = await repository.findOne({ where: { id: projectId } });
      if (!current || current.status === ProjectStatus.ARCHIVED) throw new NotFoundException("Project not found");
      this.assertCanManage(user, current);
      current.repositoryUrl = this.normalizeRepositoryUrl(metadata.url);
      current.githubRepositoryId = metadata.id || null;
      current.repositoryFullName = metadata.fullName;
      current.repositoryProvider = "github";
      current.targetBranch = nextBranch;
      current.status = ProjectStatus.CONFIGURED;
      return repository.save(current);
    });

    await this.auditLogService.record({
      actorUser: user,
      action: "PROJECT_REPOSITORY_LINKED",
      resourceType: "project",
      resourceId: savedProject.id,
      status: "success",
      metadata: {
        projectId: savedProject.id,
        projectName: savedProject.name,
        repositoryFullName: savedProject.repositoryFullName,
      },
      req: req as never,
    });

    return this.toProjectResponse(savedProject, user);
  }

  async getBranches(user: User, projectId: string) {
    const project = await this.findProject(projectId);
    this.assertCanView(user, project);

    if (!project.repositoryFullName) {
      throw new BadRequestException("Project repository is not linked");
    }

    return (await this.inspectGithubRepository(user, project.repositoryFullName)).branches;
  }

  async updateBranch(
    user: User,
    projectId: string,
    dto: UpdateBranchDto,
    req?: RequestInfo
  ) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);
    const details = await this.inspectGithubRepository(user, project.repositoryFullName);
    await this.assertGithubBranchHasCommit(user, details.fullName, dto.targetBranch);
    await this.assertProjectIdentityAvailable(project.ownerUserId, details.id || project.githubRepositoryId, details.fullName, dto.targetBranch, project.environmentName || "dev", project.id);
    const savedProject = await this.dataSource.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager, projectId, canonicalEnvironmentName(project));
      const repository = manager.getRepository(Project);
      const current = await repository.findOne({ where: { id: projectId } });
      if (!current || current.status === ProjectStatus.ARCHIVED) throw new NotFoundException("Project not found");
      this.assertCanManage(user, current);
      current.targetBranch = dto.targetBranch;
      current.status = ProjectStatus.CONFIGURED;
      return repository.save(current);
    });

    await this.auditLogService.record({
      actorUser: user,
      action: "PROJECT_BRANCH_UPDATED",
      resourceType: "project",
      resourceId: savedProject.id,
      status: "success",
      metadata: {
        projectId: savedProject.id,
        projectName: savedProject.name,
        targetBranch: savedProject.targetBranch,
      },
      req: req as never,
    });

    return this.toProjectResponse(savedProject, user);
  }

  async listEnvVars(user: User, projectId: string, requestedServiceId?: string) {
    const project = await this.findProject(projectId);
    this.assertCanView(user, project);
    await this.encryptLegacyEnvironmentValues(project.id);
    const service = await this.requireService(project.id, requestedServiceId);
    const variables = await this.envVarRepository.find({
      where: { projectId: project.id, serviceId: service.id, environment: canonicalEnvironmentName(project), isActive: true },
      order: { key: "ASC" },
    });

    return variables.map((variable) => this.toEnvVarResponse(variable));
  }

  async getEnvVarSetup(user: User, projectId: string, serviceId?: string) {
    const project = await this.findProject(projectId);
    this.assertCanView(user, project);
    const [variables, tier] = await Promise.all([
      this.listEnvVars(user, projectId, serviceId),
      this.databaseTierRepository.findOne({ where: { projectId } }),
    ]);
    const managedByKey = new Map<string, Record<string, unknown>>();
    for (const variable of variables.filter((item) => item.protected || ["platform", "managed_service", "external_service"].includes(item.owner))) {
      const definition = reservedVariable(variable.key);
      managedByKey.set(variable.key, { ...variable, category: definition?.category || "infrastructure_generated", managedBy: "DeployGuard", valueVisible: false });
    }
    return {
      variables: variables.filter((item) => !managedByKey.has(item.key)),
      managedVariables: [...managedByKey.values()].sort((left, right) => String(left.key).localeCompare(String(right.key))),
      reservedVariables: [
        ...RESERVED_VARIABLE_REGISTRY,
        ...SERVICE_ALIAS_GROUPS.flatMap((group) => group.aliases.map((key) => reservedVariable(key, group.service)!)),
      ].filter((item, index, items) => items.findIndex((candidate) => candidate.key === item.key) === index),
      missingVariables: [],
      configuration: { databaseProvider: tier?.provider || DatabaseTierProvider.NONE, attachedServiceId: tier?.attachedServiceId || null },
    };
  }

  async createEnvVar(
    user: User,
    projectId: string,
    dto: CreateEnvVarDto,
    req?: RequestInfo,
    requestedServiceId?: string,
  ) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);
    const key = normalizeConfigurationKey(dto.key);
    const environment = canonicalEnvironmentName(project);
    const service = await this.requireService(project.id, requestedServiceId);
    const result = await this.dataSource.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager, project.id, environment);
      const ignoredVariableNames = await this.ignoredEnvironmentVariableNames(project.id, [key], manager);
      if (ignoredVariableNames.length) return { variable: null, ignoredVariableNames };
      await this.assertEnvKeyAvailable(project.id, service.id, key, undefined, manager);
      const defaults = this.environmentDefaults(key);
      const repository = manager.getRepository(ProjectEnvironmentVariable);
      const encryptedValue = this.environmentCrypto.encrypt(dto.value);
      const variable = repository.create({
        projectId: project.id,
        serviceId: service.id,
        key,
        normalizedKey: key,
        value: encryptedValue,
        isSecret: dto.isSecret ?? defaults.isSecret,
        scope: dto.scope || defaults.scope,
        isRequired: false,
        environment,
        detectedSource: dto.detectedSource || defaults.detectedSource,
        owner: "user_optional",
        source: dto.detectedSource || defaults.detectedSource || "developer_mode",
        protected: false,
        serviceBindingId: null,
        detectedReference: dto.detectedSource || defaults.detectedSource || null,
        repositoryDefault: null,
        supersededBy: null,
        configurationFingerprint: this.configurationFingerprint({ projectId: project.id, key, scope: dto.scope || defaults.scope, environment, encryptedValue }),
        isActive: true,
        supersededAt: null,
        supersededReason: null,
        appliedAt: null,
        encryptionVersion: 1,
      });
      const saved = await repository.save(variable);
      return { variable: saved, ignoredVariableNames: [] as string[] };
    });

    await this.auditLogService.record({
      actorUser: user,
      action: "PROJECT_ENV_CREATED",
      resourceType: "project_env",
      resourceId: result.variable?.id || project.id,
      status: "success",
      metadata: {
        projectId: project.id,
        projectName: project.name,
        ...(result.variable ? { key: result.variable.key, isSecret: result.variable.isSecret } : { ignoredVariableNames: result.ignoredVariableNames }),
      },
      req: req as never,
    });

    return { variable: result.variable ? this.toEnvVarResponse(result.variable) : null, ignoredVariableNames: result.ignoredVariableNames };
  }

  async updateEnvVar(
    user: User,
    projectId: string,
    envId: string,
    dto: UpdateEnvVarDto,
    req?: RequestInfo,
    requestedServiceId?: string,
  ) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);
    const environment = canonicalEnvironmentName(project);
    const service = await this.requireService(project.id, requestedServiceId);
    const result = await this.dataSource.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager, project.id, environment);
      const variable = await this.findEnvVar(project.id, service.id, envId, manager);
      this.assertVariableMutable(variable);
      const submittedKey = normalizeConfigurationKey(dto.key || variable.key);
      const ignoredVariableNames = await this.ignoredEnvironmentVariableNames(project.id, [submittedKey], manager);
      if (ignoredVariableNames.length) return { variable: null, ignoredVariableNames };
      if (dto.key && submittedKey !== variable.key) {
        const key = submittedKey;
        await this.assertEnvKeyAvailable(project.id, service.id, key, variable.id, manager);
        variable.key = key;
        variable.normalizedKey = key;
      }
      if (dto.value !== undefined) {
        variable.value = this.environmentCrypto.encrypt(dto.value);
        variable.encryptionVersion = 1;
      }
      if (dto.isSecret !== undefined) variable.isSecret = dto.isSecret;
      if (dto.scope !== undefined) variable.scope = dto.scope;
      variable.isRequired = false;
      variable.environment = environment;
      if (dto.detectedSource !== undefined) variable.detectedSource = dto.detectedSource;
      variable.owner = "user_optional";
      variable.source = dto.detectedSource || variable.source || "developer_mode";
      variable.protected = false;
      variable.serviceBindingId = null;
      variable.supersededBy = null;
      variable.isActive = true;
      variable.supersededAt = null;
      variable.supersededReason = null;
      variable.appliedAt = null;
      variable.configurationFingerprint = this.configurationFingerprint({ projectId: project.id, key: variable.key, scope: variable.scope, environment: variable.environment, encryptedValue: variable.value });
      const saved = await manager.getRepository(ProjectEnvironmentVariable).save(variable);
      return { variable: saved, ignoredVariableNames: [] as string[] };
    });

    await this.auditLogService.record({
      actorUser: user,
      action: "PROJECT_ENV_UPDATED",
      resourceType: "project_env",
      resourceId: result.variable?.id || project.id,
      status: "success",
      metadata: {
        projectId: project.id,
        projectName: project.name,
        ...(result.variable ? { key: result.variable.key, isSecret: result.variable.isSecret } : { ignoredVariableNames: result.ignoredVariableNames }),
      },
      req: req as never,
    });

    return { variable: result.variable ? this.toEnvVarResponse(result.variable) : null, ignoredVariableNames: result.ignoredVariableNames };
  }

  async bulkUpsertEnvVars(
    user: User,
    projectId: string,
    dto: BulkEnvVarsDto,
    req?: RequestInfo,
    requestedServiceId?: string,
  ) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);
    const environment = canonicalEnvironmentName(project);
    const service = await this.requireService(project.id, requestedServiceId);
    const normalized = dto.variables.map((item) => ({ ...item, key: item.key.trim().toUpperCase() }));
    const result = await this.dataSource.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager, projectId, environment);
      const repository = manager.getRepository(ProjectEnvironmentVariable);
      const ignoredVariableNames = await this.ignoredEnvironmentVariableNames(projectId, normalized.map((item) => item.key), manager);
      const { accepted } = partitionSubmittedEnvironmentVariables(normalized, { repositoryOwnedKeys: new Set(ignoredVariableNames) });
      const duplicateKeys = accepted.map((item) => item.key).filter((key, index, keys) => keys.indexOf(key) !== index);
      if (duplicateKeys.length) throw new BadRequestException(`Duplicate environment variable keys: ${[...new Set(duplicateKeys)].join(", ")}`);
      const existing = await repository.find({ where: { projectId, serviceId: service.id, environment } });
      const byKey = new Map(existing.map((item) => [item.key, item]));
      const rows: ProjectEnvironmentVariable[] = [];
      for (const item of accepted) {
        const defaults = this.environmentDefaults(item.key);
        const variable = byKey.get(item.key) || repository.create({ projectId, serviceId: service.id, key: item.key });
        const encryptedValue = this.environmentCrypto.encrypt(item.value);
        variable.key = item.key;
        variable.normalizedKey = item.key;
        variable.value = encryptedValue;
        variable.isSecret = item.isSecret ?? defaults.isSecret;
        variable.scope = item.scope || defaults.scope;
        variable.isRequired = false;
        variable.environment = environment;
        variable.detectedSource = item.detectedSource || defaults.detectedSource;
        variable.owner = "user_optional";
        variable.source = item.detectedSource || defaults.detectedSource || "developer_mode";
        variable.protected = false;
        variable.serviceBindingId = null;
        variable.detectedReference = item.detectedSource || defaults.detectedSource || null;
        variable.repositoryDefault = null;
        variable.supersededBy = null;
        variable.isActive = true;
        variable.supersededAt = null;
        variable.supersededReason = null;
        variable.appliedAt = null;
        variable.encryptionVersion = 1;
        variable.configurationFingerprint = this.configurationFingerprint({ projectId, key: item.key, scope: variable.scope, environment: variable.environment, encryptedValue });
        rows.push(await repository.save(variable));
      }
      return { rows, ignoredVariableNames };
    });
    await this.auditLogService.record({
      actorUser: user,
      action: "PROJECT_ENV_BULK_UPSERTED",
      resourceType: "project",
      resourceId: projectId,
      status: "success",
      metadata: { projectId, projectName: project.name, keys: result.rows.map((item) => item.key), count: result.rows.length, ignoredVariableNames: result.ignoredVariableNames },
      req: req as never,
    });
    return { variables: result.rows.map((item) => this.toEnvVarResponse(item)), ignoredVariableNames: result.ignoredVariableNames };
  }

  async deleteEnvVar(user: User, projectId: string, envId: string, req?: RequestInfo, requestedServiceId?: string) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);
    const service = await this.requireService(project.id, requestedServiceId);
    const variable = await this.dataSource.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager, project.id, canonicalEnvironmentName(project));
      const current = await this.findEnvVar(project.id, service.id, envId, manager);
      this.assertVariableMutable(current);
      await manager.getRepository(ProjectEnvironmentVariable).remove(current);
      return current;
    });

    await this.auditLogService.record({
      actorUser: user,
      action: "PROJECT_ENV_DELETED",
      resourceType: "project_env",
      resourceId: envId,
      status: "success",
      metadata: {
        projectId: project.id,
        projectName: project.name,
        key: variable.key,
        isSecret: variable.isSecret,
      },
      req: req as never,
    });
  }

  private async findProject(projectId: string): Promise<Project> {
    const project = await this.projectRepository.findOne({ where: { id: projectId }, relations: { services: true } });

    if (!project || project.status === ProjectStatus.ARCHIVED) {
      throw new NotFoundException("Project not found");
    }

    return project;
  }

  private async findEnvVar(projectId: string, serviceId: string, envId: string, manager?: EntityManager) {
    const variable = await (manager?.getRepository(ProjectEnvironmentVariable) || this.envVarRepository).findOne({
      where: { id: envId, projectId, serviceId },
      select: {
        id: true,
        projectId: true,
        serviceId: true,
        key: true,
      value: true,
      isSecret: true,
      scope: true,
      isRequired: true,
      environment: true,
      detectedSource: true,
      owner: true,
      isActive: true,
      supersededAt: true,
      supersededReason: true,
      appliedAt: true,
      encryptionVersion: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!variable) {
      throw new NotFoundException("Environment variable not found");
    }

    return variable;
  }

  private assertCanWrite(user: User) {
    if (user.role === UserRole.READONLY) {
      throw new ForbiddenException("Insufficient permissions");
    }
  }

  private assertCanView(user: User, project: Project) {
    if (user.role === UserRole.ADMIN) {
      return;
    }

    if (project.ownerUserId === user.id) {
      return;
    }

    if (
      user.role === UserRole.READONLY &&
      project.visibility === ProjectVisibility.WORKSPACE
    ) {
      return;
    }

    throw new ForbiddenException("Insufficient permissions");
  }

  private assertCanManage(user: User, project: Project) {
    this.assertCanWrite(user);

    if (project.ownerUserId === user.id) {
      return;
    }

    throw new ForbiddenException("Insufficient permissions");
  }

  private async assertEnvKeyAvailable(
    projectId: string,
    serviceId: string,
    key: string,
    currentEnvId?: string,
    manager?: EntityManager,
  ) {
    const existing = await (manager?.getRepository(ProjectEnvironmentVariable) || this.envVarRepository).findOne({ where: { projectId, serviceId, normalizedKey: key } });

    if (existing && existing.id !== currentEnvId) {
      throw new ConflictException("Environment variable key already exists");
    }
  }

  private async assertProjectIdentityAvailable(ownerUserId: number, githubRepositoryId: string | null, repositoryFullName: string, targetBranch: string, environmentName: string, excludeProjectId?: string) {
    const query = this.projectRepository.createQueryBuilder("project")
      .where("project.ownerUserId = :ownerUserId", { ownerUserId })
      .andWhere("(project.githubRepositoryId = :githubRepositoryId OR lower(project.repositoryFullName) = lower(:repositoryFullName))", { githubRepositoryId, repositoryFullName })
      .andWhere("project.targetBranch = :targetBranch", { targetBranch })
      .andWhere("project.environmentName = :environmentName", { environmentName })
      .andWhere("project.status <> :archived", { archived: ProjectStatus.ARCHIVED })
      .andWhere("project.archivedAt IS NULL");
    if (excludeProjectId) query.andWhere("project.id <> :excludeProjectId", { excludeProjectId });
    const existing = await query.getOne();
    if (existing) throw new ConflictException({ code: "EXISTING_PROJECT", message: "This repository already has an existing project for the selected branch and environment.", existingProjectId: existing.id });
  }

  private parseGitHubRepositoryFullName(repositoryUrl: string): string {
    return this.normalizeRepositoryFullName(repositoryUrl);
  }

  private normalizeRepositoryFullName(value: string): string {
    const raw = value.trim();
    if (/^https?:\/\//i.test(raw) && !/^https:\/\/github\.com\//i.test(raw)) throw new BadRequestException("Repository must be a GitHub URL or owner/repository.");
    const normalized = raw.replace(/^https:\/\/github\.com\//i, "").replace(/\.git\/?$/, "").replace(/\/$/, "");
    if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) throw new BadRequestException("Invalid GitHub repository");
    return normalized;
  }

  private async requireGithubToken(user: User): Promise<string> {
    const token = await this.usersService.getGithubAccessToken(user.id);
    if (!token) throw new BadRequestException("Reconnect with GitHub to grant repository access.");
    return token;
  }

  private throwGithubError(response: Response, authenticated: boolean): never {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (response.status === 401) throw new BadRequestException("GitHub access expired or was revoked. Reconnect GitHub and try again.");
    if (response.status === 403 && remaining === "0") throw new BadRequestException("GitHub API rate limit reached. Wait for the rate-limit window to reset, then retry.");
    if (response.status === 403) throw new BadRequestException("GitHub denied repository access. Reconnect GitHub with repository permission.");
    if (response.status === 404 && authenticated) throw new BadRequestException("Repository not found or the connected GitHub account does not have access to this private repository.");
    if (response.status === 404) throw new BadRequestException("Repository not found. Private repositories require a connected GitHub account with access.");
    if (response.status === 409) throw new BadRequestException("This repository/branch is empty and cannot be analyzed.");
    throw new BadRequestException(`GitHub repository request failed with status ${response.status}.`);
  }

  private async assertGithubBranchHasCommit(user: User, repositoryFullName: string, branch: string) {
    const { token } = await this.githubApp.tokenForRepository(user.id, repositoryFullName);
    const response = await fetch(`https://api.github.com/repos/${repositoryFullName}/commits/${encodeURIComponent(branch)}`, { headers: this.githubHeaders(token) });
    if (response.status === 409) throw new BadRequestException("This repository/branch is empty and cannot be analyzed.");
    if (response.status === 404) throw new BadRequestException(`Branch '${branch}' was not found in this repository.`);
    if (!response.ok) this.throwGithubError(response, Boolean(token));
  }

  async ensureDeployguardWorkflow(user: User, projectId: string) {
    const project = await this.getProjectEntityForView(user, projectId);
    if (!project.repositoryFullName) throw new BadRequestException("Project repository is not linked.");
    const workflow = await this.githubApp.ensureWorkflow(user.id, project.repositoryFullName, project.targetBranch, project.githubInstallationId);
    if (project.githubInstallationId !== workflow.installationId) {
      project.githubInstallationId = workflow.installationId;
      await this.projectRepository.save(project);
    }
    return workflow;
  }

  private githubHeaders(token?: string | null) {
    return {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "User-Agent": "DeployGuard",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private normalizeRepositoryUrl(repositoryUrl: string): string {
    return repositoryUrl.trim().replace(/\/$/, "");
  }

  private toProjectResponse(project: Project, user: User, activity?: { lastViewedAt: Date | null; lastUserActionAt: Date | null; lastMeaningfulActivityAt: Date | null; lastPipelineActivityAt: Date | null; lastRoute: string | null; lastSection: string | null; lastActionType: string | null; pinned: boolean }) {
    return {
      id: project.id,
      ownerUserId: String(project.ownerUserId),
      name: project.name,
      description: project.description,
      repositoryUrl: project.repositoryUrl,
      repositoryProvider: project.repositoryProvider,
      githubRepositoryId: project.githubRepositoryId,
      githubInstallationId: project.githubInstallationId,
      repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch,
      environmentName: project.environmentName || "dev",
      services: (project.services || []).sort((left, right) => left.position - right.position).map((service) => ({ id: service.id, name: service.name, serviceDirectory: service.serviceDirectory, position: service.position })),
      status: project.status,
      visibility: project.visibility,
      canManage:
        project.ownerUserId === user.id &&
        [UserRole.ADMIN, UserRole.DEVELOPER].includes(user.role),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      activity: activity ? {
        lastViewedAt: activity.lastViewedAt,
        lastUserActionAt: activity.lastUserActionAt,
        lastMeaningfulActivityAt: activity.lastMeaningfulActivityAt,
        lastPipelineActivityAt: activity.lastPipelineActivityAt,
        lastRoute: activity.lastRoute,
        lastSection: activity.lastSection,
        lastActionType: activity.lastActionType,
        pinned: activity.pinned,
      } : null,
    };
  }

  private toEnvVarResponse(variable: ProjectEnvironmentVariable) {
    return {
      id: variable.id,
      serviceId: variable.serviceId,
      key: variable.key,
      isSecret: variable.isSecret,
      scope: variable.scope || "runtime",
      isRequired: Boolean(variable.isRequired),
      environment: variable.environment || "dev",
      detectedSource: variable.detectedSource || null,
      owner: variable.owner || "user_optional",
      source: variable.source || variable.detectedSource || "user",
      protected: Boolean(variable.protected),
      normalizedKey: variable.normalizedKey || variable.key,
      serviceBindingId: variable.serviceBindingId || null,
      detectedReference: variable.detectedReference || variable.detectedSource || null,
      repositoryDefault: variable.isSecret ? null : variable.repositoryDefault || null,
      configurationFingerprint: variable.configurationFingerprint || null,
      classification: classifyConfigurationVariable(variable.key, { secret: variable.isSecret, scope: variable.scope }),
      isActive: variable.isActive !== false,
      status: variable.appliedAt ? "applied" : "saved",
      configured: true,
      maskedValue: "••••••••",
      createdAt: variable.createdAt,
      updatedAt: variable.updatedAt,
    };
  }

  private environmentDefaults(key: string) {
    return {
      key,
      isRequired: false,
      scope: "runtime" as const,
      isSecret: isSecretConfigurationKey(key),
      detectedSource: "user configuration",
    };
  }

  private async assertEnvironmentOwnership(projectId: string, key: string, manager?: EntityManager) {
    const normalized = normalizeConfigurationKey(key);
    if (reservedVariable(normalized)) throw new BadRequestException(reservedVariableError(normalized));
  }

  private async ignoredEnvironmentVariableNames(projectId: string, keys: string[], manager?: EntityManager) {
    void projectId;
    void manager;
    return keys.map(normalizeConfigurationKey).filter((key) => key === "PORT" || key === "HOST");
  }

  private assertVariableMutable(variable: ProjectEnvironmentVariable) {
    if (variable.protected || !["user_optional", "repository_default"].includes(variable.owner || "")) {
      throw new BadRequestException(reservedVariableError(variable.normalizedKey || variable.key));
    }
  }

  private configurationFingerprint(value: Record<string, unknown>) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  private async encryptLegacyEnvironmentValues(projectId: string) {
    const variables = await this.envVarRepository.createQueryBuilder("env")
      .addSelect("env.value")
      .where("env.projectId = :projectId", { projectId })
      .andWhere("env.isActive = true")
      .getMany();
    const legacy = variables.filter((variable) => variable.value && !this.environmentCrypto.isEncrypted(variable.value));
    if (!legacy.length) return;
    await this.dataSource.transaction(async (manager) => {
      const project = await manager.getRepository(Project).findOne({ where: { id: projectId } });
      if (!project) throw new NotFoundException("Project not found");
      await acquireProjectConfigurationAdvisoryLock(manager, projectId, canonicalEnvironmentName(project));
      const repository = manager.getRepository(ProjectEnvironmentVariable);
      const current = await repository.createQueryBuilder("env")
        .addSelect("env.value")
        .where("env.projectId = :projectId", { projectId })
        .andWhere("env.isActive = true")
        .getMany();
      const currentLegacy = current.filter((variable) => variable.value && !this.environmentCrypto.isEncrypted(variable.value));
      for (const variable of currentLegacy) {
        variable.value = this.environmentCrypto.encrypt(variable.value);
        variable.encryptionVersion = 1;
      }
      if (currentLegacy.length) await repository.save(currentLegacy);
    });
  }

  private applyProjectUpdate(project: Project, dto: UpdateProjectDto) {
    if (dto.name !== undefined) project.name = dto.name.trim();
    if (dto.description !== undefined) project.description = dto.description;
    if (dto.visibility !== undefined) project.visibility = dto.visibility;
  }

  private normalizeServices(input?: Array<Pick<DeployableServiceInputDto, "name" | "serviceDirectory">>) {
    const values = input?.length ? input : [{ name: "Web", serviceDirectory: "." }];
    if (values.length > 20) throw new BadRequestException("A project supports at most 20 explicitly configured services.");
    const services = values.map((value) => ({ name: String(value.name || "").trim(), serviceDirectory: normalizeServiceDirectory(value.serviceDirectory) }));
    if (services.some((service) => !service.name || service.name.length > 80)) throw new BadRequestException("Every service requires a bounded name.");
    const names = services.map((service) => service.name.toLocaleLowerCase());
    if (new Set(names).size !== names.length) throw new ConflictException("Service names must be unique within a project.");
    return services;
  }

  private async requireService(projectId: string, serviceId?: string) {
    const service = serviceId
      ? await this.deployableServices.findOne({ where: { id: serviceId, projectId } })
      : await this.deployableServices.findOne({ where: { projectId }, order: { position: "ASC" } });
    if (!service) throw new NotFoundException("Deployable service not found");
    return service;
  }
}
