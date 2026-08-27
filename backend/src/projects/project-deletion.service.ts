import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Not, Repository } from "typeorm";
import { NotificationSubscription } from "../notifications/notification-subscription.entity";
import { SnsNotificationAdapter } from "../notifications/sns-notification.adapter";
import { canonicalEnvironmentName } from "./canonical-environment";
import { GithubAppService } from "./github-app.service";
import { ProjectPipelineRun, PipelineRunStatus } from "./project-pipeline-run.entity";
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
        this.projects.count({
          where: {
            id: Not(project.id),
            repositoryFullName: project.repositoryFullName,
            targetBranch: project.targetBranch,
          },
        }),
      ]);

      await this.sns.deleteProjectResources(project.id, subscriptions);
      if (sharedCallerUsers === 0) {
        await this.githubApp.removeManagedWorkflow(
          project.ownerUserId,
          project.repositoryFullName,
          project.targetBranch,
          project.githubInstallationId,
        );
      }

      await this.dataSource.transaction(async (manager) => {
        await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-delete:${project.id}`]);
        const current = await manager.getRepository(ProjectPipelineRun).findOne({
          where: { id: destroy.id, projectId: project.id },
        });
        if (!current) throw new ProjectDeletionIncompleteError("the verified delete operation no longer exists");
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
    const evidence = destroy.metadata?.destroyVerification as Record<string, unknown> | undefined;
    const finalizationEligible = destroy.status === PipelineRunStatus.COMPLETED
      || (destroy.status === PipelineRunStatus.FAILED
        && destroy.currentStage === "project_delete_cleanup"
        && destroy.metadata?.failureCategory === "project_delete_incomplete");
    if (
      destroy.projectId !== project.id
      || !finalizationEligible
      || destroy.metadata?.deploymentAction !== "destroy"
      || evidence?.contractVersion !== "deployguard.destroy-result/v2"
      || evidence.deploymentOperationId !== destroy.id
      || evidence.projectId !== project.id
      || evidence.environmentName !== canonicalEnvironmentName(project)
      || evidence.status !== "project_delete_ready"
      || evidence.generationResourcesRemoved !== true
      || evidence.projectResourcesRemoved !== true
      || evidence.terraformStateArtifactsRemoved !== true
      || evidence.sharedPlatformUntouched !== true
      || !destroy.generationId
      || !Array.isArray(evidence.generationIds)
      || !evidence.generationIds.includes(destroy.generationId)
    ) {
      throw new ProjectDeletionIncompleteError("exact project/generation cleanup evidence is incomplete");
    }
  }
}
