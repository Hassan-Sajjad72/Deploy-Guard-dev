import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { DescribeServicesCommand, ECSClient, ListTagsForResourceCommand, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { randomUUID } from "crypto";
import { DataSource, EntityManager } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { User } from "../users/user.entity";
import { UsersService } from "../users/users.service";
import { canAccessProject, canApproveProject } from "../workspaces/project-access";
import { Project } from "../projects/project.entity";
import { ProjectCurrentStateService } from "../projects/current-state/project-current-state.service";
import { RailpackDeploymentService } from "../projects/railpack-deployment.service";
import { ProjectPipelineRun, PipelineRunStatus } from "../projects/project-pipeline-run.entity";
import { currentFailureDiagnostic } from "../projects/failure-diagnostics/failure-diagnostic.service";
import { CustomerAwsSessionService } from "../planning/customer-aws-session.service";
import { acquireProjectConfigurationAdvisoryLock as lockProjectConfiguration } from "../projects/project-configuration-lock";
import { GovernedRecoveryDecision, GovernedRecoveryRequest } from "./recovery.entity";
import { RECOVERY_RUNBOOKS, assertRecoveryBudget, recoveryFingerprint, recoveryOutcome, recoveryRunbook } from "./recovery-policy";
import { RequestRecoveryDto, RecoveryDecisionDto } from "./recovery.dto";

@Injectable()
export class RecoveryService {
  constructor(private readonly db: DataSource, private readonly users: UsersService, private readonly state: ProjectCurrentStateService,
    private readonly railpack: RailpackDeploymentService, private readonly customer: CustomerAwsSessionService, private readonly audit: AuditLogService) {}

  async access(user: User, projectId: string, write = false, manager: EntityManager = this.db.manager) {
    const fresh = await this.users.findById(user.id);
    const project = await manager.getRepository(Project).findOne({ where: { id: projectId } });
    if (!project || !fresh || !canAccessProject(fresh, project, write)) throw new NotFoundException("Project not found.");
    if (write && (project.archivedAt || project.deletionIntentId)) throw new ConflictException("Recovery is blocked while this project is archived or being deleted.");
    return { project, user: fresh };
  }
  async registry(user: User, projectId: string) { await this.access(user, projectId); return { runbooks: RECOVERY_RUNBOOKS }; }
  async list(user: User, projectId: string) {
    const access = await this.access(user, projectId);
    return { requests: await this.db.getRepository(GovernedRecoveryRequest).find({ where: { projectId }, order: { createdAt: "DESC" }, take: 50 }), canRequest: canAccessProject(access.user, access.project, true), canApprove: canApproveProject(access.user, access.project) };
  }
  async incident(projectId: string, incidentId: string) {
    const [row] = await this.db.query(`SELECT id,fingerprint,content FROM operational_intelligence_records WHERE id=$1 AND project_id=$2 AND kind='incident'`, [incidentId, projectId]);
    if (!row) throw new NotFoundException("Incident not found.");
    if (row.content.status !== "verified") throw new ConflictException("Recovery requires verified incident evidence.");
    if (!Number.isFinite(Date.parse(row.content.observedAt)) || Date.now() - Date.parse(row.content.observedAt) > 15 * 60_000 || Date.parse(row.content.observedAt) > Date.now() + 60_000) throw new ConflictException("Incident evidence is stale; investigate the current failure again.");
    return row;
  }
  private async scope(user: User, project: Project, incident: any) {
    const current = await this.state.getCurrentState(user, project.id, { refreshCloudState: true });
    const runtime = current.stableRelease?.runtimeIdentity || current.infrastructureEvidence?.runtimeIdentity || {};
    const observedScope = incident.content.scope;
    const sourceSha = current.stableRelease?.commit || current.latestAttempt?.commit || null;
    const resourceFingerprint = recoveryFingerprint(runtime);
    const scope = { projectId: project.id, organizationId: project.organizationId || null, environment: project.environmentName,
      releaseId: current.stableRelease?.id || null, sourceSha, operationId: current.latestAttempt?.operationId || current.stableRelease?.operationId || null,
      bindingId: project.awsAccountBindingId || null, accountId: observedScope?.accountId || null, region: current.infrastructureEvidence?.region || runtime.region || null, resourceFingerprint };
    if (!observedScope || observedScope.projectId !== project.id || observedScope.organizationId !== scope.organizationId || observedScope.environment !== scope.environment
      || observedScope.bindingId !== scope.bindingId || observedScope.sourceSha !== scope.sourceSha || observedScope.releaseId !== scope.releaseId
      || observedScope.resourceFingerprint !== resourceFingerprint || observedScope.region !== scope.region) throw new ConflictException("Incident source, resources or account scope changed; investigate again.");
    if (!sourceSha || !/^[a-f0-9]{40}$/i.test(sourceSha)) throw new ConflictException("Recovery requires an immutable source SHA.");
    if (current.stateAuthority?.applicationHealth.status !== "failed" && current.latestAttempt?.outcome !== "cancelled") {
      const failed = scope.operationId ? await this.db.getRepository(ProjectPipelineRun).findOne({ where: { id: scope.operationId, projectId: project.id, status: PipelineRunStatus.FAILED } }) : null;
      if (!failed) throw new ConflictException("The incident no longer has observed failure evidence.");
    }
    return { current, runtime, scope };
  }
  private async preparation(user: User, project: Project, dto: RequestRecoveryDto) {
    const book = recoveryRunbook(dto.runbookId); const incident = await this.incident(project.id, dto.incidentId);
    const { current, runtime, scope } = await this.scope(user, project, incident);
    const service = Array.isArray(runtime.services) ? runtime.services.find((item: any) => item.serviceId === dto.serviceId) : null;
    if (["ecs_restart", "bounded_replicas"].includes(book.id) && (!service || !project.awsAccountBindingId || !project.organizationId || !/^arn:aws:ecs:[a-z0-9-]+:\d{12}:service\//.test(String(service.ecsServiceArn || "")))) throw new ConflictException("Recovery requires an exact customer-owned ECS service.");
    if (scope.bindingId) {
      const [binding] = await this.db.query(`SELECT account_id,version,verification_status FROM aws_account_bindings WHERE id=$1 AND organization_id=$2`, [scope.bindingId, project.organizationId]);
      if (!binding || binding.verification_status !== "verified" || binding.account_id !== scope.accountId) throw new ConflictException("Customer account authority is unavailable or changed.");
    }
    if (book.id === "verified_rollback") {
      const candidates = await this.railpack.rollbackCandidates(user, project.id);
      if (!candidates.candidates.some((candidate) => candidate.targetOperationId === dto.targetOperationId)) throw new ConflictException("Selected release is not a verified immediate rollback target.");
    }
    if (book.id === "idempotent_retry") {
      const failed = await this.db.getRepository(ProjectPipelineRun).findOne({ where: { projectId: project.id, status: PipelineRunStatus.FAILED }, order: { createdAt: "DESC" } });
      if (!failed || failed.id !== dto.targetOperationId || currentFailureDiagnostic(failed)?.retryDecision !== "SAFE_NOW" || failed.metadata?.deploymentAction === "destroy") throw new ConflictException("The exact failed operation does not permit an idempotent deployment retry.");
    }
    const cost = current.estimatedCost;
    if (cost.status !== "estimated" || !cost.estimatedAt || Date.now() - Date.parse(cost.estimatedAt) > 86400000 || !cost.breakdown.length || cost.breakdown.some((item) => item.monthly === null)) throw new ConflictException("Complete recent cost evidence is required before recovery.");
    const observedService = current.infrastructureEvidence?.services?.find((item) => item.serviceId === dto.serviceId);
    const currentReplicas = observedService?.ecs.desiredCount || current.infrastructureEvidence?.ecs?.desiredCount || 1;
    const requestedReplicas = book.id === "bounded_replicas" ? dto.replicas : currentReplicas;
    const ceiling = assertRecoveryBudget(cost.monthly, dto.monthlyBudgetUsd, currentReplicas, requestedReplicas!);
    return { contractVersion: 1, incidentId: incident.id, incidentFingerprint: incident.fingerprint, scope,
      runbookId: book.id, runbookVersion: book.version, maxAttempts: book.maxAttempts, timeoutSeconds: book.timeoutSeconds,
      parameters: { serviceId: dto.serviceId || null, targetOperationId: dto.targetOperationId || null, replicas: requestedReplicas },
      service: service ? { serviceId: service.serviceId, ecsServiceArn: service.ecsServiceArn, ecsClusterArn: service.ecsClusterArn || runtime.ecsClusterArn, taskDefinitionArn: service.taskDefinitionArn } : null,
      cost: { monthlyBudgetUsd: dto.monthlyBudgetUsd, conservativeMonthlyCeilingUsd: ceiling, estimateOperationId: cost.operationId, estimatedAt: cost.estimatedAt },
    };
  }
  async request(user: User, projectId: string, dto: RequestRecoveryDto) {
    const access = await this.access(user, projectId, true); const content = await this.preparation(access.user, access.project, dto);
    const request = this.db.getRepository(GovernedRecoveryRequest).create({ id: randomUUID(), projectId, organizationId: access.project.organizationId || null,
      incidentId: dto.incidentId, createdByUserId: user.id, content, fingerprint: recoveryFingerprint(content), status: "requested" });
    await this.db.getRepository(GovernedRecoveryRequest).save(request);
    await this.record(access.user, request, "recovery_requested"); return { request };
  }
  async decide(user: User, projectId: string, requestId: string, dto: RecoveryDecisionDto) {
    if (!dto.reason.trim()) throw new BadRequestException("A review reason is required.");
    return this.db.transaction(async (manager) => {
      await lockProjectConfiguration(manager, projectId);
      const access = await this.access(user, projectId, false, manager);
      if (!canApproveProject(access.user, access.project)) throw new ForbiddenException("An owner, administrator or approver must review recovery.");
      const request = await manager.getRepository(GovernedRecoveryRequest).findOne({ where: { id: requestId, projectId }, lock: { mode: "pessimistic_write" } });
      if (!request) throw new NotFoundException("Recovery request not found.");
      if (request.status !== "requested" || request.fingerprint !== dto.fingerprint || recoveryFingerprint(request.content) !== dto.fingerprint) throw new ConflictException("Recovery fingerprint or decision state changed.");
      if (dto.decision === "approved") await this.revalidate(access.user, access.project, request);
      await manager.getRepository(GovernedRecoveryDecision).save({ requestId, actorUserId: user.id, actorRole: access.user.organizationMemberships?.find((item) => item.organizationId === access.project.organizationId)?.role || "owner", fingerprint: dto.fingerprint, decision: dto.decision, reason: dto.reason.trim() });
      request.status = dto.decision; await manager.getRepository(GovernedRecoveryRequest).save(request); await this.record(access.user, request, `recovery_${dto.decision}`); return { request };
    });
  }
  private async revalidate(user: User, project: Project, request: GovernedRecoveryRequest) {
    const content = request.content; const fresh = await this.preparation(user, project, { incidentId: request.incidentId, runbookId: content.runbookId,
      monthlyBudgetUsd: content.cost.monthlyBudgetUsd, serviceId: content.parameters.serviceId || undefined, targetOperationId: content.parameters.targetOperationId || undefined, replicas: content.parameters.replicas });
    if (recoveryFingerprint(fresh) !== request.fingerprint) throw new ConflictException("Recovery scope, source, policy or pricing changed. Prepare and approve a new request.");
  }
  async execute(user: User, projectId: string, requestId: string, fingerprint: string) {
    const request = await this.db.transaction(async (manager) => {
      await lockProjectConfiguration(manager, projectId);
      const access = await this.access(user, projectId, true, manager);
      const request = await manager.getRepository(GovernedRecoveryRequest).findOne({ where: { id: requestId, projectId }, lock: { mode: "pessimistic_write" } });
      if (!request) throw new NotFoundException("Recovery request not found.");
      if (request.fingerprint !== fingerprint || recoveryFingerprint(request.content) !== fingerprint) throw new ConflictException("Recovery fingerprint changed.");
      if (["running", "resolved", "failed", "unverified"].includes(request.status)) return request;
      if (request.status !== "approved") throw new ConflictException("Exact human approval is required.");
      const decision = await manager.getRepository(GovernedRecoveryDecision).findOne({ where: { requestId } });
      const approver = decision && await this.users.findById(decision.actorUserId);
      if (!decision || decision.fingerprint !== fingerprint || !approver || !canApproveProject(approver, access.project)) throw new ForbiddenException("The approving identity no longer has recovery authority.");
      await this.revalidate(access.user, access.project, request);
      const [count] = await manager.query(`SELECT count(*)::integer AS count FROM governed_recovery_requests WHERE project_id=$1 AND incident_id=$2 AND content->>'runbookId'=$3 AND started_at IS NOT NULL`, [projectId, request.incidentId, request.content.runbookId]);
      if (count.count >= request.content.maxAttempts) throw new ConflictException("This incident reached its runbook retry ceiling.");
      request.status = "running"; request.startedAt = new Date(); await manager.getRepository(GovernedRecoveryRequest).save(request); return request;
    });
    if (request.operationId || request.completedAt || !request.startedAt || request.outcome?.dispatchStarted) return { request };
    // A persisted one-way dispatch claim prevents replay, including a process crash after provider mutation.
    const [claimed] = await this.db.query(`UPDATE governed_recovery_requests SET outcome='{"dispatchStarted":true}'::jsonb WHERE id=$1 AND status='running' AND outcome IS NULL RETURNING id`, [request.id]);
    if (!claimed?.length && !claimed?.id) return { request };
    try {
      const access = await this.access(user, projectId, true); await this.revalidate(access.user, access.project, request);
      let operation: any;
      if (request.content.runbookId === "verified_rollback") operation = await this.railpack.rollback(access.user, projectId, request.content.parameters.targetOperationId);
      else if (request.content.runbookId === "idempotent_retry") operation = await this.railpack.retry(access.user, projectId);
      else await this.mutateEcs(access.user, access.project, request);
      request.operationId = operation?.deployment?.operation?.id || null;
      request.outcome = { dispatchStarted: true, providerAccepted: true, verification: "UNVERIFIED" };
      if (operation?.deployment?.state === "rejected") { request.status = "failed"; request.completedAt = new Date(); request.outcome.providerAccepted = false; }
      await this.db.getRepository(GovernedRecoveryRequest).save(request); await this.record(access.user, request, "recovery_execution_requested");
      return { request };
    } catch (error) {
      request.status = "unverified"; request.completedAt = new Date(); request.outcome = { dispatchStarted: true, providerAccepted: "unknown", verification: "UNVERIFIED", reason: error instanceof ServiceUnavailableException ? "Provider authority is unavailable." : "Execution failed or could not be verified; investigate before retrying." };
      await this.db.getRepository(GovernedRecoveryRequest).save(request); await this.record(user, request, "recovery_unverified"); throw error;
    }
  }
  private async mutateEcs(user: User, project: Project, request: GovernedRecoveryRequest) {
    const scope = request.content.scope, target = request.content.service;
    await this.customer.withEcsSession({ organizationId: project.organizationId, bindingId: project.awsAccountBindingId!, region: scope.region, projectId: project.id, operationId: request.id, purpose: request.content.runbookId === "ecs_restart" ? "restart" : "replicas" }, async ({ credentials, accountId, region }) => {
      if (accountId !== scope.accountId || !target.ecsServiceArn.startsWith(`arn:aws:ecs:${region}:${accountId}:service/`)) throw new ForbiddenException("Recovery service does not belong to the approved account.");
      const client = new ECSClient({ credentials, region, maxAttempts: 1 }); const signal = AbortSignal.timeout(30000);
      try {
        const [description, tags] = await Promise.all([client.send(new DescribeServicesCommand({ cluster: target.ecsClusterArn, services: [target.ecsServiceArn], include: ["TAGS"] }), { abortSignal: signal }), client.send(new ListTagsForResourceCommand({ resourceArn: target.ecsServiceArn }), { abortSignal: signal })]);
        const service = description.services?.[0]; const tag = (key: string) => tags.tags?.find((item) => item.key === key)?.value;
        if (description.failures?.length || !service || service.serviceArn !== target.ecsServiceArn || service.clusterArn !== target.ecsClusterArn || service.taskDefinition !== target.taskDefinitionArn || tag("DeployGuardProjectId") !== project.id || tag("ManagedBy") !== "DeployGuard") throw new ForbiddenException("Immediate service identity and ownership verification failed.");
        const fresh = await this.access(user, project.id, true); const decision = await this.db.getRepository(GovernedRecoveryDecision).findOne({ where: { requestId: request.id } });
        const approver = decision && await this.users.findById(decision.actorUserId);
        if (!approver || !canApproveProject(approver, fresh.project)) throw new ForbiddenException("Recovery approval was revoked before mutation.");
        await this.revalidate(fresh.user, fresh.project, request);
        await client.send(new UpdateServiceCommand({ cluster: target.ecsClusterArn, service: target.ecsServiceArn,
          ...(request.content.runbookId === "ecs_restart" ? { forceNewDeployment: true } : { desiredCount: request.content.parameters.replicas }) }), { abortSignal: signal });
      } finally { client.destroy(); }
    });
  }
  async verify(user: User, projectId: string, requestId: string) {
    const access = await this.access(user, projectId); const request = await this.db.getRepository(GovernedRecoveryRequest).findOne({ where: { id: requestId, projectId } });
    if (!request) throw new NotFoundException("Recovery request not found.");
    if (request.status !== "running") return { request };
    if (request.operationId) {
      const history = await this.railpack.history(access.user, projectId); const operation = history.operations.find((item) => item.id === request.operationId);
      if (!operation || ![PipelineRunStatus.COMPLETED, PipelineRunStatus.FAILED, PipelineRunStatus.CANCELLED].includes(operation.status)) {
        if (Date.now() - request.startedAt!.getTime() <= request.content.timeoutSeconds * 1000) return { request };
        request.status = "unverified"; request.outcome = { verification: "UNVERIFIED", reason: "Recovery exceeded its verification deadline; no further automatic action was issued." };
      } else if (operation.status !== PipelineRunStatus.COMPLETED) { request.status = "failed"; request.outcome = { verification: "FAILED", operationId: operation.id }; }
    }
    if (request.status === "running") {
      const current = await this.state.getCurrentState(access.user, projectId, { refreshCloudState: true });
      const matching = request.operationId ? current.stableRelease?.operationId === request.operationId : current.stableRelease?.id === request.content.scope.releaseId && recoveryFingerprint(current.stableRelease?.runtimeIdentity || current.infrastructureEvidence?.runtimeIdentity || {}) === request.content.scope.resourceFingerprint;
      const health = current.stateAuthority?.applicationHealth;
      const observedAfterAction = health?.observedAt && Date.parse(health.observedAt) >= request.startedAt!.getTime();
      request.status = recoveryOutcome({ application: observedAfterAction ? health?.status : "unavailable", infrastructure: current.stateAuthority?.infrastructure.exists, identityMatches: !!matching });
      if (request.status !== "resolved" && Date.now() - request.startedAt!.getTime() <= request.content.timeoutSeconds * 1000) return { request: { ...request, status: "running", outcome: { verification: request.status.toUpperCase(), reason: "Waiting for independent post-action observations." } } };
      request.outcome = { verification: request.status.toUpperCase(), observedAt: health?.observedAt || null, applicationHealth: health?.status || "unavailable", infrastructure: current.stateAuthority?.infrastructure.exists ?? null, identityMatches: !!matching };
    }
    request.completedAt = new Date(); await this.db.getRepository(GovernedRecoveryRequest).save(request); await this.record(access.user, request, `recovery_${request.status}`); return { request };
  }
  private record(user: User, request: GovernedRecoveryRequest, action: string) { return this.audit.record({ actorUser: user, action, resourceType: "project", resourceId: request.projectId, status: request.status, metadata: { organizationId: request.organizationId, recoveryRequestId: request.id, incidentId: request.incidentId, fingerprint: request.fingerprint, runbookId: request.content.runbookId, operationId: request.operationId } }); }
}
