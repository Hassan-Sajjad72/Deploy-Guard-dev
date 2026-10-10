import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Not, Repository } from "typeorm";
import { NotificationSubscription } from "../notifications/notification-subscription.entity";
import { SnsNotificationAdapter } from "../notifications/sns-notification.adapter";
import { canonicalEnvironmentName } from "./canonical-environment";
import { GithubAppService } from "./github-app.service";
import { githubActionsDestroyEvidenceFromValue, githubActionsDestroyEvidenceMatchesOperation, hasValidatedDestroyCleanupStatus } from "./github-actions-destroy-evidence";
import { ProjectPipelineRun, PipelineRunStatus } from "./project-pipeline-run.entity";
import { ProjectDeploymentGeneration } from "./project-deployment-generation.entity";
import { acquireProjectConfigurationAdvisoryLock } from "./project-configuration-lock";
import { Project } from "./project.entity";

export class ProjectDeletionIncompleteError extends Error {
  readonly code = "PROJECT_DELETE_INCOMPLETE";

  constructor(message: string) {
    super(`PROJECT_DELETE_INCOMPLETE: ${message}`);
    this.name = "ProjectDeletionIncompleteError";
  }
}

/**
 * Finalizes an explicit project delete after the workflow has removed only the
 * exact project and generation resources described by its immutable context.
 * This deliberately is not an AWS discovery engine or a second lifecycle.
 */
@Injectable()
export class ProjectDeletionService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(NotificationSubscription) private readonly subscriptions: Repository<NotificationSubscription>,
    private readonly githubApp: GithubAppService,
    private readonly sns: SnsNotificationAdapter,
  ) {}

  async finalize(project: Project, destroy: ProjectPipelineRun) {
    this.assertReady(project, destroy);
    try {
      const [subscriptions, sharedCallerUsers] = await Promise.all([
        this.subscriptions.find({
          where: { projectId: project.id },
          select: { providerSubscriptionArn: true, providerTopicArn: true },
        }),
        this.projects.count({ where: { id: Not(project.id), repositoryFullName: project.repositoryFullName } }),
      ]);

      await this.sns.deleteProjectResources(project.id, subscriptions);
      if (sharedCallerUsers === 0) {
        await this.githubApp.removeManagedWorkflow(
          project.ownerUserId,
          project.repositoryFullName,
          project.githubInstallationId,
        );
      }

      await this.dataSource.transaction(async (manager) => {
        await acquireProjectConfigurationAdvisoryLock(manager, project.id, canonicalEnvironmentName(project));
        await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-delete:${project.id}`]);
        const current = await manager.getRepository(ProjectPipelineRun).findOne({
          where: { id: destroy.id, projectId: project.id },
          lock: { mode: "pessimistic_write" },
        });
        if (!current) throw new ProjectDeletionIncompleteError("the verified delete operation no longer exists");
        const verification = this.assertReady(project, current);
        const active = await manager.getRepository(ProjectPipelineRun).count({ where: { projectId: project.id, status: In([PipelineRunStatus.QUEUED, PipelineRunStatus.RUNNING]) } });
        if (active) throw new ProjectDeletionIncompleteError("another lifecycle operation is active");
        const generations = await manager.getRepository(ProjectDeploymentGeneration).find({ where: { projectId: project.id, environmentName: canonicalEnvironmentName(project) }, select: { id: true } });
        const expected = verification.generationIds;
        const actual = generations.map((generation) => generation.id).sort();
        if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) throw new ProjectDeletionIncompleteError("the persisted generation set changed after deletion verification");
        await manager.query(
          `DELETE FROM audit_logs WHERE resource_id = $1 OR metadata->>'projectId' = $1`,
          [project.id],
        );
        const deleted = await manager.getRepository(Project).delete({ id: project.id });
        if (deleted.affected !== 1) throw new ProjectDeletionIncompleteError("the project record was not deleted exactly once");
      });

      return { projectId: project.id, status: "deleted" as const };
    } catch (error) {
      if (error instanceof ProjectDeletionIncompleteError) throw error;
      throw new ProjectDeletionIncompleteError(error instanceof Error ? error.message : "project deletion did not complete");
    }
  }

  private assertReady(project: Project, destroy: ProjectPipelineRun) {
    const evidence = githubActionsDestroyEvidenceFromValue(destroy.metadata?.destroyVerification);
    if (
      destroy.projectId !== project.id
      || !hasValidatedDestroyCleanupStatus(destroy)
      || !evidence
      || !githubActionsDestroyEvidenceMatchesOperation(evidence, destroy, canonicalEnvironmentName(project))
    ) {
      throw new ProjectDeletionIncompleteError("exact project/generation cleanup evidence is incomplete");
    }
    return evidence;
  }
}
