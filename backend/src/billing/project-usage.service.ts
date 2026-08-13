import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, In, MoreThanOrEqual, Repository } from "typeorm";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project, ProjectStatus } from "../projects/project.entity";
import { TERMINAL_PIPELINE_STATUSES } from "../projects/pipeline/pipeline-status";

@Injectable()
export class ProjectUsageService {
  constructor(
    @InjectRepository(Project) private readonly projectRepo: Repository<Project>,
    @InjectRepository(ProjectPipelineRun) private readonly runRepo: Repository<ProjectPipelineRun>
  ) {}

  async counts(userId: number, manager?: EntityManager) {
    const projects = manager?.getRepository(Project) || this.projectRepo;
    const runs = manager?.getRepository(ProjectPipelineRun) || this.runRepo;
    const [totalProjects, activeProjects, activeRuns] = await Promise.all([
      projects.count({ where: { ownerUserId: userId } }),
      projects.createQueryBuilder("project")
        .where("project.ownerUserId = :userId", { userId })
        .andWhere("project.status <> :archived", { archived: ProjectStatus.ARCHIVED })
        .andWhere("project.archivedAt IS NULL")
        .getCount(),
      runs.createQueryBuilder("run")
        .innerJoin(Project, "project", "project.id = run.projectId")
        .where("project.ownerUserId = :userId", { userId })
        .andWhere("run.status NOT IN (:...terminalStatuses)", { terminalStatuses: TERMINAL_PIPELINE_STATUSES })
        .getCount(),
    ]);
    return { totalProjects, activeProjects, activeRuns };
  }

  async deploymentRunsSince(userId: number, since: Date, manager?: EntityManager) {
    const projects = manager?.getRepository(Project) || this.projectRepo;
    const runs = manager?.getRepository(ProjectPipelineRun) || this.runRepo;
    const ids = (await projects.find({ select: { id: true }, where: { ownerUserId: userId } })).map((project) => project.id);
    return ids.length ? runs.count({ where: { projectId: In(ids), createdAt: MoreThanOrEqual(since) } }) : 0;
  }
}
