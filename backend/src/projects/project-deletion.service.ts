import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, In, Not, Repository } from "typeorm";
import { loadDestroyOwnership } from "./aws-resource-ownership-reader";
import { assertDestroyOwnership, ownershipSha256 } from "./aws-resource-ownership";
import { assertRailpackRuntimeConfiguration } from "./railpack-workflow-contract";
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
      // Re-read persisted eligibility and receipts before any SNS/GitHub cleanup.
      // Network calls remain outside transactions. Pending cleanup blocks normal
      // lifecycle admission; the final transaction independently revalidates.
      await this.dataSource.transaction((manager) => this.assertPersistedReady(manager, project, destroy.id));
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
        await this.assertPersistedReady(manager, project, destroy.id);
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
      throw new ProjectDeletionIncompleteError("persisted ownership or external project cleanup could not be verified");
    }
  }

  private async assertPersistedReady(manager: EntityManager, project: Project, operationId: string) {
    const environmentName = canonicalEnvironmentName(project);
    await acquireProjectConfigurationAdvisoryLock(manager, project.id, environmentName);
    await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-delete:${project.id}`]);
    const current = await manager.getRepository(ProjectPipelineRun).findOne({
      where: { id: operationId, projectId: project.id }, lock: { mode: "pessimistic_write" },
    });
    if (!current) throw new ProjectDeletionIncompleteError("the verified delete operation no longer exists");
    const verification = this.assertReady(project, current);
    const active = await manager.getRepository(ProjectPipelineRun).count({ where: { projectId: project.id, status: In([PipelineRunStatus.QUEUED, PipelineRunStatus.RUNNING]) } });
    if (active) throw new ProjectDeletionIncompleteError("another lifecycle operation is active");
    const generations = await manager.getRepository(ProjectDeploymentGeneration).find({ where: { projectId: project.id }, take: 1001 });
    const actual = generations.map((generation) => generation.id).sort();
    if (actual.length !== verification.generationIds.length || actual.some((id, index) => id !== verification.generationIds[index])) throw new ProjectDeletionIncompleteError("the persisted generation set changed after deletion verification");
    // assertReady already validated these immutable input bytes. Do not recover
    // missing authority from current config or from the proof's resource list.
    const inputs = current.metadata!.immutableDispatchInputs as Record<string, string>;
    const runtime = JSON.parse(Buffer.from(inputs.services_base64, "base64").toString("utf8"));
    assertRailpackRuntimeConfiguration(runtime);
    const frozen = runtime.projectDeletion?.ownership;
    assertDestroyOwnership(frozen);
    const retained = await loadDestroyOwnership(manager, frozen.manifest.scope, inputs.terraform_state_bucket, generations);
    if (ownershipSha256(retained) !== ownershipSha256(frozen)) throw new ProjectDeletionIncompleteError("the retained ownership receipts changed after deletion verification");
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
