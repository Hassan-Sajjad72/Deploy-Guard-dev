import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { DataSource, EntityManager, Not, Repository } from "typeorm";
import { NotificationSubscription } from "../notifications/notification-subscription.entity";
import { SnsNotificationAdapter } from "../notifications/sns-notification.adapter";
import { GithubAppService } from "./github-app.service";
import { GithubActionsService } from "./pipeline/github-actions.service";
import { createRedisConnection } from "./pipeline/redis.config";
import { PIPELINE_QUEUE_NAME } from "./pipeline/pipeline.types";
import { ProjectDeploymentGeneration } from "./project-deployment-generation.entity";
import { ProjectPipelineRun, PipelineRunStatus } from "./project-pipeline-run.entity";
import { Project } from "./project.entity";
import { ProjectDestroyPhase } from "./project-destroy-lifecycle.entity";

export class ProjectExtinctionIncompleteError extends Error {
  readonly code = "DESTROY_INCOMPLETE";
  constructor(message: string) {
    super(`DESTROY_INCOMPLETE: ${message}`);
    this.name = "ProjectExtinctionIncompleteError";
  }
}

type TextColumn = { tableName: string; columnName: string };

@Injectable()
export class ProjectExtinctionService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectDeploymentGeneration) private readonly generations: Repository<ProjectDeploymentGeneration>,
    @InjectRepository(NotificationSubscription) private readonly subscriptions: Repository<NotificationSubscription>,
    private readonly githubApp: GithubAppService,
    private readonly actions: GithubActionsService,
    private readonly sns: SnsNotificationAdapter,
    private readonly config: ConfigService,
  ) {}

  async extinguish(
    project: Project,
    destroy: ProjectPipelineRun,
    githubToken: string,
    onPhase: (phase: ProjectDestroyPhase) => Promise<void> = async () => undefined,
  ) {
    this.assertVerifiedDestroy(project, destroy);
    try {
      const [generations, operations, subscriptions, sharedCallerUsers] = await Promise.all([
        this.generations.find({ where: { projectId: project.id }, select: { id: true } }),
        this.runs.find({ where: { projectId: project.id }, select: { id: true, githubWorkflowRunId: true } }),
        this.subscriptions.find({ where: { projectId: project.id }, select: { providerSubscriptionArn: true, providerTopicArn: true } }),
        this.projects.count({ where: { id: Not(project.id), repositoryFullName: project.repositoryFullName, targetBranch: project.targetBranch } }),
      ]);
      const identities = [...new Set([
        project.id, ...generations.map((item) => item.id), ...operations.map((item) => item.id),
        ...await this.databaseOwnedRowIdentities(project.id),
      ])];
      await onPhase(ProjectDestroyPhase.TERRAFORM_STATE_CLEANUP);
      await onPhase(ProjectDestroyPhase.EXTERNAL_METADATA_CLEANUP);
      await this.sns.extinguishProject(project.id, subscriptions);
      for (const workflowRunId of [...new Set(operations.map((item) => item.githubWorkflowRunId).filter((value): value is string => Boolean(value)))]) {
        await this.actions.deleteWorkflowRun(project.repositoryFullName, workflowRunId, githubToken);
      }
      if (sharedCallerUsers === 0) {
        await this.githubApp.removeManagedWorkflow(project.ownerUserId, project.repositoryFullName, project.targetBranch, project.githubInstallationId);
      }
      await this.purgeQueueTraces(identities);
      await onPhase(ProjectDestroyPhase.DATABASE_EXTINCTION);
      await this.purgeDatabase(project.id, destroy.id, identities);
      if (await this.projects.exist({ where: { id: project.id } })) {
        throw new ProjectExtinctionIncompleteError("the extinct project still resolves after database cleanup");
      }
      return { projectId: project.id, generationIds: generations.map((item) => item.id), status: "extinct" as const };
    } catch (error) {
      if (error instanceof ProjectExtinctionIncompleteError) throw error;
      const message = error instanceof Error ? error.message.replace(/^DESTROY_INCOMPLETE:\s*/i, "") : "project extinction could not be verified";
      throw new ProjectExtinctionIncompleteError(message);
    }
  }

  private async databaseOwnedRowIdentities(projectId: string) {
    const tables = await this.dataSource.query(`
      SELECT project.table_name AS "tableName"
      FROM information_schema.columns project
      JOIN information_schema.columns identity
        ON identity.table_schema = project.table_schema
       AND identity.table_name = project.table_name
       AND identity.column_name = 'id'
      WHERE project.table_schema = 'public' AND project.column_name = 'project_id'
      ORDER BY project.table_name
    `) as Array<{ tableName: string }>;
    const identities: string[] = [];
    for (const item of tables) {
      const table = this.identifier(item.tableName);
      const rows = await this.dataSource.query(`SELECT id::text AS id FROM ${table} WHERE project_id::text = $1`, [projectId]) as Array<{ id: string }>;
      identities.push(...rows.map((row) => row.id).filter(Boolean));
    }
    const closure = new Set([projectId, ...identities]);
    const columns = await this.dataSource.query(`
      SELECT source.table_name AS "tableName", json_agg(source.column_name ORDER BY source.ordinal_position) AS columns
      FROM information_schema.columns source
      WHERE source.table_schema = 'public'
        AND source.data_type IN ('uuid', 'text', 'character varying', 'character', 'json', 'jsonb', 'ARRAY')
        AND EXISTS (
          SELECT 1 FROM information_schema.columns identity
          WHERE identity.table_schema = source.table_schema AND identity.table_name = source.table_name AND identity.column_name = 'id'
        )
        AND source.table_name NOT IN ('projects', 'users', 'migrations')
      GROUP BY source.table_name
      ORDER BY source.table_name
    `) as Array<{ tableName: string; columns: string[] }>;
    for (let pass = 0; pass < 10; pass += 1) {
      let changed = false;
      const patterns = [...closure].map((identity) => `%${identity}%`);
      for (const item of columns) {
        const table = this.identifier(item.tableName);
        const predicate = item.columns.map((column) => `${this.identifier(column)}::text LIKE ANY($1::text[])`).join(" OR ");
        const rows = await this.dataSource.query(`SELECT id::text AS id FROM ${table} WHERE ${predicate}`, [patterns]) as Array<{ id: string }>;
        for (const row of rows) {
          if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(row.id) && !closure.has(row.id)) {
            closure.add(row.id);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    return [...closure];
  }

  private async purgeQueueTraces(identities: string[]) {
    if (!this.config.get<string>("REDIS_HOST", "").trim()) return;
    const identitySet = new Set(identities);
    const queueNames = [...new Set([
      PIPELINE_QUEUE_NAME,
      "deployguard-infrastructure-lifecycle",
      "deployguard-emergency-cleanup",
      "deployguard-release-v1",
      "deployguard-infrastructure-v1",
      "deployguard-deletion-v1",
    ])];
    const matches = (job: { id?: string; name?: string; data?: unknown; returnvalue?: unknown; failedReason?: string; stacktrace?: string[] }) => {
      const evidence = JSON.stringify({ id: job.id, name: job.name, data: job.data, returnvalue: job.returnvalue, failedReason: job.failedReason, stacktrace: job.stacktrace });
      return [...identitySet].some((identity) => evidence.includes(identity));
    };
    for (const name of queueNames) {
      const queue = new Queue(name, { connection: createRedisConnection(this.config) });
      let timeout: NodeJS.Timeout | null = null;
      try {
        await Promise.race([
          (async () => {
            const states = ["wait", "active", "completed", "failed", "delayed", "paused", "prioritized", "waiting-children"] as const;
            const jobs = await queue.getJobs([...states], 0, -1, true);
            for (const job of jobs) if (matches(job)) {
              if (job.id) identitySet.add(String(job.id));
              await job.remove();
            }
            const client = await queue.client as unknown as {
              xrange(key: string, start: string, end: string): Promise<Array<[string, string[]]>>;
              xdel(key: string, ...ids: string[]): Promise<number>;
            };
            const eventKey = queue.toKey("events");
            const events = await client.xrange(eventKey, "-", "+");
            for (const [eventId, fields] of events) {
              if ([...identitySet].some((identity) => JSON.stringify(fields).includes(identity))) await client.xdel(eventKey, eventId);
            }
            const remaining = await queue.getJobs([...states], 0, -1, true);
            if (remaining.some(matches)) throw new ProjectExtinctionIncompleteError(`queued or background-job data remains in ${name}`);
            const remainingEvents = await client.xrange(eventKey, "-", "+");
            if (remainingEvents.some(([, fields]) => [...identitySet].some((identity) => JSON.stringify(fields).includes(identity)))) {
              throw new ProjectExtinctionIncompleteError(`queue event data remains in ${name}`);
            }
          })(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new ProjectExtinctionIncompleteError(`queue verification timed out for ${name}`)), 10_000);
            timeout.unref();
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
        await queue.disconnect();
      }
    }
  }

  private assertVerifiedDestroy(project: Project, destroy: ProjectPipelineRun) {
    const evidence = destroy.metadata?.destroyVerification as Record<string, unknown> | undefined;
    const resumableControlPlaneFailure = destroy.status === PipelineRunStatus.FAILED
      && destroy.metadata?.failureCategory === "project_extinction_incomplete";
    if (destroy.projectId !== project.id
      || (destroy.status !== PipelineRunStatus.COMPLETED && !resumableControlPlaneFailure)
      || destroy.metadata?.deploymentAction !== "destroy"
      || evidence?.status !== "verified_destroyed"
      || evidence.deploymentOperationId !== destroy.id
      || evidence.projectOwnedAwsResourcesAbsent !== true
      || evidence.allProjectTerraformArtifactsAbsent !== true) {
      throw new ProjectExtinctionIncompleteError("authoritative project-wide absence evidence is incomplete");
    }
  }

  private async purgeDatabase(projectId: string, operationId: string, identities: string[]) {
    await this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-extinction:${projectId}`]);
      const operation = await manager.getRepository(ProjectPipelineRun).findOne({ where: { id: operationId, projectId } });
      const project = await manager.getRepository(Project).findOne({ where: { id: projectId } });
      if (!project || !operation) throw new ProjectExtinctionIncompleteError("the project or verified Destroy operation changed before finalization");

      const deleted = await manager.getRepository(Project).delete({ id: projectId });
      if (deleted.affected !== 1) throw new ProjectExtinctionIncompleteError("the project record could not be deleted exactly once");
      await this.deleteResidualIdentityReferences(manager, identities);
      const traces = await this.findIdentityTraces(manager, identities);
      if (traces.length) throw new ProjectExtinctionIncompleteError(`database traces remain: ${traces.slice(0, 10).join(", ")}`);
    });
  }

  private async deleteResidualIdentityReferences(manager: EntityManager, identities: string[]) {
    for (const column of await this.textColumns(manager)) {
      if (["projects", "users", "migrations"].includes(column.tableName)) continue;
      const table = this.identifier(column.tableName);
      const name = this.identifier(column.columnName);
      await manager.query(`DELETE FROM ${table} WHERE ${name}::text LIKE ANY($1::text[])`, [identities.map((identity) => `%${identity}%`)]);
    }
  }

  private async findIdentityTraces(manager: EntityManager, identities: string[]) {
    const traces: string[] = [];
    for (const column of await this.textColumns(manager)) {
      if (["users", "migrations"].includes(column.tableName)) continue;
      const table = this.identifier(column.tableName);
      const name = this.identifier(column.columnName);
      const rows = await manager.query(`SELECT 1 FROM ${table} WHERE ${name}::text LIKE ANY($1::text[]) LIMIT 1`, [identities.map((identity) => `%${identity}%`)]);
      if (rows.length) traces.push(`${column.tableName}.${column.columnName}`);
    }
    return traces;
  }

  private async textColumns(manager: EntityManager): Promise<TextColumn[]> {
    return manager.query(`
      SELECT table_name AS "tableName", column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('uuid', 'text', 'character varying', 'character', 'json', 'jsonb', 'ARRAY')
      ORDER BY table_name, ordinal_position
    `);
  }

  private identifier(value: string) {
    if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new ProjectExtinctionIncompleteError("database identity verification encountered an unsafe identifier");
    return `"${value}"`;
  }
}
