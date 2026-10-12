import { RailpackDeploymentService } from "../projects/railpack-deployment.service";
import { DESTROY_CONFIRMATION_PHRASE } from "../projects/destroy-confirmation";
import { customerMutationAuthorized } from "../workspaces/customer-authority-proof";
import { loadHostingArtifacts, validateProfileInputs } from "./hosting-profile-inputs";
import { HostingProfileRegistryService } from "./hosting-profile-registry.service";
import { classifyDependencies } from "./application-dependencies";
import { HostingBuildRecord, HostingBuildService } from "./hosting-build.service";
import { Optional } from "@nestjs/common";
import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
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
import { compareHosting, DeploymentPlanContent, hostingCatalog, planFingerprint, verifiedBuildKinds } from "./deployment-plan";
import { DeploymentPlan, DeploymentPlanDecision } from "./deployment-plan.entity";
import { CreateCustomerLifecyclePlanDto, CreateCustomerRetryPlanDto, CreateDeploymentPlanDto, DeploymentPlanDecisionDto } from "./planning.dto";
import { HostingPricingService } from "./hosting-pricing.service";
import { deploymentConfigurationFingerprint } from "./deployment-configuration";

@Injectable()
export class PlanningService {
  constructor(private readonly database: DataSource, private readonly source: RepositorySourceService,
    private readonly github: GithubAppService, private readonly audit: AuditLogService,
    private readonly ai: AiProviderAdapter, private readonly config: ConfigService,
    private readonly pricing: HostingPricingService, private readonly profiles?: HostingProfileRegistryService, private readonly execution?: RailpackDeploymentService,
    @Optional() private readonly builds?: HostingBuildService) {}

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

  async catalog(user: User, projectId: string, region = "") { await this.project(this.database.manager, user, projectId); return { profiles: this.profiles?.catalog(region) || hostingCatalog }; }
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
    const snapshot = await this.database.transaction("REPEATABLE READ", async (manager) => {
      const currentProject = await this.project(manager, user, projectId, true);
      await acquireProjectConfigurationAdvisoryLock(manager, projectId, canonicalEnvironmentName(currentProject));
      const selected = await this.snapshot(manager, user, projectId, dto);
      if (selected.project.executionMode === "customer" && !selected.project.awsAccountBindingId) {
        selected.project.awsAccountBindingId = selected.binding.id;
        await manager.getRepository(Project).save(selected.project);
        selected.fingerprint = deploymentConfigurationFingerprint(selected.project, selected.services, selected.variables, selected.database, selected.binding);
      }
      return selected;
    });
    const { project, services, variables, database, binding } = snapshot;
    if (!services.length) throw new BadRequestException("Configure at least one deployable service before planning.");
    const credential = await this.github.tokenForRepository(project.ownerUserId, project.repositoryFullName, project.githubInstallationId);
    const sourceSha = await this.source.resolveSourceSha({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch, accessToken: credential.token });
    const build = await this.source.resolveBuildTargetsAtExactSha({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch, sourceSha,
      services: services.map((service) => ({ serviceId: service.id, serviceDirectory: service.serviceDirectory, buildTargetOverride: service.buildTargetOverride })), accessToken: credential.token });
    const managed = database?.provider === DatabaseTierProvider.MANAGED && database.attachedServiceId && isSupportedManagedDatabaseEngine(database.engine)
      ? { engine: database.engine, attachedServiceId: database.attachedServiceId } : null;
    const requirements = await this.source.resolveRequirementsAtExactSha({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch, sourceSha,
      targets: build.targets, variables, managedDatabase: managed, accessToken: credential.token });
    const costs = await this.pricing.estimate({ region: dto.region, assumptions: dto.assumptions, serviceCount: services.length, managedDatabase: Boolean(managed), runtimeSecretCount: new Set(variables.filter((variable) => variable.isSecret).map((variable) => variable.serviceId)).size, database: managed ? { engine: managed.engine, backup: Boolean(snapshot.database?.backupEnabled) } : null });
    // Trusted build evidence (assets, hashes, scan, images) is merged server-side; users never type it.
    let profileInputs = dto.profileInputs ? validateProfileInputs(dto.profileInputs) : undefined;
    let buildRecord: HostingBuildRecord | null = null;
    const buildBlockers: string[] = [];
    if (dto.profile !== "ecs_fargate" && dto.buildId) {
      if (!this.builds) buildBlockers.push("Automated hosting build evidence is unavailable.");
      else try {
        const merged = await this.builds.mergeInputs(dto.buildId, { organizationId: project.organizationId, projectId, sourceSha, profile: dto.profile, accountId: binding.accountId, region: dto.region }, profileInputs);
        profileInputs = validateProfileInputs(merged.inputs); buildRecord = merged.record;
      } catch (error) { buildBlockers.push(error instanceof Error ? error.message : "Build evidence could not be applied."); }
    }
    const comparison = compareHosting({ region: dto.region, assumptions: dto.assumptions, targets: build.targets.map((item) => item.target), managedDatabase: Boolean(managed), requirements, verifiedBuildKinds: verifiedBuildKinds(buildRecord ? profileInputs : null), dependencies: classifyDependencies(requirements.requirements, managed?.engine || null), configuration: { references: variables.length, secrets: variables.filter((variable) => variable.isSecret).length } }, costs, this.profiles?.catalog(dto.region) || hostingCatalog);
    const selected = comparison.options.find((option) => option.id === dto.profile)!;
    const blockers = [...selected.reasons, ...buildBlockers];
    if (dto.profile === "ecs_fargate" && !dto.infrastructure?.executionRolePermissionsBoundaryArn) blockers.push("Seal the customer ECS task-role permissions boundary in the infrastructure preview.");
    if (!dto.infrastructure) blockers.push("Customer-owned VPC, public subnets and Terraform state bucket must be included in the immutable resource preview.");
    if (binding.verificationStatus !== "verified") blockers.push("AWS account identity and read authorization have not been verified.");
    if (!customerMutationAuthorized(this.config, binding, project.id)) blockers.push("Scoped customer execution authority has not been verified.");
    if (managed && !dto.assumptions.stateful) blockers.push("A persistent database requires stateful workload assumptions.");
    const ports = new Map(build.ports.map((item) => [item.serviceId, item.servicePort]));
    const targets = new Map(build.targets.map((item) => [item.serviceId, item.target]));
    if (services.some((service) => !ports.get(service.id) || !targets.get(service.id))) throw new BadRequestException("Every service requires a resolved build target and application port.");
    const content: DeploymentPlanContent = {
      ...(dto.profile !== "ecs_fargate" ? { projectId, generationId: randomUUID(), profileInputs } : {}),
      contractVersion: "deployguard.deployment-plan/v1", operationId: randomUUID(),
      ownership: { organizationId: project.organizationId, clientId: project.clientId || null, engagementId: project.engagementId || null, bindingId: binding.id, accountId: binding.accountId, roleArn: binding.roleArn,
        bindingVersion: binding.verificationVersion, region: dto.region, environment: canonicalEnvironmentName(project) },
      repository: { url: project.repositoryUrl, fullName: project.repositoryFullName, branch: project.targetBranch, sourceSha },
      configurationFingerprint: snapshot.fingerprint, assumptions: dto.assumptions, selectedProfile: dto.profile,
      infrastructure: dto.infrastructure ? { ...dto.infrastructure, publicSubnetIds: [...dto.infrastructure.publicSubnetIds].sort() } : null,
      services: services.map((service) => ({ id: service.id, name: service.name, directory: service.serviceDirectory, port: ports.get(service.id)!, buildTarget: targets.get(service.id)! })),
      environmentReferences: variables.map((variable) => ({ id: variable.id, serviceId: variable.serviceId, key: variable.key, scope: variable.scope,
        isSecret: variable.isSecret, fingerprint: variable.configurationFingerprint })),
      dependencies: { database: database ? { provider: database.provider || "none", engine: database.engine,
        attachedServiceId: database.attachedServiceId, persistence: database.persistenceEnabled, backup: database.backupEnabled } : null,
        services: classifyDependencies(requirements.requirements, managed?.engine || null) },
      requirements, comparison, securityFindings: buildRecord ? [{ status: buildRecord.securityScan.status, reason: `Trivy scan of build ${buildRecord.buildId} at ${buildRecord.sourceSha.slice(0, 12)} ${buildRecord.securityScan.status} (${buildRecord.securityScan.source}).` }]
        : [{ status: "unverified", reason: "Trivy image scanning is performed during the existing build workflow; no source-specific image scan is available before this plan." }],
      status: blockers.length ? "blocked" : "review_required", blockers: [...new Set(blockers)],
      risks: ["Pricing and workload assumptions do not guarantee future AWS charges.", "Managed databases require explicit persistence and recovery verification.", "This plan does not authorize the legacy control-plane AWS workflow."],
    };
    if (dto.profile !== "ecs_fargate") {
      if (!content.profileInputs) content.blockers.push("A complete profile-specific VM, static or Lambda configuration must be sealed into this plan.");
      else {
        try {
          const builder = await loadHostingArtifacts();
          builder.buildHostingArtifacts({ profile: dto.profile, plan: content, configuration: content.profileInputs, scope: {
            organizationId: content.ownership.organizationId, projectId, bindingId: binding.id, bindingVersion: binding.verificationVersion, accountId: binding.accountId,
            operationId: content.operationId, generationId: content.generationId, planId: randomUUID(), region: dto.region, environment: content.ownership.environment,
            sourceSha, configurationFingerprint: content.configurationFingerprint, planFingerprint: planFingerprint(content), stateBucket: dto.infrastructure?.terraformStateBucket,
          } });
        } catch (error) { content.blockers.push(error instanceof Error ? error.message : "Profile configuration could not be validated."); }
      }
      if (!dto.buildId) content.blockers.push("Generate automated build evidence for this profile before approval.");
      if (buildRecord && content.profileInputs && !content.blockers.length) {
        try { await this.builds!.seal(buildRecord, content.profileInputs); }
        catch (error) { content.blockers.push(error instanceof Error ? error.message : "Signed build provenance could not be written."); }
      }
      if (content.blockers.length) content.status = "blocked";
    }
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

  async createRetry(user: User, projectId: string, dto: CreateCustomerRetryPlanDto) {
    if (!this.execution || !this.profiles) throw new ServiceUnavailableException("Customer retry planning is unavailable.");
    const project = await this.project(this.database.manager, user, projectId, true);
    const failed = await this.execution.customerRetryTarget(project, dto.failedOperationId);
    const origin = await this.database.getRepository(DeploymentPlan).findOneBy({ id: String(failed.ownership.planId), projectId, organizationId: project.organizationId! });
    if (!origin || origin.fingerprint !== failed.ownership.planFingerprint || planFingerprint(origin.content) !== origin.fingerprint || origin.content.repository.sourceSha !== failed.operation.commitSha || (origin.content.deploymentAction || "deploy") !== "deploy" || origin.content.selectedProfile !== "ecs_fargate") throw new ConflictException("The failed customer operation has no exact immutable deployment plan.");
    const original = origin.content;
    const snapshot = await this.database.transaction("REPEATABLE READ", (manager) => this.snapshot(manager, user, projectId, { bindingId: original.ownership.bindingId, region: original.ownership.region }));
    if (snapshot.fingerprint !== original.configurationFingerprint) throw new ConflictException("The failed deployment configuration or binding changed. Create a new deployment plan.");
    const assumptions = { ...original.assumptions, monthlyBudgetUsd: dto.monthlyBudgetUsd };
    const managed = Boolean(original.dependencies.database?.provider?.toLowerCase() === "managed");
    const costs = await this.pricing.estimate({ region: original.ownership.region, assumptions, serviceCount: original.services.length, managedDatabase: managed,
      runtimeSecretCount: new Set(original.environmentReferences.filter((reference) => reference.isSecret).map((reference) => reference.serviceId)).size,
      database: managed && original.dependencies.database?.engine ? { engine: original.dependencies.database.engine, backup: original.dependencies.database.backup } : null });
    const comparison = compareHosting({ region: original.ownership.region, assumptions, targets: original.services.map((service) => service.buildTarget), managedDatabase: managed, requirements: original.requirements, verifiedBuildKinds: verifiedBuildKinds(original.profileInputs), dependencies: original.dependencies.services || classifyDependencies(original.requirements.requirements, managed ? original.dependencies.database?.engine || null : null), configuration: { references: original.environmentReferences.length, secrets: original.environmentReferences.filter((reference) => reference.isSecret).length } }, costs, this.profiles.catalog(original.ownership.region));
    const blockers = [...comparison.options.find((profile) => profile.id === "ecs_fargate")!.reasons];
    if (!customerMutationAuthorized(this.config, snapshot.binding, projectId)) blockers.push("Scoped customer execution authority has not been verified.");
    const content: DeploymentPlanContent = { ...original, operationId: randomUUID(), retry: { failedOperationId: failed.operation.id, failureFingerprint: failed.failureFingerprint }, assumptions, comparison, blockers, status: blockers.length ? "blocked" : "review_required", risks: [...original.risks, "Retry uses the exact failed source and configuration, with a new operation and a new human approval."] };
    const plan = await this.database.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager, projectId, canonicalEnvironmentName(project));
      const current = await this.snapshot(manager, user, projectId, { bindingId: original.ownership.bindingId, region: original.ownership.region });
      const target = await this.execution!.customerRetryTarget(current.project, dto.failedOperationId);
      if (current.fingerprint !== snapshot.fingerprint || target.failureFingerprint !== failed.failureFingerprint) throw new ConflictException("Customer retry configuration or evidence changed during review preparation.");
      const [{ version }] = await manager.query(`SELECT COALESCE(MAX(version), 0) + 1 AS version FROM deployment_plans WHERE project_id = $1`, [projectId]);
      return manager.getRepository(DeploymentPlan).save({ id: randomUUID(), projectId, organizationId: project.organizationId!, version: Number(version), createdByUserId: user.id, fingerprint: planFingerprint(content), content });
    });
    await this.audit.record({ actorUser: user, action: "CUSTOMER_RETRY_PLAN_CREATED", resourceType: "project", resourceId: projectId, status: "success", metadata: { projectId, planId: plan.id, failedOperationId: failed.operation.id, fingerprint: plan.fingerprint, reason: dto.reason.trim() } });
    return plan;
  }

  async createLifecycle(user: User, projectId: string, dto: CreateCustomerLifecyclePlanDto) {
    if (!this.execution || !this.profiles) throw new ServiceUnavailableException("Customer lifecycle planning is unavailable.");
    if (!dto.reason.trim() || dto.action === "rollback" && !dto.targetOperationId || dto.action === "destroy" && dto.confirmationPhrase !== DESTROY_CONFIRMATION_PHRASE) throw new BadRequestException("Select the exact retained rollback operation or confirm DESTROY for customer cleanup, with a review reason.");
    const project = await this.project(this.database.manager, user, projectId, true);
    const target = await this.execution.customerLifecycleTarget(project, dto.action, dto.targetOperationId);
    const origin = await this.database.getRepository(DeploymentPlan).findOneBy({ id: String(target.ownership.planId), projectId, organizationId: project.organizationId! });
    if (!origin || origin.fingerprint !== target.ownership.planFingerprint || planFingerprint(origin.content) !== origin.fingerprint || origin.content.repository.sourceSha !== target.target.sourceSha || origin.content.selectedProfile !== "ecs_fargate") throw new ConflictException("Retained customer release has no exact immutable deployment plan.");
    const original = origin.content;
    const snapshot = await this.database.transaction("REPEATABLE READ", (manager) => this.snapshot(manager, user, projectId, { bindingId: original.ownership.bindingId, region: original.ownership.region }));
    if (snapshot.binding.accountId !== original.ownership.accountId || snapshot.binding.roleArn !== original.ownership.roleArn) throw new ConflictException("The retained release customer account or role changed.");
    const assumptions = { ...original.assumptions, monthlyBudgetUsd: dto.monthlyBudgetUsd };
    const managed = Boolean(original.dependencies.database?.provider === "MANAGED" || original.dependencies.database?.provider?.toLowerCase() === "managed");
    const costs = await this.pricing.estimate({ region: original.ownership.region, assumptions, serviceCount: original.services.length, managedDatabase: managed,
      runtimeSecretCount: new Set(original.environmentReferences.filter((reference) => reference.isSecret).map((reference) => reference.serviceId)).size,
      database: managed && original.dependencies.database?.engine ? { engine: original.dependencies.database.engine, backup: original.dependencies.database.backup } : null });
    const comparison = compareHosting({ region: original.ownership.region, assumptions, targets: original.services.map((service) => service.buildTarget), managedDatabase: managed, requirements: original.requirements, verifiedBuildKinds: verifiedBuildKinds(original.profileInputs), dependencies: original.dependencies.services || classifyDependencies(original.requirements.requirements, managed ? original.dependencies.database?.engine || null : null), configuration: { references: original.environmentReferences.length, secrets: original.environmentReferences.filter((reference) => reference.isSecret).length } }, costs, this.profiles.catalog(original.ownership.region));
    const blockers = [...comparison.options.find((profile) => profile.id === "ecs_fargate")!.reasons];
    if (!customerMutationAuthorized(this.config, snapshot.binding, projectId)) blockers.push("Scoped customer execution authority has not been verified.");
    const content: DeploymentPlanContent = { ...original, operationId: randomUUID(), deploymentAction: dto.action, lifecycle: target.lifecycle,
      ownership: { ...original.ownership, bindingVersion: snapshot.binding.verificationVersion }, configurationFingerprint: snapshot.fingerprint,
      assumptions, comparison, blockers, status: blockers.length ? "blocked" : "review_required",
      risks: [...original.risks, dto.action === "destroy" ? "Cleanup deletes every verified customer generation and its managed database storage and runtime secrets; data recovery is not guaranteed." : "Rollback restores the sealed images and runtime configuration of the selected retained release."] };
    const plan = await this.database.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager, projectId, canonicalEnvironmentName(project));
      const current = await this.snapshot(manager, user, projectId, { bindingId: original.ownership.bindingId, region: original.ownership.region });
      const freshTarget = await this.execution!.customerLifecycleTarget(current.project, dto.action, dto.targetOperationId);
      if (current.fingerprint !== snapshot.fingerprint || planFingerprint(freshTarget.lifecycle) !== planFingerprint(target.lifecycle)) throw new ConflictException("Customer lifecycle configuration or retained target changed during review preparation.");
      const [{ version }] = await manager.query(`SELECT COALESCE(MAX(version), 0) + 1 AS version FROM deployment_plans WHERE project_id = $1`, [projectId]);
      return manager.getRepository(DeploymentPlan).save({ id: randomUUID(), projectId, organizationId: project.organizationId!, version: Number(version), createdByUserId: user.id, fingerprint: planFingerprint(content), content });
    });
    await this.audit.record({ actorUser: user, action: "CUSTOMER_LIFECYCLE_PLAN_CREATED", resourceType: "project", resourceId: projectId, status: "success", metadata: { projectId, organizationId: project.organizationId, planId: plan.id, action: dto.action, targetOperationId: target.lifecycle.targetOperationId, targetFingerprint: target.lifecycle.targetFingerprint, fingerprint: plan.fingerprint, reason: dto.reason.trim() } });
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
        if (!(this.profiles?.available(plan.content.selectedProfile, plan.content.ownership.region) || false)) throw new ConflictException("The selected hosting profile is unavailable.");
        const approvedProfile = plan.content.comparison.options.find((option) => option.id === plan.content.selectedProfile);
        const currentProfile = this.profiles?.catalog(plan.content.ownership.region).find((option) => option.id === plan.content.selectedProfile);
        if (!approvedProfile?.verification?.fingerprint || approvedProfile.verification.fingerprint !== currentProfile?.verification.fingerprint) throw new ConflictException("Final provider evidence changed. Create a new plan.");
        if (plan.content.retry) {
          const failed = await this.execution!.customerRetryTarget(project, plan.content.retry.failedOperationId);
          if (failed.failureFingerprint !== plan.content.retry.failureFingerprint || failed.operation.commitSha !== plan.content.repository.sourceSha) throw new ConflictException("The customer retry target changed. Create a new plan.");
        } else if (plan.content.lifecycle) {
          const target = await this.execution!.customerLifecycleTarget(project, plan.content.lifecycle.action, plan.content.lifecycle.targetOperationId);
          if (planFingerprint(target.lifecycle) !== planFingerprint(plan.content.lifecycle)) throw new ConflictException("The retained customer lifecycle target changed. Create a new plan.");
        } else {
          const sourceSha = await this.source.resolveSourceSha({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch,
            accessToken: (await this.github.tokenForRepository(project.ownerUserId, project.repositoryFullName, project.githubInstallationId)).token });
          if (sourceSha.toLowerCase() !== plan.content.repository.sourceSha.toLowerCase()) throw new ConflictException("Repository source changed. Create a new plan.");
        }
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
    const memberships = project.organizationId ? await manager.query(`SELECT m.organization_id AS "organizationId", m.role, o.archived_at AS "archivedAt" FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.organization_id = $1 AND m.user_id = $2`, [project.organizationId, user.id]) : [];
    if (!canAccessProject({ ...user, organizationMemberships: memberships }, project, write)) throw new ForbiddenException("Authorized project workspace access required.");
    return project;
  }
  private async approvalRole(manager: EntityManager, user: User, project: Project) {
    const memberships = project.organizationId ? await manager.query(`SELECT m.organization_id AS "organizationId", m.role, o.archived_at AS "archivedAt" FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.organization_id = $1 AND m.user_id = $2`, [project.organizationId, user.id]) : [];
    return canApproveProject({ ...user, organizationMemberships: memberships }, project) ? memberships[0]?.role || "owner" : null;
  }
  private async snapshot(manager: EntityManager, user: User, projectId: string, dto: Pick<CreateDeploymentPlanDto, "bindingId" | "region">, manage = true) {
    const project = await this.project(manager, user, projectId, manage);
    if (!project.organizationId) throw new ConflictException("Project ownership migration is required before customer planning.");
    const organization = await manager.query(`SELECT archived_at FROM organizations WHERE id = $1`, [project.organizationId]);
    if (!organization.length || organization[0].archived_at) throw new ConflictException("The project workspace is archived or unavailable.");
    if (project.clientId || project.engagementId) await validateAgencyProjectScope(manager, project.organizationId, { ...project, awsAccountBindingId: dto.bindingId });
    if (project.awsAccountBindingId && project.awsAccountBindingId !== dto.bindingId) throw new BadRequestException("Plan AWS binding must match the project's authorized account binding.");
    const binding = await manager.getRepository(AwsAccountBinding).findOneBy({ id: dto.bindingId, organizationId: project.organizationId });
    if (!binding || binding.verificationStatus === "revoked") throw new NotFoundException("Active AWS account binding not found for this workspace.");
    if (!binding.regions.includes(dto.region)) throw new BadRequestException("Requested region is not authorized by this AWS binding.");
    const services = await manager.getRepository(ProjectDeployableService).find({ where: { projectId }, order: { position: "ASC" } });
    const variables = await manager.getRepository(ProjectEnvironmentVariable).createQueryBuilder("variable").addSelect("variable.value")
      .where("variable.projectId = :projectId AND variable.environment = :environment AND variable.isActive = true", { projectId, environment: canonicalEnvironmentName(project) }).orderBy("variable.id", "ASC").getMany();
    const database = await manager.getRepository(ProjectDatabaseTier).findOneBy({ projectId });
    const fingerprint = deploymentConfigurationFingerprint(project, services, variables, database, binding);
    return { project, services, variables, database, binding, fingerprint };
  }
}
