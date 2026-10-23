import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiProviderAdapter } from "../ai-troubleshooting/ai-provider.adapter";
import { randomUUID } from "node:crypto";
import { DataSource, EntityManager } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { User } from "../users/user.entity";
import { AwsAccountBinding } from "../workspaces/aws-account-binding.entity";
import { canAccessProject, canApproveProject } from "../workspaces/project-access";
import { validateAgencyProjectScope } from "../workspaces/agency-project-scope";
import { Project, ProjectStatus } from "../projects/project.entity";
import { ProjectDeployableService } from "../projects/project-deployable-service.entity";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { DatabaseTierProvider, ProjectDatabaseTier } from "../projects/project-database-tier.entity";
import { acquireProjectConfigurationAdvisoryLock } from "../projects/project-configuration-lock";
import { canonicalEnvironmentName } from "../projects/canonical-environment";
import { GithubAppService } from "../projects/github-app.service";
import { RepositorySourceService } from "../projects/repository-source.service";
import { isSupportedManagedDatabaseEngine } from "../projects/managed-database-engine";
import { compareHosting, DeploymentPlanContent, hostingCatalog, planFingerprint } from "./deployment-plan";
import { DeploymentPlan, DeploymentPlanDecision } from "./deployment-plan.entity";
import { CreateDeploymentPlanDto, DeploymentPlanDecisionDto } from "./planning.dto";
import { HostingPricingService } from "./hosting-pricing.service";

@Injectable()
export class PlanningService {
  constructor(private readonly database: DataSource, private readonly source: RepositorySourceService,
    private readonly github: GithubAppService, private readonly audit: AuditLogService,
    private readonly ai: AiProviderAdapter, private readonly config: ConfigService,
    @Optional() private readonly pricing?: HostingPricingService) {}

  async interpretGoal(user: User, projectId: string, prompt: string) {
    const project = await this.project(this.database.manager, user, projectId, true);
    if (!prompt.trim()) throw new BadRequestException("Enter a deployment goal.");
    const availability = await this.ai.availability();
    if (!availability.available) throw new ServiceUnavailableException("AI planning is unavailable. Continue with the guided workload form.");
    const configured = Number(this.config.get<string>("AI_PLANNING_DAILY_LIMIT", "10"));
    const limit = Number.isInteger(configured) ? Math.min(Math.max(configured, 1), 100) : 10;
    const reserved = await this.database.query(`WITH reserved AS (
      INSERT INTO deployment_planning_ai_usage(user_id, usage_day, request_count) VALUES($1, (now() AT TIME ZONE 'UTC')::date, 1)
      ON CONFLICT(user_id, usage_day) DO UPDATE SET request_count = deployment_planning_ai_usage.request_count + 1
      WHERE deployment_planning_ai_usage.request_count < $2 RETURNING request_count
      ) SELECT request_count FROM reserved`, [user.id, limit]);
    if (!reserved.length) throw new HttpException("Daily AI planning limit reached. Continue with the guided form.", HttpStatus.TOO_MANY_REQUESTS);
    let result: Awaited<ReturnType<AiProviderAdapter["interpretDeploymentGoal"]>>;
    try { result = await this.ai.interpretDeploymentGoal(prompt, project.organizationId); }
    catch (error) { if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) throw error;
      throw new ServiceUnavailableException("AI planning could not return validated suggestions. Continue with the guided form."); }
    await this.audit.record({ actorUser: user, action: "DEPLOYMENT_GOAL_INTERPRETED", resourceType: "project", resourceId: projectId,
      status: "success", metadata: { projectId, provider: result.provider, model: result.model, userReviewRequired: true } });
    return { ...result, userReviewRequired: true, mutationsAuthorized: false };
  }

  async catalog(user: User, projectId: string) { await this.project(this.database.manager, user, projectId); return { profiles: hostingCatalog }; }
  async list(user: User, projectId: string) {
    await this.project(this.database.manager, user, projectId);
    return this.database.getRepository(DeploymentPlan).find({ where: { projectId }, order: { version: "DESC" }, take: 50 });
  }
  async get(user: User, projectId: string, id: string) {
    const project = await this.project(this.database.manager, user, projectId);
    const plan = await this.database.getRepository(DeploymentPlan).findOneBy({ id, projectId });
    if (!plan) throw new NotFoundException("Deployment plan not found.");
    return { plan, decision: await this.database.getRepository(DeploymentPlanDecision).findOneBy({ planId: id }), canApprove: Boolean(await this.approvalRole(this.database.manager, user, project)) };
  }

  async create(user: User, projectId: string, dto: CreateDeploymentPlanDto) {
    const snapshot = await this.database.transaction("REPEATABLE READ", (manager) => this.snapshot(manager, user, projectId, dto));
    const { project, services, variables, database, binding } = snapshot;
    if (!services.length) throw new BadRequestException("Configure at least one deployable service before planning.");
    const credential = await this.github.tokenForRepository(user.id, project.repositoryFullName, project.githubInstallationId);
    const sourceSha = await this.source.resolveSourceSha({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch, accessToken: credential.token });
    const build = await this.source.resolveBuildTargetsAtExactSha({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch, sourceSha,
      services: services.map((service) => ({ serviceId: service.id, serviceDirectory: service.serviceDirectory, buildTargetOverride: service.buildTargetOverride })), accessToken: credential.token });
    const managed = database?.provider === DatabaseTierProvider.MANAGED && database.attachedServiceId && isSupportedManagedDatabaseEngine(database.engine)
      ? { engine: database.engine, attachedServiceId: database.attachedServiceId } : null;
    const requirements = await this.source.resolveRequirementsAtExactSha({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch, sourceSha,
      targets: build.targets, variables, managedDatabase: managed, accessToken: credential.token });
    const costs = this.pricing ? await this.pricing.estimate({ region: dto.region, assumptions: dto.assumptions, serviceCount: services.length, managedDatabase: Boolean(managed) }) : [];
    const comparison = compareHosting({ region: dto.region, assumptions: dto.assumptions, targets: build.targets.map((item) => item.target), managedDatabase: Boolean(managed), requirements }, costs);
    const selected = comparison.options.find((option) => option.id === dto.profile)!;
    const blockers = [...selected.reasons];
    if (binding.verificationStatus !== "verified") blockers.push("AWS account identity and read authorization have not been verified.");
    if (binding.verificationEvidence?.mutationAuthority !== "verified") blockers.push("Scoped customer execution authority has not been verified.");
    if (managed && !dto.assumptions.stateful) blockers.push("A persistent database requires stateful workload assumptions.");
    const ports = new Map(build.ports.map((item) => [item.serviceId, item.servicePort]));
    const targets = new Map(build.targets.map((item) => [item.serviceId, item.target]));
    if (services.some((service) => !ports.get(service.id) || !targets.get(service.id))) throw new BadRequestException("Every service requires a resolved build target and application port.");
    const content: DeploymentPlanContent = {
      contractVersion: "deployguard.deployment-plan/v1", operationId: randomUUID(),
      ownership: { organizationId: project.organizationId, clientId: project.clientId || null, engagementId: project.engagementId || null, bindingId: binding.id, accountId: binding.accountId, roleArn: binding.roleArn,
        bindingVersion: binding.verificationVersion, region: dto.region, environment: canonicalEnvironmentName(project) },
      repository: { url: project.repositoryUrl, fullName: project.repositoryFullName, branch: project.targetBranch, sourceSha },
      configurationFingerprint: snapshot.fingerprint, assumptions: dto.assumptions, selectedProfile: dto.profile,
      services: services.map((service) => ({ id: service.id, name: service.name, directory: service.serviceDirectory, port: ports.get(service.id)!, buildTarget: targets.get(service.id)! })),
      environmentReferences: variables.map((variable) => ({ id: variable.id, serviceId: variable.serviceId, key: variable.key, scope: variable.scope,
        isSecret: variable.isSecret, fingerprint: variable.configurationFingerprint })),
      dependencies: { database: database ? { provider: database.provider || "none", engine: database.engine,
        attachedServiceId: database.attachedServiceId, persistence: database.persistenceEnabled, backup: database.backupEnabled } : null },
      requirements, comparison, securityFindings: [{ status: "unverified", reason: "Trivy image scanning is performed during the existing build workflow; no source-specific image scan is available before this plan." }],
      status: blockers.length ? "blocked" : "review_required", blockers: [...new Set(blockers)],
      risks: ["Pricing and workload assumptions do not guarantee future AWS charges.", "Managed databases require explicit persistence and recovery verification.", "This plan does not authorize the legacy control-plane AWS workflow."],
    };
    const plan = await this.database.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager, projectId, canonicalEnvironmentName(project));
      const current = await this.snapshot(manager, user, projectId, dto);
      if (current.fingerprint !== snapshot.fingerprint) throw new ConflictException("Project configuration or AWS authorization changed during planning. Create a new plan.");
      const [{ version }] = await manager.query(`SELECT COALESCE(MAX(version), 0) + 1 AS version FROM deployment_plans WHERE project_id = $1`, [projectId]);
      return manager.getRepository(DeploymentPlan).save({ id: randomUUID(), projectId, organizationId: project.organizationId,
        version: Number(version), createdByUserId: user.id, fingerprint: planFingerprint(content), content });
    });
    await this.audit.record({ actorUser: user, action: "DEPLOYMENT_PLAN_CREATED", resourceType: "project", resourceId: projectId,
      status: "success", metadata: { projectId, organizationId: project.organizationId, planId: plan.id, version: plan.version, fingerprint: plan.fingerprint, status: content.status } });
    return plan;
  }

  async decide(user: User, projectId: string, id: string, dto: DeploymentPlanDecisionDto) {
    if (!dto.reason.trim()) throw new BadRequestException("A review decision reason is required.");
    const decision = await this.database.transaction(async (manager) => {
      const project = await this.project(manager, user, projectId);
      await acquireProjectConfigurationAdvisoryLock(manager, projectId, canonicalEnvironmentName(project));
      const actorRole = await this.approvalRole(manager, user, project);
      if (!actorRole) throw new ForbiddenException("A workspace owner, administrator or deployment approver is required.");
      const plan = await manager.getRepository(DeploymentPlan).findOneBy({ id, projectId });
      if (!plan) throw new NotFoundException("Deployment plan not found.");
      if (plan.fingerprint !== dto.fingerprint || planFingerprint(plan.content) !== dto.fingerprint) throw new ConflictException("Reviewed deployment plan fingerprint does not match.");
      const existing = await manager.getRepository(DeploymentPlanDecision).findOneBy({ planId: id });
      if (existing) throw new ConflictException("This immutable plan already has a decision. Create a new version to change it.");
      if (dto.decision === "approved") {
        if (plan.content.status !== "review_required" || plan.content.blockers.length) throw new ConflictException({ code: "PLAN_BLOCKED", message: "Resolve plan blockers before approval.", blockers: plan.content.blockers });
        const current = await this.snapshot(manager, user, projectId, { bindingId: plan.content.ownership.bindingId, region: plan.content.ownership.region }, false);
        if (current.fingerprint !== plan.content.configurationFingerprint) throw new ConflictException("Plan configuration or AWS authorization is stale. Create a new version.");
        if (!hostingCatalog.find((item) => item.id === plan.content.selectedProfile)?.available) throw new ConflictException("The selected hosting profile is unavailable.");
        const sourceSha = await this.source.resolveSourceSha({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch,
          accessToken: (await this.github.tokenForRepository(user.id, project.repositoryFullName, project.githubInstallationId)).token });
        if (sourceSha.toLowerCase() !== plan.content.repository.sourceSha.toLowerCase()) throw new ConflictException("Repository source changed. Create a new plan.");
      }
      return manager.getRepository(DeploymentPlanDecision).save({ planId: id, actorUserId: user.id, actorRole, organizationId: plan.organizationId,
        projectId, environment: plan.content.ownership.environment, operationId: plan.content.operationId,
        monthlyBudgetUsd: plan.content.assumptions.monthlyBudgetUsd.toFixed(2), decision: dto.decision, fingerprint: dto.fingerprint, reason: dto.reason.trim() });
    });
    await this.audit.record({ actorUser: user, action: "DEPLOYMENT_PLAN_DECIDED", resourceType: "project", resourceId: projectId,
      status: "success", metadata: { projectId, planId: id, decision: decision.decision, fingerprint: decision.fingerprint } });
    return decision;
  }

  private async project(manager: EntityManager, user: User, id: string, write = false) {
    const project = await manager.getRepository(Project).findOneBy({ id });
    if (!project || project.status === ProjectStatus.ARCHIVED || project.deletionIntentId) throw new NotFoundException("Project not found.");
    const memberships = project.organizationId ? await manager.query(`SELECT organization_id AS "organizationId", role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`, [project.organizationId, user.id]) : [];
    if (!canAccessProject({ ...user, organizationMemberships: memberships }, project, write)) throw new ForbiddenException("Authorized project workspace access required.");
    return project;
  }
  private async approvalRole(manager: EntityManager, user: User, project: Project) {
    const memberships = project.organizationId ? await manager.query(`SELECT organization_id AS "organizationId", role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`, [project.organizationId, user.id]) : [];
    return canApproveProject({ ...user, organizationMemberships: memberships }, project) ? memberships[0]?.role || "owner" : null;
  }
  private async snapshot(manager: EntityManager, user: User, projectId: string, dto: Pick<CreateDeploymentPlanDto, "bindingId" | "region">, manage = true) {
    const project = await this.project(manager, user, projectId, manage);
    if (!project.organizationId) throw new ConflictException("Project ownership migration is required before customer planning.");
    if (project.clientId || project.engagementId) await validateAgencyProjectScope(manager, project.organizationId, { ...project, awsAccountBindingId: dto.bindingId });
    if (project.awsAccountBindingId && project.awsAccountBindingId !== dto.bindingId) throw new BadRequestException("Plan AWS binding must match the project's authorized account binding.");
    const binding = await manager.getRepository(AwsAccountBinding).findOneBy({ id: dto.bindingId, organizationId: project.organizationId });
    if (!binding || binding.verificationStatus === "revoked") throw new NotFoundException("Active AWS account binding not found for this workspace.");
    if (!binding.regions.includes(dto.region)) throw new BadRequestException("Requested region is not authorized by this AWS binding.");
    const services = await manager.getRepository(ProjectDeployableService).find({ where: { projectId }, order: { position: "ASC" } });
    const variables = await manager.getRepository(ProjectEnvironmentVariable).createQueryBuilder("variable").addSelect("variable.value")
      .where("variable.projectId = :projectId AND variable.environment = :environment AND variable.isActive = true", { projectId, environment: canonicalEnvironmentName(project) }).orderBy("variable.id", "ASC").getMany();
    const database = await manager.getRepository(ProjectDatabaseTier).findOneBy({ projectId });
    const fingerprint = planFingerprint({ project: { organizationId: project.organizationId, clientId: project.clientId || null, engagementId: project.engagementId || null, repositoryUrl: project.repositoryUrl,
      repositoryFullName: project.repositoryFullName, installationId: project.githubInstallationId, branch: project.targetBranch,
      entrypoint: project.applicationEntryPointServiceId, environment: canonicalEnvironmentName(project), bindingId: project.awsAccountBindingId, executionMode: project.executionMode },
      services: services.map(({ id, name, serviceDirectory, buildTargetOverride, position }) => ({ id, name, serviceDirectory, buildTargetOverride, position })),
      variables: variables.map(({ id, serviceId, key, value, scope, isSecret }) => ({ id, serviceId, key, value, scope, isSecret })),
      database: database ? { provider: database.provider, engine: database.engine, attachedServiceId: database.attachedServiceId,
        persistence: database.persistenceEnabled, backup: database.backupEnabled, host: database.externalHost, port: database.externalPort, tls: database.externalTlsRequired } : null,
      binding: { id: binding.id, accountId: binding.accountId, roleArn: binding.roleArn, regions: binding.regions,
        status: binding.verificationStatus, version: binding.verificationVersion, evidence: binding.verificationEvidence } });
    return { project, services, variables, database, binding, fingerprint };
  }
}
