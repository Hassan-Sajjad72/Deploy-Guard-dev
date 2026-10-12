import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { randomUUID } from "crypto";
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient } from "@aws-sdk/client-ecs";
import { UsersService } from "../users/users.service";
import { User } from "../users/user.entity";
import { Project } from "../projects/project.entity";
import { ProjectCurrentStateService } from "../projects/current-state/project-current-state.service";
import { canAccessProject, canApproveProject } from "../workspaces/project-access";
import { AuditLogService } from "../audit-log/audit-log.service";
import { planFingerprint } from "../planning/deployment-plan";
import { LiveRuntimeResolverService } from "../observability/live-runtime-resolver.service";
import { CloudWatchMetricsService } from "../observability/cloudwatch-metrics.service";
import { IntelligenceRecord } from "./intelligence-record.entity";
import { approvedApiProbe } from "./approved-api-probe";
import { ApproveApiContractDto, CreateOptimizationDto, RegisterApiContractDto } from "./intelligence.dto";
import { buildIncident, matchesResponseSchema, measuredOptimization, providerOptimization, resourceFingerprint, safeEndpointPath, validateApiContract } from "./intelligence-evidence";
import { CustomerRuntimeEvidenceService } from "./customer-runtime-evidence.service";
import { LiveRuntimeIdentityRecoveryService } from "../projects/current-state/live-runtime-identity-recovery.service";
import { HostingProviderAdapterService } from "../planning/hosting-provider-adapter.service";

@Injectable()
export class IntelligenceService {
  private readonly running = new Set<string>();
  constructor(private readonly data: DataSource, private readonly users: UsersService, private readonly states: ProjectCurrentStateService,
    private readonly audit: AuditLogService, private readonly runtime: LiveRuntimeResolverService, private readonly metrics: CloudWatchMetricsService, private readonly customerRuntime: CustomerRuntimeEvidenceService, private readonly persistedRuntime: LiveRuntimeIdentityRecoveryService, @Optional() private readonly providers?: HostingProviderAdapterService) {}

  private async access(user: User, projectId: string, write = false) {
    const [fresh, project] = await Promise.all([this.users.findById(user.id), this.data.getRepository(Project).findOne({ where: { id: projectId } })]);
    if (!fresh || !project || project.status === "archived" || project.deletionIntentId || !canAccessProject(fresh, project, write)) throw new NotFoundException("Project not found");
    return { user: fresh, project };
  }
  async list(user: User, projectId: string) {
    const scope = await this.access(user, projectId);
    const records = await this.data.getRepository(IntelligenceRecord).find({ where: { projectId }, order: { createdAt: "DESC" }, take: 100 });
    const ids = records.filter((record) => record.kind === "api_contract").map((record) => record.id);
    const approvals = ids.length ? await this.data.query(`SELECT contract_id AS "contractId",fingerprint,expires_at AS "expiresAt",actor_user_id AS "actorUserId" FROM api_assurance_approvals WHERE contract_id=ANY($1::uuid[])`, [ids]) : [];
    return { records, approvals, canManage: canAccessProject(scope.user, scope.project, true), canApprove: canApproveProject(scope.user, scope.project) };
  }
  async get(user: User, projectId: string, id: string, kind?: IntelligenceRecord["kind"]) {
    await this.access(user, projectId);
    const record = await this.data.getRepository(IntelligenceRecord).findOne({ where: { id, projectId, ...(kind ? { kind } : {}) } });
    if (!record) throw new NotFoundException("Evidence record not found");
    return { record };
  }
  private async persist(user: User, project: Project, kind: IntelligenceRecord["kind"], content: Record<string, any>) {
    await this.access(user, project.id, true);
    const record = await this.data.getRepository(IntelligenceRecord).save({ id: randomUUID(), projectId: project.id, organizationId: project.organizationId || null, kind, content, fingerprint: planFingerprint(content), createdByUserId: user.id });
    await this.audit.record({ actorUser: user, action: `INTELLIGENCE_${kind.toUpperCase()}_RECORDED`, resourceType: "project", resourceId: project.id, status: "success", metadata: { projectId: project.id, organizationId: project.organizationId, recordId: record.id, fingerprint: record.fingerprint } });
    return { record };
  }
  async incident(user: User, projectId: string) {
    const scope = await this.access(user, projectId, true);
    const state = scope.project.executionMode === "customer" ? await this.customerIncidentState(scope.project, scope.user) : await this.states.getCurrentState(scope.user, projectId);
    const now = new Date(); const since = new Date(now.getTime() - 24 * 3600_000);
    const operations = await this.data.query(`SELECT id,status,commit_sha,created_at,updated_at FROM project_pipeline_runs WHERE project_id=$1 AND updated_at>=$2 ORDER BY created_at DESC LIMIT 20`, [projectId, since]);
    const operationId = operations[0]?.id || state.stableRelease?.operationId || null;
    const [events, metrics] = await Promise.all([
      this.data.query(`SELECT id,event_type,status,created_at FROM project_observability_events WHERE project_id=$1 AND created_at>=$2 AND pipeline_run_id=$3 ORDER BY created_at DESC LIMIT 50`, [projectId, since, operationId]),
      this.data.query(`SELECT id,metric_name,value,timestamp FROM project_runtime_metric_snapshots WHERE project_id=$1 AND timestamp>=$2 AND labels->>'releaseId'=$3 ORDER BY timestamp DESC LIMIT 100`, [projectId, since, state.stableRelease?.id || ""]),
    ]);
    const observedMetrics = (state as any).observedMetrics || [];
    return this.persist(scope.user, scope.project, "incident", buildIncident(scope.project, state, operations, events, [...metrics, ...observedMetrics], now));
  }

  private async customerIncidentState(project: Project, user?: User) {
    const [release] = await this.data.query(`SELECT id,commit_sha,deployed_at,deployed_by_pipeline_run_id,health_check_path FROM project_stable_releases WHERE project_id=$1 AND environment_name=$2 AND status='stable' AND metadata->>'releaseEvidenceVerified'='true' ORDER BY deployed_at DESC LIMIT 1`, [project.id, project.environmentName]);
    const identity = release ? await this.persistedRuntime.recover(project) : null;
    const state: any = { stableRelease: release ? { id: release.id, commit: release.commit_sha, promotedAt: new Date(release.deployed_at).toISOString(), operationId: release.deployed_by_pipeline_run_id, runtimeIdentity: identity || {} } : null, stateAuthority: { applicationHealth: { status: "unavailable", observedAt: null } }, observedMetrics: [] };
    if (!release && user && this.providers) return this.providerIncidentState(project, user, state);
    if (!release || !project.applicationEntryPointServiceId) return state;
    try {
      const measured = await this.customerRuntime.measure(project, project.applicationEntryPointServiceId);
      if (measured.record.releaseId === release.id) state.observedMetrics = measured.rows.slice(0, 100).map((row) => ({ ...row, id: planFingerprint({ metric: row.metric_name, timestamp: row.timestamp, releaseId: release.id }) }));
      const target = await this.customerRuntime.apiTarget(project, project.applicationEntryPointServiceId);
      if (target.releaseId !== release.id) return { ...state, stableRelease: null, observedMetrics: [] };
      const health = await approvedApiProbe(target.origin, safeEndpointPath(release.health_check_path || "/health"), "GET", "", AbortSignal.timeout(5_000));
      state.stateAuthority.applicationHealth = { status: health.status >= 200 && health.status < 400 ? "healthy" : health.status >= 400 && health.status < 600 ? "failed" : "unavailable", observedAt: new Date().toISOString() };
    } catch { /* Missing customer ownership, metrics or HTTPS observation remains explicit unavailable evidence. */ }
    return state;
  }

  // EC2, Lightsail, static and Lambda generations: observed evidence comes from the provider adapter's read-only session.
  private async providerIncidentState(project: Project, user: User, state: any) {
    try {
      const observed: any = await this.providers!.observe(user, project.id);
      if (observed.status !== "live") return state;
      state.stableRelease = { id: observed.generationId, commit: observed.sourceSha, promotedAt: observed.promotedAt, operationId: observed.operationId, runtimeIdentity: { profile: observed.profile, accountId: observed.accountId, region: observed.region } };
      state.stateAuthority.applicationHealth = { status: observed.endpoint.application === "healthy" ? "healthy" : observed.endpoint.application === "unhealthy" ? "failed" : "unavailable", observedAt: observed.endpoint.observedAt };
      state.observedMetrics = observed.metrics.slice(0, 100).map((row: any) => ({ metric_name: `${observed.profile}_${row.metric}`, timestamp: row.timestamp, value: row.value, id: planFingerprint({ metric: row.metric, timestamp: row.timestamp, generationId: observed.generationId }) }));
    } catch { /* Unavailable provider observation remains explicit unavailable evidence. */ }
    return state;
  }

  private async apiScope(user: User, project: Project, serviceId: string) {
    if (!["staging", "sandbox"].includes(project.environmentName)) throw new ForbiddenException("API assurance is limited to approved staging or sandbox environments");
    if (project.executionMode === "customer") {
      const provider = await this.providers?.liveTarget(user, project.id, serviceId);
      if (provider) { const { healthPath: _health, promotedAt: _promoted, operationId: _operation, ...target } = provider; return target; }
      return this.customerRuntime.apiTarget(project, serviceId);
    }
    const [identity, state] = await Promise.all([this.runtime.resolveForUser(user, project.id, serviceId), this.states.getCurrentState(user, project.id)]);
    if (!identity.publicUrl || !state.stableRelease || identity.releaseId !== state.stableRelease.id || !/^[a-f0-9]{40}$/.test(state.stableRelease.commit)) throw new ConflictException("A verified immutable release and service endpoint are required");
    const endpoint = new URL(identity.publicUrl);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash) throw new BadRequestException("API assurance requires the verified release to expose a credential-free HTTPS endpoint");
    return { projectId: project.id, organizationId: project.organizationId || null, environment: project.environmentName, serviceId,
      origin: endpoint.origin, releaseId: identity.releaseId, sourceSha: state.stableRelease.commit,
      generationId: identity.generationId, resourceFingerprint: resourceFingerprint(state.stableRelease.runtimeIdentity) };
  }
  async registerContract(user: User, projectId: string, input: RegisterApiContractDto) {
    const scope = await this.access(user, projectId, true);
    const probes = validateApiContract(input.specification);
    const healthPath = safeEndpointPath(input.healthPath);
    if (!probes.some((probe) => probe.path === healthPath && probe.method === "GET")) throw new BadRequestException("Register the health GET endpoint in the contract");
    const target = await this.apiScope(scope.user, scope.project, input.serviceId);
    return this.persist(scope.user, scope.project, "api_contract", { contractVersion: 1, target, healthPath, specificationFingerprint: planFingerprint(input.specification), probes, bounds: { maxRequests: 12, timeoutSeconds: 45, responseBytes: 65_536 }, authority: "read_only", approvalRequired: true });
  }
  async approveContract(user: User, projectId: string, id: string, input: ApproveApiContractDto) {
    const scope = await this.access(user, projectId);
    if (!canApproveProject(scope.user, scope.project)) throw new ForbiddenException("A project approver must authorize API assurance");
    const { record } = await this.get(scope.user, projectId, id, "api_contract");
    if (record.fingerprint !== input.fingerprint || planFingerprint(record.content) !== record.fingerprint) throw new ConflictException("Contract fingerprint changed");
    if (!input.reason.trim()) throw new BadRequestException("An approval reason is required");
    const current = await this.apiScope(scope.user, scope.project, record.content.target.serviceId);
    if (planFingerprint(current) !== planFingerprint(record.content.target)) throw new ConflictException("Release or target changed; register a new contract");
    const approval = await this.data.transaction(async (manager) => {
      const refreshed = await this.access(scope.user, projectId);
      if (!canApproveProject(refreshed.user, refreshed.project)) throw new ForbiddenException("Approver authorization changed");
      const [row] = await manager.query(`INSERT INTO api_assurance_approvals(contract_id,actor_user_id,fingerprint,expires_at,reason) VALUES ($1,$2,$3,NOW()+interval '1 hour',$4) ON CONFLICT DO NOTHING RETURNING *`, [id, scope.user.id, record.fingerprint, input.reason.trim()]);
      if (!row) throw new ConflictException("This contract already has a final approval; register a new contract to renew authorization");
      return row;
    });
    await this.audit.record({ actorUser: scope.user, action: "API_ASSURANCE_APPROVED", resourceType: "project", resourceId: projectId, status: "success", metadata: { projectId, organizationId: scope.project.organizationId, contractId: id, fingerprint: record.fingerprint, reason: input.reason.trim() } });
    return { approval };
  }
  async runContract(user: User, projectId: string, id: string) {
    const scope = await this.access(user, projectId, true);
    const { record } = await this.get(scope.user, projectId, id, "api_contract");
    const lock = `api-assurance:${projectId}`;
    if (this.running.has(lock)) throw new ConflictException("An API assurance run is already active");
    this.running.add(lock);
    try {
      return await this.data.transaction(async (manager) => {
        const [{ acquired }] = await manager.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`, [lock]);
        if (!acquired) throw new ConflictException("An API assurance run is already active");
        const [approval] = await manager.query(`SELECT approval.* FROM api_assurance_approvals approval WHERE contract_id=$1 AND fingerprint=$2 AND expires_at>NOW()`, [id, record.fingerprint]);
        if (!approval || planFingerprint(record.content) !== record.fingerprint) throw new ForbiddenException("A current fingerprint-bound approval is required");
        const approver = await this.users.findById(approval.actor_user_id);
        if (!approver || !canApproveProject(approver, scope.project)) throw new ForbiddenException("The approving user's authorization is no longer valid");
        const target = await this.apiScope(scope.user, scope.project, record.content.target.serviceId);
        if (planFingerprint(target) !== planFingerprint(record.content.target)) throw new ConflictException("Release or target changed; approve a newly registered contract");
        const [{ count }] = await manager.query(`SELECT COUNT(*)::int AS count FROM operational_intelligence_records WHERE project_id=$1 AND kind='api_run' AND created_at>NOW()-interval '1 hour'` , [projectId]);
        if (count >= 5) throw new ForbiddenException("API assurance is limited to five runs per project per hour");
        const startedAt = new Date().toISOString(); const signal = AbortSignal.timeout(45_000);
        const results: Array<Record<string, unknown>> = [];
        for (const probe of record.content.probes) {
          const variants = [{ kind: "regression", query: "" }, ...probe.parameters.filter((parameter: any) => parameter.type !== "string").slice(0, 1).map((parameter: any) => ({ kind: "bounded_contract_fuzz", query: `?${parameter.name}=deployguard-invalid-type` }))];
          for (const variant of variants) {
            if (results.length >= 12 || signal.aborted || new Date(approval.expires_at).getTime() <= Date.now()) { results.push({ path: probe.path, method: probe.method, kind: variant.kind, result: "UNVERIFIED", reason: "Execution or approval deadline reached" }); break; }
            await this.access(scope.user, projectId, true);
            try {
              const observation = await approvedApiProbe(target.origin, probe.path, probe.method, variant.query, signal);
              const expected = probe.responses[String(observation.status)];
              let matched = Boolean(expected);
              if (matched && expected.schema && probe.method !== "HEAD") {
                try { matched = observation.contentType.includes("application/json") && matchesResponseSchema(JSON.parse(observation.body.toString("utf8")), expected.schema); } catch { matched = false; }
              }
              const healthFailed = probe.path === record.content.healthPath && (observation.status < 200 || observation.status >= 400);
              results.push({ path: probe.path, method: probe.method, kind: variant.kind, result: matched && !healthFailed ? "PASSED" : "FAILED", httpStatus: observation.status, responseFingerprint: planFingerprint(observation.body.toString("base64")), reason: healthFailed ? "Health endpoint returned an unsuccessful HTTP status" : matched ? "Declared status and supported response schema match" : "Observed status or response schema differs from the registered contract" });
            } catch { results.push({ path: probe.path, method: probe.method, kind: variant.kind, result: "UNVERIFIED", reason: "Transport, DNS, TLS, timeout or response limit prevented a bounded observation" }); }
          }
        }
        try { const finalTarget = await this.apiScope(scope.user, scope.project, record.content.target.serviceId); if (planFingerprint(finalTarget) !== planFingerprint(target)) results.push({ result: "UNVERIFIED", reason: "Release identity changed during execution" }); }
        catch { results.push({ result: "UNVERIFIED", reason: "Release identity could not be revalidated after execution" }); }
        return this.persist(scope.user, scope.project, "api_run", { contractVersion: 1, executionId: randomUUID(), contractId: id, contractFingerprint: record.fingerprint, specificationFingerprint: record.content.specificationFingerprint, approvalId: id, target, startedAt, completedAt: new Date().toISOString(), results, result: results.some((result) => result.result === "FAILED") ? "FAILED" : results.some((result) => result.result === "UNVERIFIED") ? "UNVERIFIED" : "PASSED", authority: "read_only" });
      });
    } finally { this.running.delete(lock); }
  }

  async optimize(user: User, projectId: string, input: CreateOptimizationDto) {
    const scope = await this.access(user, projectId, true);
    if (scope.project.executionMode === "customer" && this.providers) {
      const observed: any = await this.providers.observe(scope.user, projectId);
      if (observed.status === "live") {
        if (observed.metricsStatus !== "observed") throw new ServiceUnavailableException(observed.metricsReason || "Provider metrics are unavailable");
        const content = providerOptimization(observed.profile, observed.metrics, observed.assumptions, new Date(observed.window.start), new Date(observed.window.end), observed.generationId);
        return this.persist(scope.user, scope.project, "optimization", { ...content, serviceId: input.serviceId, scope: { projectId, environment: scope.project.environmentName, generationId: observed.generationId, profile: observed.profile, serviceId: input.serviceId }, planningRoute: `/projects/${projectId}/planning`, authority: "observed_provider_runtime" });
      }
    }
    if (scope.project.executionMode === "customer") {
      const { record, allocation, rows, start, end } = await this.customerRuntime.measure(scope.project, input.serviceId);
      return this.persist(scope.user, scope.project, "optimization", { ...measuredOptimization(rows, allocation, start, end, record.releaseId, input.serviceId), scope: { projectId, environment: scope.project.environmentName, releaseId: record.releaseId, serviceId: input.serviceId, taskDefinitionArn: record.identity.taskDefinitionArn }, planningRoute: `/projects/${projectId}/planning`, observationsFingerprint: planFingerprint(rows) });
    }
    const identity = await this.runtime.resolveForUser(scope.user, projectId, input.serviceId);
    const telemetry = await this.metrics.collect(identity, input.range);
    if (!telemetry.available || telemetry.cacheStatus === "stale" || telemetry.releaseId !== identity.releaseId) throw new ServiceUnavailableException("Fresh correlated runtime measurements are required");
    const ecs = new ECSClient({ region: identity.region, maxAttempts: 2 });
    let allocation: { cpu: number; memoryMiB: number; replicas: number };
    try {
      const [task, services] = await Promise.all([
        ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: identity.taskDefinitionArn }), { abortSignal: AbortSignal.timeout(10_000) }),
        ecs.send(new DescribeServicesCommand({ cluster: identity.cluster, services: [identity.serviceArn] }), { abortSignal: AbortSignal.timeout(10_000) }),
      ]);
      const service = services.services?.[0];
      if (task.taskDefinition?.taskDefinitionArn !== identity.taskDefinitionArn || service?.serviceArn !== identity.serviceArn || service.taskDefinition !== identity.taskDefinitionArn || services.failures?.length) throw new ConflictException("Observed allocation does not match this immutable release");
      allocation = { cpu: Number(task.taskDefinition.cpu) / 1024, memoryMiB: Number(task.taskDefinition.memory), replicas: service.desiredCount || 0 };
    } finally { ecs.destroy(); }
    const end = new Date(telemetry.collectedAt); const start = new Date(end.getTime() - 24 * 3600_000);
    const state = await this.states.getCurrentState(scope.user, projectId);
    const releaseCoversWindow = state.stableRelease?.id === identity.releaseId && Date.parse(state.stableRelease.promotedAt) <= start.getTime();
    const rows = releaseCoversWindow ? [telemetry.cpu, telemetry.memory].flatMap((series) => series.points.map((point) => ({ metric_name: series.metricName, value: point.value, timestamp: point.timestamp, labels: { releaseId: identity.releaseId, serviceId: identity.serviceId } }))) : [];
    const recommendation = measuredOptimization(rows, allocation, start, end, identity.releaseId, identity.serviceId);
    const latest = await this.runtime.resolveForUser(scope.user, projectId, input.serviceId);
    if (latest.releaseId !== identity.releaseId || latest.taskDefinitionArn !== identity.taskDefinitionArn) throw new ConflictException("Release changed during measurement");
    return this.persist(scope.user, scope.project, "optimization", { ...recommendation, scope: { projectId, environment: scope.project.environmentName, releaseId: identity.releaseId, serviceId: identity.serviceId, taskDefinitionArn: identity.taskDefinitionArn }, planningRoute: `/projects/${projectId}/planning`, observationsFingerprint: planFingerprint(rows) });
  }
}
