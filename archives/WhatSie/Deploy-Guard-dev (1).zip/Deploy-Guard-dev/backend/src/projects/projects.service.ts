import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Not, Repository } from "typeorm";
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

type RequestInfo = { ip?: string; headers?: { cookie?: string } };

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectEnvironmentVariable)
    private readonly envVarRepository: Repository<ProjectEnvironmentVariable>,
    private readonly auditLogService: AuditLogService
  ) {}

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

    const projects = await this.projectRepository.find({
      where,
      order: { createdAt: "DESC" },
    });

    return projects.map((project) => this.toProjectResponse(project, user));
  }

  async createProject(user: User, dto: CreateProjectDto, req?: RequestInfo) {
    this.assertCanWrite(user);
    const repositoryFullName = this.parseGitHubRepositoryFullName(dto.repositoryUrl);
    const project = this.projectRepository.create({
      ownerUserId: user.id,
      name: dto.name.trim(),
      description: dto.description || null,
      repositoryUrl: this.normalizeRepositoryUrl(dto.repositoryUrl),
      repositoryProvider: "github",
      repositoryFullName,
      targetBranch: dto.targetBranch || "main",
      visibility: dto.visibility || ProjectVisibility.PRIVATE,
      status: ProjectStatus.CREATED,
    });
    const savedProject = await this.projectRepository.save(project);

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
      },
      req: req as never,
    });

    return this.toProjectResponse(savedProject, user);
  }

  async getProjectForView(user: User, projectId: string) {
    const project = await this.findProject(projectId);
    this.assertCanView(user, project);

    return this.toProjectResponse(project, user);
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

    if (dto.name !== undefined) {
      project.name = dto.name.trim();
    }

    if (dto.description !== undefined) {
      project.description = dto.description;
    }

    if (dto.visibility !== undefined) {
      project.visibility = dto.visibility;
    }

    const savedProject = await this.projectRepository.save(project);

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

    project.repositoryUrl = this.normalizeRepositoryUrl(dto.repositoryUrl);
    project.repositoryFullName = this.parseGitHubRepositoryFullName(dto.repositoryUrl);
    project.repositoryProvider = "github";
    project.status = ProjectStatus.CONFIGURED;
    const savedProject = await this.projectRepository.save(project);

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

    const response = await fetch(
      `https://api.github.com/repos/${project.repositoryFullName}/branches`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Deploy-Guard",
        },
      }
    );

    if (!response.ok) {
      throw new BadRequestException("Unable to fetch GitHub branches");
    }

    const branches = (await response.json()) as Array<{ name?: string }>;

    return branches.map((branch) => branch.name).filter(Boolean);
  }

  async updateBranch(
    user: User,
    projectId: string,
    dto: UpdateBranchDto,
    req?: RequestInfo
  ) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);
    project.targetBranch = dto.targetBranch;
    project.status = ProjectStatus.CONFIGURED;
    const savedProject = await this.projectRepository.save(project);

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

  async listEnvVars(user: User, projectId: string) {
    const project = await this.findProject(projectId);
    this.assertCanView(user, project);
    const variables = await this.envVarRepository.find({
      where: { projectId: project.id },
      order: { key: "ASC" },
    });

    return variables.map((variable) => this.toEnvVarResponse(variable));
  }

  async createEnvVar(
    user: User,
    projectId: string,
    dto: CreateEnvVarDto,
    req?: RequestInfo
  ) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);
    await this.assertEnvKeyAvailable(project.id, dto.key);
    const variable = this.envVarRepository.create({
      projectId: project.id,
      key: dto.key,
      value: dto.value,
      isSecret: dto.isSecret ?? true,
    });
    const savedVariable = await this.envVarRepository.save(variable);

    await this.auditLogService.record({
      actorUser: user,
      action: "PROJECT_ENV_CREATED",
      resourceType: "project_env",
      resourceId: savedVariable.id,
      status: "success",
      metadata: {
        projectId: project.id,
        projectName: project.name,
        key: savedVariable.key,
        isSecret: savedVariable.isSecret,
      },
      req: req as never,
    });

    return this.toEnvVarResponse(savedVariable);
  }

  async updateEnvVar(
    user: User,
    projectId: string,
    envId: string,
    dto: UpdateEnvVarDto,
    req?: RequestInfo
  ) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);
    const variable = await this.findEnvVar(project.id, envId);

    if (dto.key && dto.key !== variable.key) {
      await this.assertEnvKeyAvailable(project.id, dto.key, variable.id);
      variable.key = dto.key;
    }

    if (dto.value !== undefined) {
      variable.value = dto.value;
    }

    if (dto.isSecret !== undefined) {
      variable.isSecret = dto.isSecret;
    }

    const savedVariable = await this.envVarRepository.save(variable);

    await this.auditLogService.record({
      actorUser: user,
      action: "PROJECT_ENV_UPDATED",
      resourceType: "project_env",
      resourceId: savedVariable.id,
      status: "success",
      metadata: {
        projectId: project.id,
        projectName: project.name,
        key: savedVariable.key,
        isSecret: savedVariable.isSecret,
      },
      req: req as never,
    });

    return this.toEnvVarResponse(savedVariable);
  }

  async deleteEnvVar(user: User, projectId: string, envId: string, req?: RequestInfo) {
    const project = await this.findProject(projectId);
    this.assertCanManage(user, project);
    const variable = await this.findEnvVar(project.id, envId);
    await this.envVarRepository.remove(variable);

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
    const project = await this.projectRepository.findOne({ where: { id: projectId } });

    if (!project || project.status === ProjectStatus.ARCHIVED) {
      throw new NotFoundException("Project not found");
    }

    return project;
  }

  private async findEnvVar(projectId: string, envId: string) {
    const variable = await this.envVarRepository.findOne({
      where: { id: envId, projectId },
      select: {
        id: true,
        projectId: true,
        key: true,
        value: true,
        isSecret: true,
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

    if (user.role === UserRole.ADMIN || project.ownerUserId === user.id) {
      return;
    }

    throw new ForbiddenException("Insufficient permissions");
  }

  private async assertEnvKeyAvailable(
    projectId: string,
    key: string,
    currentEnvId?: string
  ) {
    const existing = await this.envVarRepository.findOne({ where: { projectId, key } });

    if (existing && existing.id !== currentEnvId) {
      throw new ConflictException("Environment variable key already exists");
    }
  }

  private parseGitHubRepositoryFullName(repositoryUrl: string): string {
    const match = this.normalizeRepositoryUrl(repositoryUrl).match(
      /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)$/
    );

    if (!match) {
      throw new BadRequestException("Invalid GitHub repository URL");
    }

    return match[1];
  }

  private normalizeRepositoryUrl(repositoryUrl: string): string {
    return repositoryUrl.trim().replace(/\/$/, "");
  }

  private toProjectResponse(project: Project, user: User) {
    return {
      id: project.id,
      ownerUserId: String(project.ownerUserId),
      name: project.name,
      description: project.description,
      repositoryUrl: project.repositoryUrl,
      repositoryProvider: project.repositoryProvider,
      repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch,
      status: project.status,
      visibility: project.visibility,
      canManage:
        user.role === UserRole.ADMIN ||
        (user.role === UserRole.DEVELOPER && project.ownerUserId === user.id),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  private toEnvVarResponse(variable: ProjectEnvironmentVariable) {
    return {
      id: variable.id,
      key: variable.key,
      isSecret: variable.isSecret,
      maskedValue: "********",
      createdAt: variable.createdAt,
      updatedAt: variable.updatedAt,
    };
  }
}
