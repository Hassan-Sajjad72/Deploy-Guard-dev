import { randomUUID } from "crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, In, Repository } from "typeorm";
import { DeploymentGenerationStatus, ProjectDeploymentGeneration } from "./project-deployment-generation.entity";
import { ProjectEnvironmentRoute } from "./project-environment-route.entity";
import { generationCleanupTarget } from "./generation-cleanup-policy";

const LIVE_STATUSES = [DeploymentGenerationStatus.LIVE];
const RETRYABLE_STATUSES = [DeploymentGenerationStatus.DEPLOYING, DeploymentGenerationStatus.FAILED];
const CLEANUP_STATUSES = [DeploymentGenerationStatus.RETIRED, DeploymentGenerationStatus.CLEANUP_PENDING];
const CANDIDATE_PRIORITY_MIN = 20_000;
const CANDIDATE_PRIORITY_MAX = 50_000;

@Injectable()
export class DeploymentGenerationService {
  constructor(
    @InjectRepository(ProjectDeploymentGeneration) private readonly generations: Repository<ProjectDeploymentGeneration>,
    @InjectRepository(ProjectEnvironmentRoute) private readonly routes: Repository<ProjectEnvironmentRoute>,
  ) {}

  live(projectId: string, environmentName: string, manager?: EntityManager) {
    const repository = manager?.getRepository(ProjectDeploymentGeneration) || this.generations;
    return repository.findOne({ where: { projectId, environmentName, status: In(LIVE_STATUSES) } });
  }

  candidate(projectId: string, environmentName: string, manager?: EntityManager) {
    const repository = manager?.getRepository(ProjectDeploymentGeneration) || this.generations;
    return repository.findOne({ where: { projectId, environmentName, status: DeploymentGenerationStatus.DEPLOYING } });
  }

  route(projectId: string, environmentName: string, manager?: EntityManager) {
    const repository = manager?.getRepository(ProjectEnvironmentRoute) || this.routes;
    return repository.findOne({ where: { projectId, environmentName } });
  }

  active(projectId: string, environmentName: string, manager?: EntityManager) {
    return this.live(projectId, environmentName, manager);
  }

  async createCandidate(projectId: string, environmentName: string, manager?: EntityManager) {
    if (!manager) return this.generations.manager.transaction((transaction) => this.createCandidate(projectId, environmentName, transaction));
    await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`generation-candidate:${projectId}:${environmentName}`]);
    const repository = manager.getRepository(ProjectDeploymentGeneration);
    const existing = await this.candidate(projectId, environmentName, manager);
    if (existing) throw new BadRequestException({ code: "generation_candidate_exists", message: "A candidate generation is already deploying for this project environment." });
    const raw = await repository.createQueryBuilder("generation")
      .select("COALESCE(MAX(generation.ordinal), 0)", "maximum")
      .where("generation.projectId = :projectId", { projectId })
      .andWhere("generation.environmentName = :environmentName", { environmentName })
      .getRawOne<{ maximum: string | number }>();
    const id = randomUUID();
    const candidateListenerPriority = await this.allocateCandidateListenerPriority(manager);
    const generation = await repository.save(repository.create({
      id,
      projectId,
      environmentName,
      ordinal: Number(raw?.maximum || 0) + 1,
      candidateListenerPriority,
      status: DeploymentGenerationStatus.DEPLOYING,
      terraformStateKey: this.stateKey(projectId, environmentName, id),
      resourceManifest: {},
      cleanupMetadata: {},
      createdByOperationId: null,
      retiredByOperationId: null,
      activatedAt: null,
      retiredAt: null,
      failedAt: null,
      cleanedAt: null,
      metadata: { origin: "normal_deploy", model: "isolated_generation_v2" },
    }));
    const route = await this.allocateRoute(projectId, environmentName, manager);
    route.candidateGenerationId = generation.id;
    await manager.getRepository(ProjectEnvironmentRoute).save(route);
    return generation;
  }

  async bindCreatingOperation(generationId: string, operationId: string, manager?: EntityManager) {
    const repository = manager?.getRepository(ProjectDeploymentGeneration) || this.generations;
    const generation = await repository.findOne({ where: { id: generationId } });
    if (!generation || generation.status !== DeploymentGenerationStatus.DEPLOYING) {
      throw new BadRequestException({ code: "generation_not_deploying", message: "Only the current candidate generation can bind a creating operation." });
    }
    if (!generation.createdByOperationId) {
      generation.createdByOperationId = operationId;
    }
    // The creator is immutable, while a Retry is a new immutable operation
    // deliberately executing the same candidate generation.
    generation.metadata = { ...generation.metadata, activeOperationId: operationId };
    return repository.save(generation);
  }

  async requireRetryableGeneration(generationId: string | null | undefined, projectId: string, environmentName: string, manager?: EntityManager) {
    if (!generationId) throw new BadRequestException({ code: "generation_missing", message: "This operation has no deployment generation. Start a normal New Deploy." });
    const repository = manager?.getRepository(ProjectDeploymentGeneration) || this.generations;
    const generation = await repository.findOne({ where: { id: generationId, projectId, environmentName } });
    if (!generation || !RETRYABLE_STATUSES.includes(generation.status)) {
      throw new BadRequestException({ code: "generation_not_retryable", message: "The failed operation generation is no longer the current candidate. Start a normal New Deploy." });
    }
    if (generation.status === DeploymentGenerationStatus.FAILED) {
      generation.status = DeploymentGenerationStatus.DEPLOYING;
      generation.failedAt = null;
      await repository.save(generation);
      const route = await this.allocateRoute(projectId, environmentName, manager || repository.manager);
      route.candidateGenerationId = generation.id;
      await (manager?.getRepository(ProjectEnvironmentRoute) || this.routes).save(route);
    }
    return generation;
  }

  async requireActiveGeneration(generationId: string | null | undefined, projectId: string, environmentName: string, manager?: EntityManager) {
    if (!generationId) throw new BadRequestException({ code: "generation_missing", message: "This operation has no deployment generation." });
    const repository = manager?.getRepository(ProjectDeploymentGeneration) || this.generations;
    const generation = await repository.findOne({ where: { id: generationId, projectId, environmentName } });
    if (!generation || ![...LIVE_STATUSES, DeploymentGenerationStatus.DEPLOYING].includes(generation.status)) {
      throw new BadRequestException({ code: "generation_retired", message: "The operation belongs to a retired or cleaned deployment generation." });
    }
    return generation;
  }

  async promoteVerified(generationId: string, operationId: string, routeEvidence: Record<string, unknown>, manager?: EntityManager) {
    if (!manager) return this.generations.manager.transaction((transaction) => this.promoteVerified(generationId, operationId, routeEvidence, transaction));
    const repository = manager.getRepository(ProjectDeploymentGeneration);
    const candidate = await repository.findOne({ where: { id: generationId } });
    if (!candidate) throw new BadRequestException("Candidate generation identity is unavailable.");
    await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`generation-promote:${candidate.projectId}:${candidate.environmentName}`]);
    if (candidate.status === DeploymentGenerationStatus.LIVE) return candidate;
    const activeOperationId = String(candidate.metadata?.activeOperationId || candidate.createdByOperationId || "");
    if (candidate.status !== DeploymentGenerationStatus.DEPLOYING || activeOperationId !== operationId) {
      throw new BadRequestException({ code: "generation_promotion_rejected", message: "Only the verified immutable candidate operation may become LIVE." });
    }
    const previous = await this.live(candidate.projectId, candidate.environmentName, manager);
    if (previous && previous.id !== candidate.id) {
      previous.status = DeploymentGenerationStatus.RETIRED;
      previous.retiredByOperationId = operationId;
      previous.retiredAt = new Date();
      previous.cleanupMetadata = { ...previous.cleanupMetadata, cleanupRequired: true, retiredByPromotionOperationId: operationId };
      await repository.save(previous);
    }
    candidate.status = DeploymentGenerationStatus.LIVE;
    candidate.activatedAt = new Date();
    candidate.failedAt = null;
    candidate.metadata = {
      ...candidate.metadata,
      promotionOperationId: operationId,
      routeEvidence,
      candidateListenerPriority: candidate.candidateListenerPriority,
      candidateRouteRemoved: routeEvidence.candidateRouteRemoved === true,
    };
    candidate.resourceManifest = Object.fromEntries([
      ["ecsServiceArn", routeEvidence.ecsServiceArn],
      ["taskDefinitionArn", routeEvidence.taskDefinitionArn],
      ["targetGroupArn", routeEvidence.targetGroupArn],
      ["candidateListenerRuleArn", routeEvidence.candidateListenerRuleArn],
    ].filter((entry): entry is [string, unknown] => entry[1] !== undefined && entry[1] !== null));
    await repository.save(candidate);
    const route = await this.allocateRoute(candidate.projectId, candidate.environmentName, manager);
    route.liveGenerationId = candidate.id;
    route.candidateGenerationId = null;
    route.listenerRuleArn = typeof routeEvidence.listenerRuleArn === "string" ? routeEvidence.listenerRuleArn : route.listenerRuleArn;
    route.metadata = { ...route.metadata, lastPromotionOperationId: operationId, targetGroupArn: routeEvidence.targetGroupArn || null };
    await manager.getRepository(ProjectEnvironmentRoute).save(route);
    return candidate;
  }

  async markFailed(generationId: string, operationId: string, reason: string, manager?: EntityManager) {
    const repository = manager?.getRepository(ProjectDeploymentGeneration) || this.generations;
    const generation = await repository.findOne({ where: { id: generationId } });
    if (!generation || generation.status !== DeploymentGenerationStatus.DEPLOYING) return generation;
    const activeOperationId = String(generation.metadata?.activeOperationId || generation.createdByOperationId || "");
    if (activeOperationId && activeOperationId !== operationId) return generation;
    generation.status = DeploymentGenerationStatus.FAILED;
    generation.failedAt = new Date();
    generation.metadata = { ...generation.metadata, failedOperationId: operationId, failureReason: reason.slice(0, 1000) };
    await repository.save(generation);
    const routeRepository = manager?.getRepository(ProjectEnvironmentRoute) || this.routes;
    const route = await routeRepository.findOne({ where: { projectId: generation.projectId, environmentName: generation.environmentName } });
    if (route?.candidateGenerationId === generation.id) {
      route.candidateGenerationId = null;
      await routeRepository.save(route);
    }
    return generation;
  }

  async markCleanupPending(generationId: string, evidence: Record<string, unknown>, manager?: EntityManager) {
    const repository = manager?.getRepository(ProjectDeploymentGeneration) || this.generations;
    const generation = await repository.findOne({ where: { id: generationId } });
    if (!generation || !CLEANUP_STATUSES.includes(generation.status)) throw new BadRequestException("Generation is not eligible for retired cleanup.");
    generation.status = DeploymentGenerationStatus.CLEANUP_PENDING;
    generation.cleanupMetadata = { ...generation.cleanupMetadata, ...evidence, lastAttemptAt: new Date().toISOString() };
    return repository.save(generation);
  }

  async cleanupTarget(generationId: string, manager?: EntityManager) {
    const repository = manager?.getRepository(ProjectDeploymentGeneration) || this.generations;
    const generation = await repository.findOne({ where: { id: generationId } });
    if (!generation || !CLEANUP_STATUSES.includes(generation.status)) {
      throw new BadRequestException("Only a retired generation can be selected for cleanup.");
    }
    return generationCleanupTarget({
      projectId: generation.projectId,
      environmentName: generation.environmentName,
      generationId: generation.id,
      terraformStateKey: generation.terraformStateKey,
      resourceManifest: generation.resourceManifest,
    });
  }

  async markCleaned(generationId: string, evidence: Record<string, unknown>, manager?: EntityManager) {
    const repository = manager?.getRepository(ProjectDeploymentGeneration) || this.generations;
    const generation = await repository.findOne({ where: { id: generationId } });
    if (!generation || !CLEANUP_STATUSES.includes(generation.status)) throw new BadRequestException("Generation is not eligible for cleanup completion.");
    generation.status = DeploymentGenerationStatus.CLEANED;
    generation.cleanedAt = new Date();
    generation.resourceManifest = {};
    generation.cleanupMetadata = { ...generation.cleanupMetadata, ...evidence, verifiedCleanedAt: generation.cleanedAt.toISOString() };
    return repository.save(generation);
  }

  stateKey(projectId: string, environmentName: string, generationId: string) {
    return `projects/${projectId}/${environmentName}/${generationId}/terraform.tfstate`;
  }

  verificationPriority(generation: ProjectDeploymentGeneration, route: ProjectEnvironmentRoute) {
    // Legacy operations retain their original immutable routing contract. Every
    // newly created generation receives the collision-free persisted priority.
    return generation.candidateListenerPriority ?? route.listenerPriority + 20_000;
  }

  private async allocateCandidateListenerPriority(manager: EntityManager) {
    await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["deployguard-candidate-listener-priority-allocation"]);
    const used = new Set<number>();
    // Keep historical allocations reserved for the life of their generation.
    // The candidate ALB rule is deleted at promotion, but the generation stays
    // physically present until its own cleanup; reusing its priority early
    // would recreate the exact G001/G002 collision class we are preventing.
    const generationRows = await manager.getRepository(ProjectDeploymentGeneration).find({
      select: { candidateListenerPriority: true },
    });
    for (const generation of generationRows) if (generation.candidateListenerPriority != null) used.add(generation.candidateListenerPriority);
    // Existing projects may still have legacy candidate rules at this derived
    // priority. Reserve every known route-derived value until those projects
    // are destroyed, so a new generation cannot collide with old residue.
    const routes = await manager.getRepository(ProjectEnvironmentRoute).find({ select: { listenerPriority: true } });
    for (const route of routes) used.add(route.listenerPriority + 20_000);
    for (let priority = CANDIDATE_PRIORITY_MIN; priority <= CANDIDATE_PRIORITY_MAX; priority += 1) {
      if (!used.has(priority)) return priority;
    }
    throw new BadRequestException("No collision-free candidate listener priority is available.");
  }

  private async allocateRoute(projectId: string, environmentName: string, manager: EntityManager) {
    const repository = manager.getRepository(ProjectEnvironmentRoute);
    const existing = await repository.findOne({ where: { projectId, environmentName } });
    if (existing) return existing;
    await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["deployguard-listener-priority-allocation"]);
    const used = new Set((await repository.find({ select: { listenerPriority: true } })).map((row) => row.listenerPriority));
    let priority = 1000;
    while (used.has(priority) && priority <= 19999) priority += 1;
    if (priority > 19999) throw new BadRequestException("No shared ALB routing priority is available.");
    return repository.save(repository.create({
      projectId,
      environmentName,
      listenerPriority: priority,
      listenerRuleArn: null,
      liveGenerationId: null,
      candidateGenerationId: null,
      metadata: { allocation: "db_locked_v1" },
    }));
  }
}
