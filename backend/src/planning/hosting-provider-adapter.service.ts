import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { access as exists, readFile } from "node:fs/promises";
import { CreateRepositoryCommand, ECRClient, GetAuthorizationTokenCommand, ListTagsForResourceCommand, DescribeRepositoriesCommand } from "@aws-sdk/client-ecr";
import { pushOciArchive } from "./oci-push";
import { resolve } from "node:path";
import { DataSource, EntityManager } from "typeorm";
import { User, UserRole } from "../users/user.entity";
import { UsersService } from "../users/users.service";
import { Project, ProjectStatus } from "../projects/project.entity";
import { ProjectDeployableService } from "../projects/project-deployable-service.entity";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { ProjectDatabaseTier } from "../projects/project-database-tier.entity";
import { AwsAccountBinding } from "../workspaces/aws-account-binding.entity";
import { canAccessProject, canApproveProject } from "../workspaces/project-access";
import { customerMutationAuthorized } from "../workspaces/customer-authority-proof";
import { AuditLogService } from "../audit-log/audit-log.service";
import { EntitlementService } from "../billing/entitlement.service";
import { GithubAppService } from "../projects/github-app.service";
import { RepositorySourceService } from "../projects/repository-source.service";
import { DeploymentPlan, DeploymentPlanDecision } from "./deployment-plan.entity";
import { planFingerprint } from "./deployment-plan";
import { deploymentConfigurationFingerprint } from "./deployment-configuration";
import { HostingProfileRegistryService, IMPLEMENTED_PROVIDER_CONTRACTS } from "./hosting-profile-registry.service";
import { HostingProviderSessionService, HostingProviderSession } from "./hosting-provider-session.service";
import { hostingExecutableFingerprint, loadHostingArtifacts, loadHostingEvidence, loadHostingRuntime } from "./hosting-profile-inputs";

export function verifyHostingBuildProof(envelope: any, expected: { organizationId: string; projectId: string; sourceSha: string; profile: string; profileInputsFingerprint: string }, signingKey: string) {
  const proof = envelope?.proof;
  if (signingKey.length < 32 || !proof || proof.contractVersion !== "deployguard.profile-build/v1" || !Object.entries(expected).every(([key, value]) => proof[key] === value) || proof.securityScan !== "passed" || typeof envelope.signature !== "string" || !/^[a-f0-9]{64}$/.test(envelope.signature)) return false;
  const verified = Date.parse(proof.verifiedAt), expires = Date.parse(proof.expiresAt);
  if (!Number.isFinite(verified) || !Number.isFinite(expires) || verified > Date.now() || expires <= Date.now() || expires - verified > 24 * 3600000) return false;
  return timingSafeEqual(createHmac("sha256", signingKey).update(planFingerprint(proof)).digest(), Buffer.from(envelope.signature, "hex"));
}

@Injectable()
export class HostingProviderAdapterService implements OnModuleInit {
  constructor(private readonly data: DataSource, private readonly users: UsersService, private readonly config: ConfigService,
    private readonly profiles: HostingProfileRegistryService, private readonly sessions: HostingProviderSessionService,
    private readonly audit: AuditLogService, private readonly source: RepositorySourceService, private readonly github: GithubAppService,
    private readonly entitlements: EntitlementService) {}
  async onModuleInit() {
    const fingerprint = planFingerprint(await hostingExecutableFingerprint());
    for (const profile of ["ec2", "lightsail", "static", "lambda"] as const) IMPLEMENTED_PROVIDER_CONTRACTS[profile] = { version: "deployguard.hosting-provider/v1", fingerprint };
  }
  private async access(user: User, projectId: string, write = false, approve = false, manager: EntityManager = this.data.manager) {
    const actor = await this.users.findById(user.id);
    const project = await manager.getRepository(Project).findOneBy({ id: projectId });
    if (!actor || actor.disabledAt || actor.role === UserRole.ADMIN || !project || !project.organizationId || project.status === ProjectStatus.ARCHIVED || project.deletionIntentId) throw new NotFoundException("Active customer project not found.");
    if (!canAccessProject(actor, project, write) || (approve && !canApproveProject(actor, project))) throw new ForbiddenException("The assigned workspace project scope does not permit this action.");
    return { actor, project };
  }
  private async plan(user: User, projectId: string, id: string, write = false) {
    const access = await this.access(user, projectId, write);
    const plan = await this.data.getRepository(DeploymentPlan).findOneBy({ id, projectId, organizationId: access.project.organizationId });
    if (!plan || planFingerprint(plan.content) !== plan.fingerprint || plan.content.selectedProfile === "ecs_fargate") throw new NotFoundException("Immutable provider deployment plan not found.");
    return { ...access, plan };
  }
  private async artifacts(plan: DeploymentPlan) {
    const c = plan.content;
    if (!c.projectId || c.projectId !== plan.projectId || !c.generationId || !c.profileInputs || !c.infrastructure?.terraformStateBucket) throw new ConflictException("A new plan with sealed project, generation, backend and provider inputs is required.");
    const builder = await loadHostingArtifacts();
    try { return builder.buildHostingArtifacts({ profile: c.selectedProfile, plan: c, configuration: c.profileInputs, scope: {
      organizationId: plan.organizationId, projectId: plan.projectId, bindingId: c.ownership.bindingId, bindingVersion: c.ownership.bindingVersion, accountId: c.ownership.accountId,
      operationId: c.operationId, generationId: c.generationId, planId: plan.id, region: c.ownership.region, environment: c.ownership.environment,
      sourceSha: c.repository.sourceSha, configurationFingerprint: c.configurationFingerprint, planFingerprint: plan.fingerprint, stateBucket: c.infrastructure.terraformStateBucket,
    } }); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Provider artifacts could not be validated."); }
  }
  async preview(user: User, projectId: string, planId: string) { const { plan } = await this.plan(user, projectId, planId); return { artifacts: await this.artifacts(plan), deploymentAuthorized: false }; }
  async list(user: User, projectId: string) {
    const { project } = await this.access(user, projectId);
    const generations = await this.data.query(`SELECT id,profile,environment,plan_id AS "planId",plan_fingerprint AS "planFingerprint",artifact_fingerprint AS "artifactFingerprint",runtime_identity AS "runtimeIdentity",status,retained_until AS "retainedUntil",created_at AS "createdAt" FROM hosting_profile_generations WHERE project_id=$1 AND organization_id=$2 ORDER BY created_at DESC LIMIT 50`, [projectId, project.organizationId]);
    const [route] = await this.data.query(`SELECT live_generation_id AS "generationId",version FROM hosting_profile_routes WHERE project_id=$1 AND environment=$2`, [projectId, project.environmentName]);
    return { generations, route: route || null, authority: "recorded_provider_generation_evidence", currentHealth: "not_observed" };
  }
  // The verified live provider endpoint for read-only API assurance; null when no provider generation is live.
  async liveTarget(user: User, projectId: string, serviceId: string) {
    const { project } = await this.access(user, projectId);
    const [live] = await this.data.query(`SELECT generation.id,generation.created_at AS "createdAt",generation.runtime_identity AS identity,generation.artifacts->'manifest' AS manifest,plan.content AS plan FROM hosting_profile_routes route
      JOIN hosting_profile_generations generation ON generation.id=route.live_generation_id AND generation.organization_id=$3 AND generation.status='verified'
      JOIN deployment_plans plan ON plan.id=generation.plan_id AND plan.organization_id=$3 WHERE route.project_id=$1 AND route.environment=$2`, [projectId, project.environmentName, project.organizationId]);
    if (!live?.identity?.endpoint || !live.manifest) return null;
    if (!live.plan.services?.some((service: any) => service.id === serviceId)) throw new NotFoundException("The live provider generation does not serve this service.");
    const origin = new URL(live.identity.endpoint);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.port || origin.search || origin.hash) throw new ConflictException("The live provider generation has no credential-free HTTPS endpoint.");
    return { projectId, organizationId: project.organizationId, environment: project.environmentName, serviceId, origin: origin.origin, releaseId: live.id, sourceSha: live.manifest.scope.sourceSha,
      generationId: live.id, resourceFingerprint: planFingerprint(live.identity), healthPath: live.manifest.compatibility?.healthPath || "/health", promotedAt: new Date(live.createdAt).toISOString(), operationId: live.manifest.scope.operationId };
  }
  // Observed runtime evidence for the live generation; never mixed with plan estimates or AI output.
  async observe(user: User, projectId: string) {
    const { project } = await this.access(user, projectId);
    const [live] = await this.data.query(`SELECT generation.id,generation.profile,generation.artifacts,generation.runtime_identity AS identity,generation.updated_at AS "promotedAt",(SELECT plan.content->'assumptions' FROM deployment_plans plan WHERE plan.id=generation.plan_id AND plan.organization_id=$3) AS assumptions FROM hosting_profile_routes route JOIN hosting_profile_generations generation ON generation.id=route.live_generation_id AND generation.project_id=route.project_id AND generation.organization_id=$3
      WHERE route.project_id=$1 AND route.environment=$2 AND generation.status='verified'`, [projectId, project.environmentName, project.organizationId]);
    if (!live?.identity || !live.artifacts?.manifest) return { authority: "observed_provider_runtime", status: "no_live_generation", generationId: null, endpoint: null, metrics: [], metricsStatus: "not_applicable" };
    const manifest = live.artifacts.manifest, identity = live.identity, evidence = await loadHostingEvidence();
    if (manifest.scope.projectId !== projectId || manifest.scope.organizationId !== project.organizationId || identity.generationId !== live.id) throw new ConflictException("Live provider generation scope does not match this project.");
    const endpoint = await evidence.observeProviderEndpoint(manifest, identity);
    const end = new Date(), start = new Date(end.getTime() - 24 * 3600_000);
    let metrics: Array<{ metric: string; timestamp: string; value: number }> = [], metricsStatus = "observed", metricsReason: string | null = null;
    try {
      metrics = await this.sessions.withSession({ ...manifest.scope, profile: manifest.profile }, (session) => evidence.readProviderMetrics(manifest, identity, session, { start, end }), { readOnly: true });
    } catch (error) { metricsStatus = "unavailable"; metricsReason = error instanceof HttpException ? error.message : "Customer-account metrics could not be read with a read-only session."; }
    return { authority: "observed_provider_runtime", status: "live", generationId: live.id, profile: live.profile, accountId: manifest.scope.accountId, region: manifest.scope.region, sourceSha: manifest.scope.sourceSha, operationId: manifest.scope.operationId, promotedAt: new Date(live.promotedAt).toISOString(), assumptions: live.assumptions,
      endpoint, window: { start: start.toISOString(), end: end.toISOString() }, metrics, metricsStatus, metricsReason };
  }
  private buildDirectory(plan: DeploymentPlan) {
    const root = this.config.get<string>("HOSTING_BUILD_ARTIFACT_ROOT", "");
    if (!root || !root.startsWith('/')) throw new ServiceUnavailableException("Authenticated source-pinned provider build artifacts are unavailable.");
    return resolve(root, plan.organizationId, plan.projectId, plan.content.repository.sourceSha, planFingerprint(plan.content.profileInputs));
  }
  async buildAdmission(plan: DeploymentPlan) {
    try {
      const envelope = JSON.parse(await readFile(resolve(this.buildDirectory(plan), "provenance.json"), "utf8"));
      return verifyHostingBuildProof(envelope, { organizationId: plan.organizationId, projectId: plan.projectId, sourceSha: plan.content.repository.sourceSha,
        profile: plan.content.selectedProfile, profileInputsFingerprint: planFingerprint(plan.content.profileInputs) }, this.config.get<string>("HOSTING_BUILD_PROOF_SIGNING_KEY", ""));
    } catch { return false; }
  }
  private async current(user: User, plan: DeploymentPlan, artifactFingerprint: string, action: string, jobId?: string) {
    const { actor, project } = await this.access(user, plan.projectId, true, ["rollback", "cleanup"].includes(action));
    const currentPlan = await this.data.getRepository(DeploymentPlan).findOneBy({ id: plan.id, projectId: plan.projectId, organizationId: plan.organizationId });
    const approval = await this.data.getRepository(DeploymentPlanDecision).findOneBy({ planId: plan.id });
    const approver = approval ? await this.users.findById(approval.actorUserId) : null;
    if (!currentPlan || currentPlan.fingerprint !== plan.fingerprint || planFingerprint(currentPlan.content) !== plan.fingerprint || currentPlan.content.status !== "review_required" || currentPlan.content.blockers.length || !approval || approval.decision !== "approved" || approval.fingerprint !== plan.fingerprint || !approver || approver.disabledAt || !canApproveProject(approver, project)) throw new ConflictException("The exact provider plan needs a current immutable workspace approval.");
    const c = currentPlan.content;
    const binding = await this.data.getRepository(AwsAccountBinding).findOneBy({ id: c.ownership.bindingId, organizationId: plan.organizationId });
    if (!binding || binding.verificationStatus !== "verified" || binding.verificationVersion !== c.ownership.bindingVersion || binding.accountId !== c.ownership.accountId || !binding.regions.includes(c.ownership.region) || !customerMutationAuthorized(this.config, binding, project.id)) throw new ConflictException("Customer AWS binding or mutation authorization changed.");
    if (!this.profiles.available(c.selectedProfile, c.ownership.region)) throw new ServiceUnavailableException("Final authorized provider evidence is unavailable for the executable adapter and region.");
    const option = c.comparison.options.find((item) => item.id === c.selectedProfile);
    if (!option || option.cost.status !== "complete" || option.cost.monthlyUsd === null || option.cost.monthlyUsd > c.assumptions.monthlyBudgetUsd || !option.cost.estimatedAt || Date.now() - Date.parse(option.cost.estimatedAt) > 24 * 3600000 || Date.parse(option.cost.estimatedAt) > Date.now()) throw new ConflictException("Complete current provider resource pricing within the approved budget is required.");
    if (jobId) {
      const [job] = await this.data.query(`SELECT id FROM hosting_profile_jobs WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND actor_user_id=$4 AND status='running'`, [jobId, project.id, project.organizationId, actor.id]);
      if (!job) throw new ConflictException("The durable provider job is no longer active.");
    }
    if (!["rollback", "cleanup"].includes(action)) {
      const services = await this.data.getRepository(ProjectDeployableService).find({ where: { projectId: project.id }, order: { position: "ASC" } });
      const variables = await this.data.getRepository(ProjectEnvironmentVariable).createQueryBuilder("variable").addSelect("variable.value").where("variable.projectId=:projectId AND variable.environment=:environment AND variable.isActive=true", { projectId: project.id, environment: project.environmentName }).orderBy("variable.id", "ASC").getMany();
      const database = await this.data.getRepository(ProjectDatabaseTier).findOneBy({ projectId: project.id });
      if (deploymentConfigurationFingerprint(project, services, variables, database, binding) !== c.configurationFingerprint) throw new ConflictException("Provider configuration changed; create and approve a new plan.");
      const credential = await this.github.tokenForRepository(project.ownerUserId, project.repositoryFullName, project.githubInstallationId);
      const sourceSha = await this.source.resolveSourceSha({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch, accessToken: credential.token });
      if (sourceSha !== c.repository.sourceSha || !await this.buildAdmission(currentPlan)) throw new ConflictException("Matching authenticated source, artifact and security-scan provenance is required.");
    }
    if ((await this.artifacts(currentPlan)).manifest.artifactFingerprint !== artifactFingerprint) throw new ConflictException("The executable provider artifacts changed; create a new approved plan.");
    return { planFingerprint: plan.fingerprint, artifactFingerprint, bindingVersion: binding.verificationVersion, approval: "approved", profileAvailable: true, pricingStatus: "complete" };
  }
  private async event(actor: User, generationId: string, scope: any, input: any) {
    await this.data.transaction(async (manager) => {
      await manager.query(`INSERT INTO hosting_profile_events(id,generation_id,project_id,organization_id,actor_user_id,action,evidence) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [randomUUID(), generationId, scope.projectId, scope.organizationId, actor.id, input.action, JSON.stringify(input)]);
      await this.audit.record({ actorUser: actor, action: input.action, resourceType: "project", resourceId: scope.projectId, status: "success", metadata: { projectId: scope.projectId, organizationId: scope.organizationId, generationId, artifactFingerprint: input.artifactFingerprint } }, manager);
    });
  }
  private async claim(user: User, plan: DeploymentPlan, artifacts: any, action: "deploy" | "rollback" | "cleanup", reason?: string) {
    const jobId = action === "deploy" ? plan.content.operationId : randomUUID();
    await this.data.transaction(async (manager) => {
      const { actor, project } = await this.access(user, plan.projectId, true, action !== "deploy", manager);
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`hosting-profile:${project.id}:${plan.content.ownership.environment}`]);
      const [existingEcsRoute] = await manager.query(`SELECT live_generation_id FROM project_environment_routes WHERE project_id=$1 AND environment_name=$2 AND live_generation_id IS NOT NULL`, [project.id, plan.content.ownership.environment]);
      if (existingEcsRoute) throw new ConflictException("Cross-profile migration from an existing ECS route needs an independently approved migration and rollback contract.");
      // Provider deployments consume the same plan entitlements as the ECS path.
      if (action === "deploy") await this.entitlements.assertCanDeployProject(actor.id, project.id, manager, project.organizationId);
      const [running] = await manager.query(`SELECT id FROM hosting_profile_jobs WHERE project_id=$1 AND environment=$2 AND status='running'`, [project.id, plan.content.ownership.environment]);
      if (running) throw new ConflictException("A provider job is active; reconcile it before admitting another mutation.");
      const [route] = await manager.query(`SELECT live_generation_id FROM hosting_profile_routes WHERE project_id=$1 AND environment=$2 FOR UPDATE`, [project.id, plan.content.ownership.environment]);
      if (action === "deploy") await manager.query(`INSERT INTO hosting_profile_generations(id,project_id,organization_id,environment,profile,plan_id,plan_fingerprint,artifact_fingerprint,artifacts,previous_generation_id,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`, [artifacts.manifest.scope.generationId, project.id, project.organizationId, plan.content.ownership.environment, plan.content.selectedProfile, plan.id, plan.fingerprint, artifacts.manifest.artifactFingerprint, JSON.stringify(artifacts), route?.live_generation_id || null, actor.id]);
      await manager.query(`INSERT INTO hosting_profile_jobs(id,project_id,organization_id,environment,generation_id,actor_user_id,action,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [jobId, project.id, project.organizationId, plan.content.ownership.environment, artifacts.manifest.scope.generationId, actor.id, action, reason || null]);
      await this.audit.record({ actorUser: actor, action: "HOSTING_PROVIDER_JOB_ADMITTED", resourceType: "project", resourceId: project.id, status: "success", metadata: { projectId: project.id, organizationId: project.organizationId, planId: plan.id, generationId: artifacts.manifest.scope.generationId, artifactFingerprint: artifacts.manifest.artifactFingerprint, jobId, action, reason: reason || null } }, manager);
    });
    return jobId;
  }
  private async authority(user: User, plan: DeploymentPlan, artifacts: any, jobId: string) {
    const scope = artifacts.manifest.scope, evidence = await loadHostingEvidence(); let session: HostingProviderSession | null = null;
    const verifyDeletion = async ({ identity }: any) => {
      await this.current(user, plan, artifacts.manifest.artifactFingerprint, "cleanup", jobId);
      const [generation] = await this.data.query(`SELECT status,retained_until FROM hosting_profile_generations WHERE id=$1 AND project_id=$2 AND organization_id=$3`, [scope.generationId, scope.projectId, scope.organizationId]);
      const [active] = await this.data.query(`SELECT live_generation_id FROM hosting_profile_routes WHERE project_id=$1 AND environment=$2`, [scope.projectId, scope.environment]);
      return { status: generation && generation.status !== "deleted" ? "approved" : "denied", generationActive: active?.live_generation_id === scope.generationId, rollbackRetained: generation?.retained_until && Date.parse(generation.retained_until) > Date.now() ? true : false, resourceFingerprint: planFingerprint(identity) };
    };
    return {
      assertCurrent: ({ action }: any) => this.current(user, plan, artifacts.manifest.artifactFingerprint, action, jobId),
      withCustomerSession: async (_request: any, callback: any) => {
        await this.current(user, plan, artifacts.manifest.artifactFingerprint, _request.purpose === "rollback_read" ? "rollback" : _request.purpose, jobId);
        return this.sessions.withSession({ ...scope, profile: artifacts.manifest.profile,
          ...(["ec2", "lightsail"].includes(artifacts.manifest.profile) ? { dnsZoneId: artifacts.manifest.dnsZoneId, dnsRecordName: new URL(artifacts.manifest.runtimeIdentity.endpoint).hostname } : {}) }, async (temporary) => { session = temporary; try { return await callback(temporary); } finally { session = null; } });
      },
      recordEvidence: (input: any) => this.event(user, scope.generationId, scope, { ...input, jobId }),
      verifyRuntimeOwnership: async ({ identity }: any) => { if (!session) throw new ConflictException("Fresh customer provider session required."); return evidence.readProviderOwnership(artifacts.manifest, identity, session); },
      probeHealth: ({ identity }: any) => evidence.probeProviderHealth(artifacts.manifest, identity),
      promoteCompareAndSwap: async ({ identity, proof, rollback }: any) => this.data.transaction(async (manager) => {
        await this.access(user, scope.projectId, true, Boolean(rollback), manager);
        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`hosting-profile:${scope.projectId}:${scope.environment}`]);
        const [generation] = await manager.query(`SELECT previous_generation_id,status FROM hosting_profile_generations WHERE id=$1 AND project_id=$2 AND organization_id=$3 FOR UPDATE`, [scope.generationId, scope.projectId, scope.organizationId]);
        const [route] = await manager.query(`SELECT live_generation_id,version FROM hosting_profile_routes WHERE project_id=$1 AND environment=$2 FOR UPDATE`, [scope.projectId, scope.environment]);
        if (!generation || (!rollback && (route?.live_generation_id || null) !== generation.previous_generation_id)) throw new ConflictException("The canonical provider route changed during deployment.");
        if (route?.live_generation_id && route.live_generation_id !== scope.generationId) await manager.query(`UPDATE hosting_profile_generations SET retained_until=NOW()+interval '7 days',updated_at=NOW() WHERE id=$1`, [route.live_generation_id]);
        await manager.query(`UPDATE hosting_profile_generations SET runtime_identity=$2::jsonb,status='verified',retained_until=NULL,updated_at=NOW() WHERE id=$1`, [scope.generationId, JSON.stringify(identity)]);
        await manager.query(`INSERT INTO hosting_profile_routes(project_id,environment,live_generation_id) VALUES($1,$2,$3) ON CONFLICT(project_id,environment) DO UPDATE SET live_generation_id=EXCLUDED.live_generation_id,version=hosting_profile_routes.version+1,updated_at=NOW()`, [scope.projectId, scope.environment, scope.generationId]);
        await this.audit.record({ actorUser: user, action: rollback ? "HOSTING_ROLLBACK_ROUTE_PROMOTED" : "HOSTING_PROVIDER_ROUTE_PROMOTED", resourceType: "project", resourceId: scope.projectId, status: "success", metadata: { projectId: scope.projectId, organizationId: scope.organizationId, generationId: scope.generationId, jobId, resourceFingerprint: planFingerprint(identity), healthObservedAt: proof.health.observedAt } }, manager);
        return { status: "promoted", generationId: scope.generationId };
      }),
      getRetainedGeneration: async ({ generationId }: any) => {
        const [generation] = await this.data.query(`SELECT artifacts,runtime_identity AS identity,status,retained_until AS "retainedUntil" FROM hosting_profile_generations WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND environment=$4`, [generationId, scope.projectId, scope.organizationId, scope.environment]);
        if (!generation) throw new NotFoundException("Retained provider generation not found."); return generation;
      },
      assertCleanup: verifyDeletion,
    };
  }
  private async finishJob(id: string, ok: boolean, generationId: string, action: string) {
    await this.data.transaction(async (manager) => {
      await manager.query(`UPDATE hosting_profile_jobs SET status=$2,updated_at=NOW() WHERE id=$1 AND status='running'`, [id, ok ? "succeeded" : "failed"]);
      if (!ok && action === "deploy") await manager.query(`UPDATE hosting_profile_generations SET status='failed',updated_at=NOW() WHERE id=$1 AND status='running'`, [generationId]);
      if (ok && action === "cleanup") await manager.query(`UPDATE hosting_profile_generations SET status='deleted',updated_at=NOW() WHERE id=$1`, [generationId]);
      if (ok && action === "deploy") {
        const [owner] = await manager.query(`SELECT project.id,project.owner_user_id AS "ownerUserId",project.organization_id AS "organizationId" FROM hosting_profile_generations generation JOIN projects project ON project.id=generation.project_id WHERE generation.id=$1`, [generationId]);
        if (owner) await this.entitlements.recordSuccessfulLiveDeployment(owner.ownerUserId, owner.id, new Date(), manager, owner.organizationId);
      }
    });
  }
  async execute(user: User, projectId: string, planId: string, fingerprint: string) {
    const { plan } = await this.plan(user, projectId, planId, true);
    if (plan.fingerprint !== fingerprint) throw new ConflictException("The requested immutable provider plan fingerprint changed.");
    const artifacts = await this.artifacts(plan); await this.current(user, plan, artifacts.manifest.artifactFingerprint, "deploy");
    const jobId = await this.claim(user, plan, artifacts, "deploy");
    try {
      await this.publishImages(user, plan, artifacts, jobId);
      const runtime = await loadHostingRuntime(), authority = await this.authority(user, plan, artifacts, jobId);
      const result = await runtime.executeGeneration(artifacts, authority, { loadAsset: async ({ path }: any) => readFile(resolve(this.buildDirectory(plan), "assets", path)) });
      await this.finishJob(jobId, true, artifacts.manifest.scope.generationId, "deploy"); return { ...result, jobId };
    } catch (error) { await this.finishJob(jobId, false, artifacts.manifest.scope.generationId, "deploy"); throw error; }
  }
  // Pushes scanned OCI archives to the customer's ECR before Terraform references their exact digests.
  private async publishImages(user: User, plan: DeploymentPlan, artifacts: any, jobId: string) {
    if (plan.content.selectedProfile !== "ec2") return;
    const scope = artifacts.manifest.scope, registry = `${scope.accountId}.dkr.ecr.${scope.region}.amazonaws.com`;
    const prefix = `dg-${scope.projectId.replaceAll("-", "").slice(0, 12)}-`;
    const pending: Array<{ repository: string; digest: string; archive: string }> = [];
    for (const service of ((plan.content.profileInputs as any)?.services || []) as Array<{ id: string; image: string }>) {
      const match = /^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9._/-]+)@(sha256:[a-f0-9]{64})$/.exec(service.image || "");
      if (!match || match[1] !== scope.accountId || match[2] !== scope.region || !match[3].startsWith(prefix)) continue;
      const archive = resolve(this.buildDirectory(plan), "assets", "images", `${service.id}.tar`);
      try { await exists(archive); } catch { continue; } // Pipeline-built images already live in the registry.
      pending.push({ repository: match[3], digest: match[4], archive });
    }
    if (!pending.length) return;
    await this.current(user, plan, artifacts.manifest.artifactFingerprint, "deploy", jobId);
    const owned = { ManagedBy: "DeployGuard", OrganizationId: scope.organizationId, ProjectId: scope.projectId };
    await this.sessions.withSession({ ...scope, profile: "ec2", dnsZoneId: artifacts.manifest.dnsZoneId, dnsRecordName: new URL(artifacts.manifest.runtimeIdentity.endpoint).hostname }, async (session) => {
      const ecr = new ECRClient({ region: scope.region, credentials: session.credentials, maxAttempts: 2 });
      try {
        for (const image of pending) {
          try { await ecr.send(new CreateRepositoryCommand({ repositoryName: image.repository, imageTagMutability: "IMMUTABLE", imageScanningConfiguration: { scanOnPush: true }, encryptionConfiguration: { encryptionType: "AES256" }, tags: Object.entries(owned).map(([Key, Value]) => ({ Key, Value })) })); }
          catch (error: any) { if (error?.name !== "RepositoryAlreadyExistsException") throw error; }
          const [repository] = (await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [image.repository] }))).repositories || [];
          const tags = (await ecr.send(new ListTagsForResourceCommand({ resourceArn: repository?.repositoryArn }))).tags || [];
          if (!repository || !Object.entries(owned).every(([key, value]) => tags.some((tag) => tag.Key === key && tag.Value === value))) throw new ConflictException("The image repository is not owned by this DeployGuard project.");
          const token = (await ecr.send(new GetAuthorizationTokenCommand({}))).authorizationData?.[0]?.authorizationToken;
          if (!token) throw new ServiceUnavailableException("Customer registry authorization is unavailable.");
          const pushed = await pushOciArchive(image.archive, { registry, repository: image.repository, authorization: `Basic ${token}` });
          if (pushed.digest !== image.digest) throw new ConflictException("The published image digest differs from the approved plan.");
          await this.event(user, scope.generationId, scope, { action: "HOSTING_IMAGE_PUBLISHED", jobId, repository: image.repository, digest: image.digest, artifactFingerprint: artifacts.manifest.artifactFingerprint });
        }
      } finally { ecr.destroy(); }
    });
  }
  async retainedAction(user: User, projectId: string, generationId: string, action: "rollback" | "cleanup", artifactFingerprint: string, reason: string) {
    if (!reason.trim()) throw new BadRequestException("A purpose and reason for this retained generation action is required.");
    const { project } = await this.access(user, projectId, true, true);
    const [generation] = await this.data.query(`SELECT * FROM hosting_profile_generations WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND environment=$4`, [generationId, projectId, project.organizationId, project.environmentName]);
    if (!generation || generation.artifact_fingerprint !== artifactFingerprint || !generation.runtime_identity) throw new NotFoundException("Exact retained provider generation evidence not found.");
    const { plan } = await this.plan(user, projectId, generation.plan_id, true); const artifacts = generation.artifacts;
    await this.current(user, plan, artifactFingerprint, action);
    const jobId = await this.claim(user, plan, artifacts, action, reason.trim());
    try {
      const runtime = await loadHostingRuntime(), authority = await this.authority(user, plan, artifacts, jobId);
      const result = action === "rollback" ? await runtime.rollbackGeneration(artifacts.manifest.scope, generationId, authority)
        : await runtime.cleanupGeneration(artifacts, generation.runtime_identity, authority, { loadAsset: async ({ path }: any) => readFile(resolve(this.buildDirectory(plan), "assets", path)) });
      await this.finishJob(jobId, true, generationId, action); return { ...result, jobId };
    } catch (error) { await this.finishJob(jobId, false, generationId, action); throw error; }
  }
}
