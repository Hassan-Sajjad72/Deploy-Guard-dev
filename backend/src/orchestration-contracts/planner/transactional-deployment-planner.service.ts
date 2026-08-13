import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DataSource,
  EntityManager,
  In,
  MoreThan,
} from "typeorm";
import {
  canonicalizeJson,
  canonicalSha256,
} from "../contracts/canonical-json";
import {
  DEPLOYMENT_INTENT_KINDS,
  PlannerDecisionV1,
} from "../contracts/deployment-intent.types";
import {
  InfrastructureChangeSetV1,
  InfrastructureSpecV1,
} from "../contracts/infrastructure-manifest.types";
import {
  assertNoSecretMaterial,
  validateInfrastructureManifestCreate,
  validateReleaseManifestCreate,
} from "../contracts/manifest.validator";
import { ReleaseSpecV1 } from "../contracts/release-manifest.types";
import { DeployGuardWorkerEnvelopeV1 } from "../contracts/worker-envelope.types";
import {
  validateWorkerEnvelopeV1,
  workerEnvelopePayloadForHash,
} from "../contracts/worker-envelope.validator";
import { DeploymentIntent } from "../entities/deployment-intent.entity";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { OrchestrationOutbox } from "../entities/orchestration-outbox.entity";
import { ProjectOperationLease } from "../entities/project-operation-lease.entity";
import { ReleaseManifest } from "../entities/release-manifest.entity";
import { InitialReleaseDraft } from "../entities/initial-release-draft.entity";
import {
  canonicalPlannerIdempotencyKey,
  changedCanonicalPaths,
  classifyDeployment,
  destructiveInfrastructurePaths,
  infrastructureCategories,
  plannerRequestFingerprint,
  PlannerBlockerV1,
} from "./transactional-deployment-planner.pure";
import {
  PlannerIdempotencyConflictError,
  PlannerClassificationNotAllowedError,
  SanitizedDeploymentIntentV1,
  TransactionalDeploymentPlannerInputV1,
  TransactionalDeploymentPlannerResultV1,
} from "./transactional-deployment-planner.types";
import { InactiveV1ShadowInsertionAdapter } from "../release-lane/inactive-v1-shadow-insertion.adapter";
import { normalV1IsShared } from "../release-lane/normal-v1-activation-policy";

type ProjectRow = {
  id: string;
  ownerUserId: number;
  name: string;
  repositoryUrl: string;
  repositoryFullName: string | null;
  targetBranch: string;
  environmentName: string;
  status: string;
  archivedAt: Date | null;
  deletionFenceToken: string | null;
  deletionIntentId: string | null;
  deletionStartedAt: Date | null;
};

type DeploymentContractRow = {
  id: string;
  projectId: string;
  repositoryFullName: string | null;
  branch: string;
  commitSha: string | null;
  detectionSourceCommit: string | null;
  appRoot: string;
  dockerStrategy: "generated" | "custom" | null;
  dockerTemplate: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  startCommand: string | null;
  port: number | null;
  healthPath: string;
  buildTimeEnvVars: string[];
  runtimeEnvVars: string[];
  secretEnvVars: string[];
  missingEnvVars: string[];
  databaseRequired: boolean;
  databaseEngine: "postgres" | "mysql" | null;
  persistentStorageRequired: boolean;
  ecsPlan: {
    containerPort: number | null;
    targetGroupPort: number | null;
    healthCheckPath: string;
    command: string | null;
    cpu: number;
    memory: number;
  };
  deployable: boolean;
  blockers: string[];
  contractHash: string;
  invalidatedReason: string | null;
  invalidatedAt: Date | null;
};

type PlannerContext = {
  project: ProjectRow;
  contract: DeploymentContractRow | null;
  preflight: {
    inputFingerprint: string | null;
    validationStatus: string;
    errors: string[] | null;
  } | null;
  configurationFingerprint: string;
  buildConfigurationFingerprint: string;
  runtimeConfigurationFingerprint: string;
  plainVariableNames: string[];
  secretReferenceNames: string[];
  buildArgumentNames: string[];
  bindingRevisions: Array<{ id: string; revision: string }>;
  database: {
    id: string;
    provider: "managed" | "external" | "none" | null;
    engine: "postgres" | "mysql" | null;
    internalHost: string | null;
    databaseName: string | null;
    databaseUser: string | null;
    persistenceEnabled: boolean;
    backupEnabled: boolean;
    externalTlsRequired: boolean;
    updatedAt: Date;
  } | null;
  storage: {
    id: string;
    enabled: boolean;
    encrypted: boolean;
    backupEnabled: boolean;
    updatedAt: Date;
  } | null;
  legacyInfrastructure: {
    id: string;
    status: string;
    appliedManifestId: string | null;
  } | null;
  activeLeases: ProjectOperationLease[];
  activeIntentIds: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COMMIT_SHA = /^[0-9a-f]{40,64}$/i;
const RETRYABLE_TRANSACTION_CODES = new Set(["40001", "40P01"]);
const EXECUTABLE_KINDS = new Set(["deploy", "retry", "resume", "plan", "apply"]);

@Injectable()
export class TransactionalDeploymentPlannerService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    @Optional()
    private readonly shadowInsertion?: InactiveV1ShadowInsertionAdapter,
  ) {}

  async plan(input: TransactionalDeploymentPlannerInputV1): Promise<TransactionalDeploymentPlannerResultV1> {
    this.validateInput(input);
    let attempt = 0;
    while (true) {
      try {
        const result = await this.dataSource.transaction("SERIALIZABLE", (manager) => this.planInTransaction(manager, input));
        this.shadowInsertion?.observePlanner({
          projectId: result.intent.projectId,
          environmentName: result.intent.environmentName,
          intentId: result.intent.id,
          classification: result.decision.classification,
        });
        return result;
      } catch (error) {
        const code = typeof error === "object" && error ? String((error as { code?: unknown }).code || "") : "";
        if (!RETRYABLE_TRANSACTION_CODES.has(code) || ++attempt >= 3) throw error;
      }
    }
  }

  private async planInTransaction(
    manager: EntityManager,
    input: TransactionalDeploymentPlannerInputV1,
  ): Promise<TransactionalDeploymentPlannerResultV1> {
    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`deployguard:planner:${input.projectId}:${input.environmentName}`],
    );

    const context = await this.loadContext(manager, input);
    const blockers = this.contextBlockers(context, input);
    const infrastructureManifests = manager.getRepository(InfrastructureManifest);
    const releaseManifests = manager.getRepository(ReleaseManifest);
    const currentApplied = await infrastructureManifests.findOne({
      where: {
        projectId: input.projectId,
        environmentName: input.environmentName,
        status: "applied",
      },
      order: { createdAt: "DESC" },
    });
    const currentStable = await releaseManifests.findOne({
      where: {
        projectId: input.projectId,
        environmentName: input.environmentName,
        status: "stable",
      },
      order: { createdAt: "DESC" },
    });
    if (input.preMutationRecovery) {
      await this.assertPreMutationRecovery(
        manager,
        input,
        currentApplied,
        currentStable,
      );
    }
    const pinnedInitialFoundation = this.initialReleaseFoundation(
      input,
      currentApplied,
      currentStable,
    );
    const existingInitialDraft = await this.existingInitialReleaseDraft(
      manager,
      input,
      currentApplied,
      currentStable,
    );
    const pinnedLaterFoundation = this.laterReleaseFoundation(
      input,
      currentApplied,
      currentStable,
    );
    const frozenExistingFoundation = existingInitialDraft ? currentApplied : null;
    const desiredInfrastructureSpec = pinnedInitialFoundation || pinnedLaterFoundation || frozenExistingFoundation
      ? (pinnedInitialFoundation || pinnedLaterFoundation || frozenExistingFoundation)!.desiredSpec
      : this.buildInfrastructureSpec(context);
    const desiredInfrastructureSpecHash = canonicalSha256(desiredInfrastructureSpec);
    const frozenDraft = existingInitialDraft?.releaseDraft as import("../contracts/release-manifest.types").CreateReleaseManifestInputV1 | undefined;
    const desiredReleaseSpec = frozenDraft?.releaseSpec || this.buildReleaseSpec(context, input);
    const desiredReleaseSpecHash = frozenDraft?.specHash || canonicalSha256(desiredReleaseSpec);
    const desiredReleaseFingerprints = frozenDraft
      ? {
          buildFingerprint: frozenDraft.buildFingerprint,
          runtimeFingerprint: frozenDraft.runtimeFingerprint,
          identityFingerprint: canonicalSha256({
            specHash: desiredReleaseSpecHash,
            deploymentContractHash: frozenDraft.deploymentContractHash,
            configurationFingerprint: frozenDraft.configurationFingerprint,
            buildFingerprint: frozenDraft.buildFingerprint,
            runtimeFingerprint: frozenDraft.runtimeFingerprint,
          }),
        }
      : this.releaseFingerprints(context, desiredReleaseSpec, desiredReleaseSpecHash);
    const requestPayload = canonicalizeJson({
      kind: input.kind,
      requestedCommitSha: input.requestedCommitSha || context.contract?.commitSha || null,
      deploymentContractHash: context.contract?.contractHash || null,
      configurationFingerprint: context.configurationFingerprint,
      desiredInfrastructureSpecHash,
      desiredReleaseSpecHash: desiredReleaseFingerprints.identityFingerprint,
      sourcePipelineRunId: input.sourcePipelineRunId || null,
      recoveryCode: input.recoveryCode || null,
      recoveryOfIntentId: input.preMutationRecovery?.failedIntentId || null,
      recoveryEvidenceHash: input.preMutationRecovery?.evidenceHash || null,
      ...(pinnedInitialFoundation
        ? { initialReleaseInfrastructureManifestId: pinnedInitialFoundation.id }
        : {}),
      ...(existingInitialDraft
        ? { initialReleaseDraftId: existingInitialDraft.id, initialReleaseDraftHash: existingInitialDraft.draftHash }
        : {}),
    });
    assertNoSecretMaterial(requestPayload, "deploymentIntent.requestPayload");

    const canonicalKey = canonicalPlannerIdempotencyKey(
      input.projectId,
      input.environmentName,
      `user:${input.actor.userId}`,
      input.idempotencyKey,
    );
    const requestFingerprint = plannerRequestFingerprint(requestPayload);
    const intents = manager.getRepository(DeploymentIntent);
    const existing = await intents.findOne({
      where: {
        projectId: input.projectId,
        environmentName: input.environmentName,
        canonicalIdempotencyKey: canonicalKey,
      },
    });
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new PlannerIdempotencyConflictError();
      }
      if (!existing.decision) {
        throw new Error("Existing deployment intent has no committed planner decision.");
      }
      return {
        intent: this.sanitizeIntent(existing),
        decision: existing.decision as PlannerDecisionV1,
        replayed: true,
      };
    }

    const now = new Date();
    let intent = await intents.save(intents.create({
      schemaVersion: 1,
      projectId: input.projectId,
      environmentName: input.environmentName,
      requestedByUserId: input.actor.userId,
      kind: input.kind,
      classification: null,
      status: "received",
      clientIdempotencyKey: input.idempotencyKey,
      canonicalIdempotencyKey: canonicalKey,
      requestFingerprint,
      requestPayload,
      decision: null,
      infrastructureManifestId: null,
      releaseManifestId: null,
      sourcePipelineRunId: input.sourcePipelineRunId || null,
      pipelineRunId: null,
      destroyOperationId: null,
      failureCode: null,
      failureMessage: null,
      receivedAt: now,
      plannedAt: null,
      enqueuedAt: null,
      startedAt: null,
      completedAt: null,
    }));

    const currentStableIdentityHash = currentStable
      ? canonicalSha256({
          specHash: currentStable.specHash,
          deploymentContractHash: currentStable.deploymentContractHash,
          configurationFingerprint: currentStable.configurationFingerprint,
          buildFingerprint: currentStable.buildFingerprint,
          runtimeFingerprint: currentStable.runtimeFingerprint,
        })
      : null;
    const infrastructureOnlyRequest = ["plan", "apply"].includes(input.kind);
    const classification = classifyDeployment({
      blockers,
      hasAppliedInfrastructure: Boolean(currentApplied),
      appliedInfrastructureSpecHash: currentApplied?.specHash || null,
      desiredInfrastructureSpecHash,
      stableReleaseSpecHash: currentStableIdentityHash,
      desiredReleaseSpecHash: infrastructureOnlyRequest
        ? currentStableIdentityHash || desiredReleaseFingerprints.identityFingerprint
        : desiredReleaseFingerprints.identityFingerprint,
    });
    if (input.requiredClassification && classification !== input.requiredClassification) {
      throw new PlannerClassificationNotAllowedError(classification);
    }
    const infrastructureChangedPaths = changedCanonicalPaths(
      currentApplied?.desiredSpec || {},
      desiredInfrastructureSpec,
    );
    const releaseChangedPaths = changedCanonicalPaths(
      currentStable?.releaseSpec || {},
      desiredReleaseSpec,
    );
    if (
      currentStable
      && currentStable.configurationFingerprint !== context.configurationFingerprint
      && !releaseChangedPaths.includes("configurationFingerprint")
    ) {
      releaseChangedPaths.push("configurationFingerprint");
      releaseChangedPaths.sort();
    }
    if (!blockers.length) {
      this.validateCandidateManifests(
        context,
        input,
        currentApplied,
        currentStable,
        desiredInfrastructureSpec,
        desiredInfrastructureSpecHash,
        infrastructureChangedPaths,
        desiredReleaseSpec,
        desiredReleaseSpecHash,
        desiredReleaseFingerprints,
      );
    }

    let desiredInfrastructure = currentApplied;
    let desiredRelease: ReleaseManifest | null = currentStable;

    if (classification === "infrastructure_change") {
      desiredInfrastructure = await this.findOrCreateInfrastructureManifest(
        manager,
        intent,
        context,
        desiredInfrastructureSpec,
        desiredInfrastructureSpecHash,
        currentApplied,
        infrastructureChangedPaths,
      );
      if (["deploy", "retry", "resume"].includes(input.kind) && currentStable) {
        desiredRelease = await this.findOrCreateReleaseManifest(
          manager,
          intent,
          context,
          desiredInfrastructure,
          desiredReleaseSpec,
          desiredReleaseSpecHash,
          desiredReleaseFingerprints,
          currentStable,
          "blocked_on_infrastructure",
        );
      } else if (["deploy", "retry", "resume"].includes(input.kind)) {
        await this.findOrCreateInitialReleaseDraft(
          manager, intent, context, desiredInfrastructure, desiredReleaseSpec,
          desiredReleaseSpecHash, desiredReleaseFingerprints, currentStable,
        );
        desiredRelease = null;
      } else {
        desiredRelease = null;
      }
    } else if (classification === "release_only" && currentApplied && currentStable) {
      desiredRelease = await this.findOrCreateReleaseManifest(
        manager,
        intent,
        context,
        currentApplied,
        desiredReleaseSpec,
        desiredReleaseSpecHash,
        desiredReleaseFingerprints,
          currentStable,
          "desired",
          Boolean(input.preMutationRecovery),
        );
    } else if (classification === "release_only" && currentApplied) {
      if (existingInitialDraft) {
        desiredRelease = await this.findOrCreateReleaseManifest(
          manager, intent, context, currentApplied, desiredReleaseSpec,
          desiredReleaseSpecHash, desiredReleaseFingerprints, null, "desired",
          Boolean(input.preMutationRecovery),
        );
      } else {
        await this.findOrCreateInitialReleaseDraft(
          manager, intent, context, currentApplied, desiredReleaseSpec,
          desiredReleaseSpecHash, desiredReleaseFingerprints, null,
        );
        desiredRelease = null;
      }
    }

    const reasonCodes = classification === "unsafe_or_unknown"
      ? [...new Set(blockers.map((item) => item.code))]
      : classification === "infrastructure_change"
        ? [currentApplied ? "INFRASTRUCTURE_SPEC_CHANGED" : "INITIAL_INFRASTRUCTURE"]
        : classification === "release_only"
          ? [currentStable ? "RELEASE_SPEC_CHANGED" : "INITIAL_RELEASE"]
          : ["DESIRED_STATE_ALREADY_SATISFIED"];
    const decision: PlannerDecisionV1 = canonicalizeJson({
      schemaVersion: 1,
      intentId: intent.id,
      classification,
      reasonCodes,
      currentAppliedInfrastructureManifestId: currentApplied?.id || null,
      desiredInfrastructureManifestId: desiredInfrastructure?.id || null,
      currentStableReleaseManifestId: currentStable?.id || null,
      desiredReleaseManifestId: desiredRelease?.id || null,
      infrastructureChangedPaths,
      releaseChangedPaths,
      approvalRequired: classification === "infrastructure_change",
      executionLane: classification === "infrastructure_change"
        ? "infrastructure"
        : classification === "release_only"
          ? "release"
          : "none",
      blockedReasons: blockers,
    });

    intent.classification = classification;
    intent.status = classification === "unsafe_or_unknown"
      ? "rejected"
      : classification === "no_op"
        ? "no_op"
        : "planned";
    intent.decision = decision;
    intent.infrastructureManifestId = desiredInfrastructure?.id || null;
    intent.releaseManifestId = desiredRelease?.id || null;
    intent.plannedAt = now;
    intent.failureCode = classification === "unsafe_or_unknown" ? "UNSAFE_OR_UNKNOWN" : null;
    intent.failureMessage = classification === "unsafe_or_unknown"
      ? "Deployment planning was rejected because required state could not be proven safe."
      : null;
    intent = await intents.save(intent);

    const initialReleaseOneShot = classification === "release_only"
      && desiredRelease === null
      && currentStable === null;
    if ((classification === "infrastructure_change" || classification === "release_only") && !initialReleaseOneShot) {
      await this.writeOutbox(
        manager,
        intent,
        decision,
        context,
        input.actor.role === "admin" ? "admin" : "developer",
        now,
      );
    }

    return {
      intent: this.sanitizeIntent(intent),
      decision,
      replayed: false,
    };
  }

  private async loadContext(
    manager: EntityManager,
    input: TransactionalDeploymentPlannerInputV1,
  ): Promise<PlannerContext> {
    const projects = await manager.query(
      `SELECT id, owner_user_id AS "ownerUserId", name, repository_url AS "repositoryUrl",
              repository_full_name AS "repositoryFullName", target_branch AS "targetBranch",
              environment_name AS "environmentName", status, archived_at AS "archivedAt",
              deletion_fence_token AS "deletionFenceToken", deletion_intent_id AS "deletionIntentId",
              deletion_started_at AS "deletionStartedAt"
       FROM projects WHERE id = $1`,
      [input.projectId],
    ) as ProjectRow[];
    if (!projects[0]) throw new Error("Project not found.");
    const project = projects[0];
    if (input.actor.role !== "admin" && project.ownerUserId !== input.actor.userId) {
      throw new Error("Actor is not authorized to plan this project.");
    }

    const contracts = await manager.query(
        `SELECT id, project_id AS "projectId", repository_full_name AS "repositoryFullName",
                branch, commit_sha AS "commitSha", detection_source_commit AS "detectionSourceCommit",
                app_root AS "appRoot", docker_strategy AS "dockerStrategy",
                docker_template AS "dockerTemplate", build_command AS "buildCommand",
                output_directory AS "outputDirectory", start_command AS "startCommand",
                port, health_path AS "healthPath", build_time_env_vars AS "buildTimeEnvVars",
                runtime_env_vars AS "runtimeEnvVars", secret_env_vars AS "secretEnvVars",
                missing_env_vars AS "missingEnvVars", database_required AS "databaseRequired",
                database_engine AS "databaseEngine",
                persistent_storage_required AS "persistentStorageRequired",
                ecs_plan AS "ecsPlan", deployable, blockers, contract_hash AS "contractHash",
                invalidated_reason AS "invalidatedReason", invalidated_at AS "invalidatedAt"
         FROM project_deployment_contracts WHERE project_id = $1 LIMIT 1`,
        [input.projectId],
      );
    const preflights = await manager.query(
        `SELECT input_fingerprint AS "inputFingerprint", validation_status AS "validationStatus", errors
         FROM project_preflight_reports WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 1`,
        [input.projectId],
      );
    const variables = await manager.query(
        `SELECT id, key, scope, is_secret AS "isSecret",
                configuration_fingerprint AS "configurationFingerprint", updated_at AS "updatedAt"
         FROM project_environment_variables
         WHERE project_id = $1 AND is_active = true
         ORDER BY key ASC`,
        [input.projectId],
      );
    const tiers = await manager.query(
        `SELECT id, provider, engine, internal_host AS "internalHost",
                database_name AS "databaseName", database_user AS "databaseUser",
                persistence_enabled AS "persistenceEnabled",
                backup_enabled AS "backupEnabled", external_tls_required AS "externalTlsRequired",
                updated_at AS "updatedAt"
         FROM project_database_tiers WHERE project_id = $1 LIMIT 1`,
        [input.projectId],
      );
    const storages = await manager.query(
        `SELECT id, enabled, encrypted, backup_enabled AS "backupEnabled", updated_at AS "updatedAt"
         FROM project_persistent_storage
         WHERE project_id = $1 AND environment_name = $2
         ORDER BY updated_at DESC LIMIT 1`,
        [input.projectId, input.environmentName],
      );
    const legacyInfrastructure = await manager.query(
        `SELECT id, status, applied_manifest_id AS "appliedManifestId"
         FROM project_infrastructure_environments
         WHERE project_id = $1 AND environment_name = $2
         ORDER BY updated_at DESC LIMIT 1`,
        [input.projectId, input.environmentName],
      );
    const contract = (contracts[0] || null) as DeploymentContractRow | null;
    const rows = variables as Array<{
      id: string;
      key: string;
      scope: "build" | "runtime" | "both";
      isSecret: boolean;
      configurationFingerprint: string | null;
      updatedAt: Date;
    }>;
    const variableFingerprintInput = rows.map((row) => ({
      id: row.id,
      key: row.key,
      scope: row.scope,
      secret: row.isSecret,
      revision: row.configurationFingerprint || new Date(row.updatedAt).toISOString(),
    }));
    const buildVariableFingerprintInput = variableFingerprintInput.filter((_, index) =>
      ["build", "both"].includes(rows[index].scope),
    );
    const runtimeVariableFingerprintInput = variableFingerprintInput.filter((_, index) =>
      ["runtime", "both"].includes(rows[index].scope),
    );
    const bindingRows = await manager.query(
      `SELECT id, configuration_fingerprint AS "configurationFingerprint"
       FROM project_service_bindings WHERE project_id = $1
       ORDER BY created_at DESC`,
      [input.projectId],
    ) as Array<{ id: string; configurationFingerprint: string }>;
    const bindingRevisions = [...new Map(
      bindingRows.map((row) => [row.id, { id: row.id, revision: row.configurationFingerprint }]),
    ).values()].sort((left, right) => left.id.localeCompare(right.id));
    const activeLeases = await manager.getRepository(ProjectOperationLease).find({
      where: {
        projectId: input.projectId,
        environmentName: input.environmentName,
        status: In(["acquired", "heartbeat_active"]),
        expiresAt: MoreThan(new Date()),
      },
    });
    const activeIntents = await manager.getRepository(DeploymentIntent).find({
      where: {
        projectId: input.projectId,
        environmentName: input.environmentName,
        status: In(["planned", "enqueued", "running"]),
      },
      select: { id: true },
    });
    const serviceConfiguration = {
      bindings: bindingRevisions,
      database: tiers[0] ? {
        id: tiers[0].id,
        updatedAt: new Date(tiers[0].updatedAt).toISOString(),
      } : null,
      storage: storages[0] ? {
        id: storages[0].id,
        updatedAt: new Date(storages[0].updatedAt).toISOString(),
      } : null,
    };
    return {
      project,
      contract,
      preflight: preflights[0] || null,
      configurationFingerprint: canonicalSha256({
        variables: variableFingerprintInput,
        ...serviceConfiguration,
      }),
      buildConfigurationFingerprint: canonicalSha256(buildVariableFingerprintInput),
      runtimeConfigurationFingerprint: canonicalSha256({
        variables: runtimeVariableFingerprintInput,
        ...serviceConfiguration,
      }),
      plainVariableNames: rows.filter((row) => !row.isSecret && ["runtime", "both"].includes(row.scope)).map((row) => row.key).sort(),
      secretReferenceNames: rows.filter((row) => row.isSecret && ["runtime", "both"].includes(row.scope)).map((row) => row.key).sort(),
      buildArgumentNames: rows.filter((row) => ["build", "both"].includes(row.scope)).map((row) => row.key).sort(),
      bindingRevisions,
      database: tiers[0] || null,
      storage: storages[0] || null,
      legacyInfrastructure: legacyInfrastructure[0] || null,
      activeLeases,
      activeIntentIds: activeIntents.map((intent) => intent.id),
    };
  }

  private contextBlockers(
    context: PlannerContext,
    input: TransactionalDeploymentPlannerInputV1,
  ): PlannerBlockerV1[] {
    const blockers: PlannerBlockerV1[] = [];
    const add = (code: string, message: string, source: string) => blockers.push({ code, message, source });
    const { project, contract, preflight } = context;
    if (project.archivedAt || project.status === "archived") add("PROJECT_ARCHIVED", "The project is archived.", "projects");
    if (project.environmentName !== input.environmentName) add("ENVIRONMENT_MISMATCH", "The requested environment does not match the project environment.", "projects");
    if (project.deletionFenceToken || project.deletionIntentId || project.deletionStartedAt) add("DELETION_FENCE_ACTIVE", "Project deletion is in progress.", "projects");
    if (input.actor.role === "readonly") add("READ_ONLY_ACTOR", "Read-only actors cannot create deployment intents.", "actor");
    if (!EXECUTABLE_KINDS.has(input.kind)) add("UNSUPPORTED_INTENT_KIND", "This planner version does not execute the requested intent kind.", "planner");
    if (!contract) {
      add("DEPLOYMENT_CONTRACT_MISSING", "A deployment contract is required.", "project_deployment_contracts");
    } else {
      if (!contract.deployable) add("DEPLOYMENT_CONTRACT_BLOCKED", "The deployment contract is not deployable.", "project_deployment_contracts");
      if (!contract.repositoryFullName && !project.repositoryFullName) add("REPOSITORY_IDENTITY_MISSING", "The repository identity is not available.", "project_deployment_contracts");
      if (contract.invalidatedAt || contract.invalidatedReason) add("DEPLOYMENT_CONTRACT_STALE", "The deployment contract is stale.", "project_deployment_contracts");
      if (!contract.commitSha || !COMMIT_SHA.test(contract.commitSha)) add("SOURCE_COMMIT_UNPROVEN", "The source commit is not pinned.", "project_deployment_contracts");
      if (input.requestedCommitSha && input.requestedCommitSha !== contract.commitSha) add("SOURCE_COMMIT_MISMATCH", "The requested commit does not match the deployment contract.", "request");
      if (contract.detectionSourceCommit && contract.commitSha !== contract.detectionSourceCommit) add("DETECTION_COMMIT_STALE", "Detection evidence is for a different commit.", "project_deployment_contracts");
      for (const item of contract.blockers || []) add("CONTRACT_BLOCKER", String(item).slice(0, 300), "project_deployment_contracts");
      for (const variable of contract.missingEnvVars || []) add("REQUIRED_CONFIGURATION_MISSING", `Required variable ${variable} is not configured.`, "project_deployment_contracts");
      if (contract.databaseRequired && (!context.database || !context.database.provider || context.database.provider === "none")) {
        add("DATABASE_CONFIGURATION_UNRESOLVED", "The required database tier has not been configured.", "project_database_tiers");
      }
    }
    if (!preflight) {
      add("PREFLIGHT_MISSING", "A deployability pre-flight report is required.", "project_preflight_reports");
    } else if (!contract || preflight.inputFingerprint !== contract.contractHash) {
      add("PREFLIGHT_STALE", "Pre-flight evidence does not match the deployment contract.", "project_preflight_reports");
    } else if (!["passed", "passed_with_warnings"].includes(preflight.validationStatus)) {
      add("PREFLIGHT_FAILED", "Deployability pre-flight did not pass.", "project_preflight_reports");
    }
    if (
      context.legacyInfrastructure
      && ["provisioned", "partially_provisioned"].includes(context.legacyInfrastructure.status)
      && !context.legacyInfrastructure.appliedManifestId
    ) {
      add("UNVERIFIED_LEGACY_FOUNDATION", "Existing infrastructure has no verified applied manifest.", "project_infrastructure_environments");
    }
    if (context.activeLeases.length) add("ACTIVE_OPERATION_LEASE", "Another project operation is active.", "project_operation_leases");
    if (context.activeIntentIds.length) add("ACTIVE_DEPLOYMENT_INTENT", "Another deployment intent is active.", "deployment_intents");
    return blockers.sort((left, right) => left.code.localeCompare(right.code));
  }

  private buildInfrastructureSpec(context: PlannerContext): InfrastructureSpecV1 {
    const contract = context.contract;
    const port = contract?.ecsPlan?.containerPort || contract?.port || 3000;
    const targetPort = contract?.ecsPlan?.targetGroupPort || port;
    const databaseMode = contract?.databaseRequired
      ? context.database?.provider || "none"
      : "none";
    const databaseRevision = context.database
      ? canonicalSha256({
          id: context.database.id,
          provider: context.database.provider,
          engine: context.database.engine,
          internalHost: context.database.internalHost,
          databaseName: context.database.databaseName,
          databaseUser: context.database.databaseUser,
          persistenceEnabled: context.database.persistenceEnabled,
          backupEnabled: context.database.backupEnabled,
          updatedAt: new Date(context.database.updatedAt).toISOString(),
        })
      : null;
    return canonicalizeJson({
      region: this.config.get<string>("AWS_REGION", "us-east-1"),
      terraformTemplateVersion: this.config.get<string>("TERRAFORM_TEMPLATE_VERSION", "v1"),
      network: {
        topology: "managed_vpc",
        availabilityZoneCount: 2,
        publicSubnets: true,
        privateSubnets: true,
        natMode: "single",
      },
      registry: {
        managedEcrRepository: true,
        immutableTags: true,
        lifecyclePolicyHash: null,
      },
      ecsFoundation: {
        clusterMode: "shared_project",
        serviceName: `deployguard-${context.project.id}`,
        launchType: "fargate",
        capacityProviders: ["FARGATE"],
      },
      ingress: {
        enabled: true,
        protocol: "HTTP",
        containerPort: port,
        targetGroupPort: targetPort,
        healthCheckPath: contract?.ecsPlan?.healthCheckPath || contract?.healthPath || "/",
        healthCheckProtocol: "HTTP",
      },
      database: {
        mode: databaseMode,
        engine: databaseMode === "none" ? null : context.database?.engine || contract?.databaseEngine || null,
        tierRevision: databaseRevision,
        persistence: databaseMode === "managed" ? Boolean(context.database?.persistenceEnabled) : false,
        externalTlsRequired: databaseMode === "external" ? Boolean(context.database?.externalTlsRequired) : null,
      },
      storage: {
        efsRequired: Boolean(contract?.persistentStorageRequired || context.storage?.enabled),
        accessPointRequired: Boolean(contract?.persistentStorageRequired || context.storage?.enabled),
        encrypted: context.storage?.encrypted ?? true,
        backupRequired: context.storage?.backupEnabled ?? false,
      },
      discovery: {
        cloudMapRequired: databaseMode === "managed",
        namespace: databaseMode === "managed" ? `project-${context.project.id}.deployguard.local` : null,
      },
      observability: {
        cloudWatchLogs: this.config.get<string>("CLOUDWATCH_LOGS_ENABLED", "true") === "true",
        cloudWatchMetrics: this.config.get<string>("CLOUDWATCH_METRICS_ENABLED", "true") === "true",
        prometheus: this.config.get<string>("PROMETHEUS_ENABLED", "false") === "true",
      },
      iamPolicyRevision: this.config.get<string>("IAM_POLICY_REVISION", "v1"),
      tags: {
        Environment: context.project.environmentName,
        ManagedBy: "DeployGuard",
        ProjectId: context.project.id,
      },
    } satisfies InfrastructureSpecV1);
  }

  private buildReleaseSpec(
    context: PlannerContext,
    input: TransactionalDeploymentPlannerInputV1,
  ): ReleaseSpecV1 {
    const contract = context.contract;
    const port = contract?.ecsPlan?.containerPort || contract?.port || 3000;
    return canonicalizeJson({
      source: {
        repositoryFullName: contract?.repositoryFullName || context.project.repositoryFullName || "",
        branch: contract?.branch || context.project.targetBranch,
        commitSha: input.requestedCommitSha || contract?.commitSha || "",
        appRoot: contract?.appRoot || ".",
      },
      build: {
        dockerStrategy: contract?.dockerStrategy || "generated",
        dockerTemplate: contract?.dockerTemplate || null,
        buildCommand: contract?.buildCommand || null,
        outputDirectory: contract?.outputDirectory || null,
        buildArgumentNames: context.buildArgumentNames,
      },
      runtime: {
        imageUri: null,
        imageDigest: null,
        command: contract?.ecsPlan?.command || contract?.startCommand || null,
        containerPort: port,
        cpu: contract?.ecsPlan?.cpu || 256,
        memory: contract?.ecsPlan?.memory || 512,
        plainVariableNames: context.plainVariableNames,
        secretReferenceNames: context.secretReferenceNames,
        serviceBindingRevisions: context.bindingRevisions,
      },
      health: {
        path: contract?.ecsPlan?.healthCheckPath || contract?.healthPath || "/",
        expectedPort: port,
        gracePeriodSeconds: 60,
      },
    } satisfies ReleaseSpecV1);
  }

  private async findOrCreateInfrastructureManifest(
    manager: EntityManager,
    intent: DeploymentIntent,
    context: PlannerContext,
    desiredSpec: InfrastructureSpecV1,
    specHash: string,
    currentApplied: InfrastructureManifest | null,
    changedPaths: string[],
  ) {
    const repository = manager.getRepository(InfrastructureManifest);
    const existing = await repository.findOne({
      where: {
        projectId: intent.projectId,
        environmentName: intent.environmentName,
        specHash,
      },
      order: { createdAt: "DESC" },
    });
    if (existing) return existing;
    const revision = await this.nextRevision(manager, "infrastructure_manifests", intent.projectId, intent.environmentName);
    const changeSet: InfrastructureChangeSetV1 = {
      fromManifestId: currentApplied?.id || null,
      changedPaths,
      categories: infrastructureCategories(changedPaths) as InfrastructureChangeSetV1["categories"],
      destructivePaths: destructiveInfrastructurePaths(currentApplied?.desiredSpec || {}, desiredSpec, changedPaths),
      requiresApproval: true,
      reasonCodes: [currentApplied ? "INFRASTRUCTURE_SPEC_CHANGED" : "INITIAL_INFRASTRUCTURE"],
    };
    const createInput = validateInfrastructureManifestCreate({
      schemaVersion: 1,
      projectId: intent.projectId,
      environmentName: intent.environmentName,
      parentManifestId: currentApplied?.id || null,
      createdByUserId: intent.requestedByUserId,
      origin: "planner",
      terraformTemplateVersion: desiredSpec.terraformTemplateVersion,
      stateBackend: this.stateBackend(),
      stateKey: this.stateKey(intent.projectId, intent.environmentName, revision),
      desiredSpec,
      changeSet,
      requiresTerraform: true,
      specHash,
    });
    return repository.save(repository.create({
      ...createInput,
      revision,
      parentManifestId: createInput.parentManifestId || null,
      createdByIntentId: intent.id,
      createdByUserId: createInput.createdByUserId || null,
      status: "desired",
      stateVersionId: null,
      planArtifactReference: null,
      planArtifactSha256: null,
      planInputFingerprint: null,
      planConfigurationFingerprint: context.configurationFingerprint,
      terraformOutputs: null,
      terraformOutputsHash: null,
      resourceCount: null,
      failureCode: null,
      failureMessage: null,
      plannedAt: null,
      approvedAt: null,
      applyStartedAt: null,
      appliedAt: null,
      supersededAt: null,
      destroyedAt: null,
    }));
  }

  private validateCandidateManifests(
    context: PlannerContext,
    input: TransactionalDeploymentPlannerInputV1,
    currentApplied: InfrastructureManifest | null,
    currentStable: ReleaseManifest | null,
    desiredInfrastructureSpec: InfrastructureSpecV1,
    desiredInfrastructureSpecHash: string,
    infrastructureChangedPaths: string[],
    desiredReleaseSpec: ReleaseSpecV1,
    desiredReleaseSpecHash: string,
    releaseFingerprints: {
      buildFingerprint: string;
      runtimeFingerprint: string;
      identityFingerprint: string;
    },
  ) {
    const infrastructureManifestId = currentApplied?.id || "00000000-0000-4000-8000-000000000001";
    validateInfrastructureManifestCreate({
      schemaVersion: 1,
      projectId: input.projectId,
      environmentName: input.environmentName,
      parentManifestId: currentApplied?.id || null,
      createdByUserId: input.actor.userId,
      origin: "planner",
      terraformTemplateVersion: desiredInfrastructureSpec.terraformTemplateVersion,
      stateBackend: this.stateBackend(),
      stateKey: this.stateKey(
        input.projectId,
        input.environmentName,
        currentApplied ? (BigInt(currentApplied.revision) + 1n).toString() : "1",
      ),
      desiredSpec: desiredInfrastructureSpec,
      changeSet: {
        fromManifestId: currentApplied?.id || null,
        changedPaths: infrastructureChangedPaths,
        categories: infrastructureCategories(infrastructureChangedPaths),
        destructivePaths: destructiveInfrastructurePaths(
          currentApplied?.desiredSpec || {},
          desiredInfrastructureSpec,
          infrastructureChangedPaths,
        ),
        requiresApproval: infrastructureChangedPaths.length > 0,
        reasonCodes: [currentApplied ? "INFRASTRUCTURE_SPEC_CHANGED" : "INITIAL_INFRASTRUCTURE"],
      },
      requiresTerraform: true,
      specHash: desiredInfrastructureSpecHash,
    });
    validateReleaseManifestCreate({
      schemaVersion: 1,
      projectId: input.projectId,
      environmentName: input.environmentName,
      infrastructureManifestId,
      parentManifestId: currentStable?.id || null,
      previousStableManifestId: currentStable?.id || null,
      deploymentContractId: context.contract!.id,
      configurationSnapshotId: null,
      origin: "planner",
      repositoryFullName: desiredReleaseSpec.source.repositoryFullName,
      branch: desiredReleaseSpec.source.branch,
      commitSha: desiredReleaseSpec.source.commitSha,
      appRoot: desiredReleaseSpec.source.appRoot,
      deploymentContractHash: context.contract!.contractHash,
      configurationFingerprint: context.configurationFingerprint,
      buildFingerprint: releaseFingerprints.buildFingerprint,
      runtimeFingerprint: releaseFingerprints.runtimeFingerprint,
      releaseSpec: desiredReleaseSpec,
      specHash: desiredReleaseSpecHash,
    });
  }

  private async findOrCreateReleaseManifest(
    manager: EntityManager,
    intent: DeploymentIntent,
    context: PlannerContext,
    infrastructure: InfrastructureManifest,
    releaseSpec: ReleaseSpecV1,
    specHash: string,
    fingerprints: {
      buildFingerprint: string;
      runtimeFingerprint: string;
      identityFingerprint: string;
    },
    currentStable: ReleaseManifest | null,
    status: "desired" | "blocked_on_infrastructure",
    forceFresh = false,
  ) {
    const repository = manager.getRepository(ReleaseManifest);
    const existing = await repository.findOne({
      where: {
        projectId: intent.projectId,
        environmentName: intent.environmentName,
        infrastructureManifestId: infrastructure.id,
        specHash,
        configurationFingerprint: context.configurationFingerprint,
        buildFingerprint: fingerprints.buildFingerprint,
        runtimeFingerprint: fingerprints.runtimeFingerprint,
      },
      order: { createdAt: "DESC" },
    });
    if (existing && !forceFresh) return existing;
    const contract = context.contract!;
    const revision = await this.nextRevision(manager, "release_manifests", intent.projectId, intent.environmentName);
    const createInput = validateReleaseManifestCreate({
      schemaVersion: 1,
      projectId: intent.projectId,
      environmentName: intent.environmentName,
      infrastructureManifestId: infrastructure.id,
      parentManifestId: currentStable?.id || null,
      previousStableManifestId: currentStable?.id || null,
      deploymentContractId: contract.id,
      configurationSnapshotId: null,
      origin: "planner",
      repositoryFullName: releaseSpec.source.repositoryFullName,
      branch: releaseSpec.source.branch,
      commitSha: releaseSpec.source.commitSha,
      appRoot: releaseSpec.source.appRoot,
      deploymentContractHash: contract.contractHash,
      configurationFingerprint: context.configurationFingerprint,
      buildFingerprint: fingerprints.buildFingerprint,
      runtimeFingerprint: fingerprints.runtimeFingerprint,
      releaseSpec,
      specHash,
    });
    return repository.save(repository.create({
      ...createInput,
      revision,
      parentManifestId: createInput.parentManifestId || null,
      previousStableManifestId: createInput.previousStableManifestId || null,
      createdByIntentId: intent.id,
      pipelineRunId: null,
      deploymentContractId: createInput.deploymentContractId || null,
      configurationSnapshotId: null,
      status,
      imageUri: null,
      imageDigest: null,
      taskDefinitionInputHash: null,
      taskDefinitionArn: null,
      healthEvidence: null,
      failureCode: null,
      failureMessage: null,
      buildStartedAt: null,
      builtAt: null,
      deploymentStartedAt: null,
      healthVerifiedAt: null,
      promotedAt: null,
      supersededAt: null,
      rollbackStartedAt: null,
      rolledBackAt: null,
    }));
  }

  private async findOrCreateInitialReleaseDraft(
    manager: EntityManager,
    intent: DeploymentIntent,
    context: PlannerContext,
    infrastructure: InfrastructureManifest,
    releaseSpec: ReleaseSpecV1,
    specHash: string,
    fingerprints: { buildFingerprint: string; runtimeFingerprint: string; identityFingerprint: string },
    currentStable: ReleaseManifest | null,
  ) {
    const draft = validateReleaseManifestCreate({
      schemaVersion: 1,
      projectId: intent.projectId,
      environmentName: intent.environmentName,
      infrastructureManifestId: infrastructure.id,
      parentManifestId: currentStable?.id || null,
      previousStableManifestId: currentStable?.id || null,
      deploymentContractId: context.contract!.id,
      configurationSnapshotId: null,
      origin: "planner",
      repositoryFullName: releaseSpec.source.repositoryFullName,
      branch: releaseSpec.source.branch,
      commitSha: releaseSpec.source.commitSha,
      appRoot: releaseSpec.source.appRoot,
      deploymentContractHash: context.contract!.contractHash,
      configurationFingerprint: context.configurationFingerprint,
      buildFingerprint: fingerprints.buildFingerprint,
      runtimeFingerprint: fingerprints.runtimeFingerprint,
      releaseSpec,
      specHash,
    });
    const repository = manager.getRepository(InitialReleaseDraft);
    const existing = await repository.findOne({ where: { intentId: intent.id } });
    const draftHash = canonicalSha256(draft);
    if (existing) {
      if (existing.draftHash !== draftHash || existing.infrastructureManifestId !== infrastructure.id
        || existing.infrastructureRevision !== infrastructure.revision) {
        throw new PlannerIdempotencyConflictError();
      }
      return existing;
    }
    return repository.save(repository.create({
      intentId: intent.id,
      projectId: intent.projectId,
      environmentName: intent.environmentName,
      infrastructureManifestId: infrastructure.id,
      infrastructureRevision: infrastructure.revision,
      draftHash,
      releaseDraft: draft,
    }));
  }

  private releaseFingerprints(
    context: PlannerContext,
    releaseSpec: ReleaseSpecV1,
    specHash: string,
  ) {
    const deploymentContractHash = context.contract?.contractHash || null;
    const buildFingerprint = canonicalSha256({
      source: releaseSpec.source,
      build: releaseSpec.build,
      deploymentContractHash,
      buildConfigurationFingerprint: context.buildConfigurationFingerprint,
    });
    const runtimeFingerprint = canonicalSha256({
      runtime: releaseSpec.runtime,
      health: releaseSpec.health,
      configurationFingerprint: context.runtimeConfigurationFingerprint,
    });
    return {
      buildFingerprint,
      runtimeFingerprint,
      identityFingerprint: canonicalSha256({
        specHash,
        deploymentContractHash,
        configurationFingerprint: context.configurationFingerprint,
        buildFingerprint,
        runtimeFingerprint,
      }),
    };
  }

  private async writeOutbox(
    manager: EntityManager,
    intent: DeploymentIntent,
    decision: PlannerDecisionV1,
    context: PlannerContext,
    actorRole: "admin" | "developer",
    now: Date,
  ) {
    const infrastructure = decision.classification === "infrastructure_change";
    const apply = infrastructure && intent.kind === "apply";
    const messageType = infrastructure
      ? apply ? "intent.infrastructure.apply" : "intent.infrastructure.plan"
      : "intent.release.execute";
    const shared = normalV1IsShared(this.config);
    const infrastructureManifest = decision.desiredInfrastructureManifestId
      ? await manager.getRepository(InfrastructureManifest).findOneBy({
        id: decision.desiredInfrastructureManifestId,
      })
      : null;
    const releaseManifest = decision.desiredReleaseManifestId
      ? await manager.getRepository(ReleaseManifest).findOneBy({
        id: decision.desiredReleaseManifestId,
      })
      : null;
    const accountId = this.config.get<string>("TWO_LANE_EXPECTED_AWS_ACCOUNT_ID")
      || this.config.get<string>("TWO_LANE_CANARY_EXPECTED_AWS_ACCOUNT", "");
    const region = this.config.get<string>("AWS_REGION", "");
    if (shared && (!/^[0-9]{12}$/.test(accountId)
      || !/^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/.test(region))) {
      throw new Error("SHARED_WORKER_CLOUD_IDENTITY_INVALID");
    }
    const workspaceId = `workspace:${context.project.ownerUserId}`;
    const authorization = shared ? {
      actorUserId: intent.requestedByUserId!,
      actorRole,
      projectOwnerUserId: context.project.ownerUserId,
      policySnapshotSha256: canonicalSha256({
        workspaceId,
        projectId: intent.projectId,
        environmentName: intent.environmentName,
        actorUserId: intent.requestedByUserId,
        actorRole,
        projectOwnerUserId: context.project.ownerUserId,
      }),
    } : undefined;
    const envelope = {
      protocol: {
        name: "deployguard.worker",
        schemaVersion: 1,
        messageType,
        minimumWorkerProtocol: 1,
        maximumWorkerProtocol: 1,
      },
      producer: {
        service: "deployguard-api",
        serviceVersion: this.config.get<string>("DEPLOYGUARD_VERSION", "local"),
        gitSha: this.config.get<string>("GIT_SHA", "unknown"),
        producedAt: now.toISOString(),
      },
      identity: {
        ...(shared ? { workspaceId } : {}),
        intentId: intent.id,
        projectId: intent.projectId,
        environmentName: intent.environmentName,
        pipelineRunId: null,
        destroyOperationId: null,
        infrastructureManifestId: decision.desiredInfrastructureManifestId,
        releaseManifestId: decision.desiredReleaseManifestId,
      },
      ...(authorization ? { authorization } : {}),
      ...(shared ? {
        expectations: {
          sourceCommitSha: context.contract!.commitSha!,
          deploymentContractHash: context.contract!.contractHash,
          infrastructureRevision: infrastructureManifest
            ? String(infrastructureManifest.revision) : null,
          releaseRevision: releaseManifest ? String(releaseManifest.revision) : null,
          awsAccountId: accountId,
          awsRegion: region,
          resourceNamespace: `dg-${intent.projectId.replace(/-/g, "").slice(0, 12)}-dev`,
        },
      } : {}),
      routing: {
        lane: infrastructure ? "infrastructure" : "release",
        operation: infrastructure ? apply ? "apply" : "plan" : "execute",
        queue: infrastructure ? "deployguard-infrastructure-v1" : "deployguard-release-v1",
      },
      idempotency: {
        canonicalKey: intent.canonicalIdempotencyKey,
        payloadSha256: "0".repeat(64),
        attempt: 1,
        replayOfJobId: null,
      },
      execution: {
        mode: intent.kind === "resume" ? "resume" : "full",
        resumeFromStage: null,
        reusableCheckpointIds: [],
        invalidatedCheckpointIds: [],
        reasonCodes: decision.reasonCodes,
        fencingTokenRequired: true,
      },
      trace: {
        correlationId: intent.id,
        causationId: intent.sourcePipelineRunId,
        actorUserId: intent.requestedByUserId,
      },
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    } as DeployGuardWorkerEnvelopeV1;
    envelope.idempotency.payloadSha256 = canonicalSha256(workerEnvelopePayloadForHash(envelope));
    const validated = validateWorkerEnvelopeV1(envelope, new Date(now.getTime() - 1));
    const outbox = manager.getRepository(OrchestrationOutbox);
    const existing = await outbox.findOne({
      where: {
        intentId: intent.id,
        eventType: messageType,
        payloadSha256: validated.idempotency.payloadSha256,
      },
    });
    if (existing) return existing;
    return outbox.save(outbox.create({
      intentId: intent.id,
      aggregateType: "deployment_intent",
      aggregateId: intent.id,
      eventType: messageType,
      workerEnvelope: validated,
      payloadSha256: validated.idempotency.payloadSha256,
      status: "pending",
      attemptCount: 0,
      availableAt: now,
      claimedBy: null,
      claimExpiresAt: null,
      publishedJobId: null,
      lastError: null,
      publishedAt: null,
    }));
  }

  private async nextRevision(
    manager: EntityManager,
    table: "infrastructure_manifests" | "release_manifests",
    projectId: string,
    environmentName: string,
  ) {
    const [row] = await manager.query(
      `SELECT COALESCE(MAX(revision), 0)::bigint + 1 AS revision
       FROM "${table}" WHERE project_id = $1 AND environment_name = $2`,
      [projectId, environmentName],
    );
    return String(row.revision);
  }

  private validateInput(input: TransactionalDeploymentPlannerInputV1) {
    if (!UUID.test(input.projectId)) throw new Error("projectId must be a UUID.");
    if (!ENVIRONMENT.test(input.environmentName)) throw new Error("environmentName is invalid.");
    if (!DEPLOYMENT_INTENT_KINDS.includes(input.kind)) throw new Error("kind is invalid.");
    if (!Number.isInteger(input.actor?.userId) || input.actor.userId < 1) throw new Error("actor.userId is invalid.");
    if (!["admin", "developer", "readonly"].includes(input.actor.role)) throw new Error("actor.role is invalid.");
    if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 255) {
      throw new Error("idempotencyKey is invalid.");
    }
    if (input.requestedCommitSha && !COMMIT_SHA.test(input.requestedCommitSha)) throw new Error("requestedCommitSha is invalid.");
    if (input.initialReleaseInfrastructureManifestId && !UUID.test(input.initialReleaseInfrastructureManifestId)) {
      throw new Error("initialReleaseInfrastructureManifestId must be a UUID.");
    }
    if (input.initialReleaseDraftId && !UUID.test(input.initialReleaseDraftId)) {
      throw new Error("initialReleaseDraftId must be a UUID.");
    }
    if (input.initialReleaseDraftId && input.initialReleaseInfrastructureManifestId) {
      throw new Error("initial release draft and foundation pins are mutually exclusive.");
    }
    if (input.sourcePipelineRunId && !UUID.test(input.sourcePipelineRunId)) throw new Error("sourcePipelineRunId is invalid.");
    if (input.recoveryCode && input.recoveryCode.length > 128) throw new Error("recoveryCode is invalid.");
    if (input.preMutationRecovery) {
      if (!UUID.test(input.preMutationRecovery.failedIntentId)
        || !/^[0-9a-f]{64}$/.test(input.preMutationRecovery.evidenceHash)
        || input.kind !== "deploy"
        || input.requiredClassification !== "release_only") {
        throw new Error("preMutationRecovery is invalid.");
      }
    }
  }

  /**
   * Only a terminal failure that never reached an external release mutation can
   * be replaced.  Cloud absence is checked by the caller's read-only adapter;
   * this transaction binds that evidence hash to the durable, fenced history.
   */
  private async assertPreMutationRecovery(
    manager: EntityManager,
    input: TransactionalDeploymentPlannerInputV1,
    currentApplied: InfrastructureManifest | null,
    currentStable: ReleaseManifest | null,
  ) {
    const recovery = input.preMutationRecovery!;
    const rows = await manager.query(
      `SELECT failed.id
       FROM deployment_intents failed
       JOIN release_manifests candidate ON candidate.id = failed.release_manifest_id
       JOIN infrastructure_manifests infrastructure ON infrastructure.id = failed.infrastructure_manifest_id
       JOIN orchestration_outbox outbox ON outbox.intent_id = failed.id
       WHERE failed.id = $1
         AND failed.project_id = $2 AND failed.environment_name = $3
         AND failed.kind = 'deploy' AND failed.classification = 'release_only'
         AND failed.status = 'failed'
         AND failed.failure_code = 'INVOCATION_PREPARATION_FAILED'
         AND candidate.status = 'desired'
         AND candidate.commit_sha = $4
         AND candidate.image_digest IS NULL
         AND candidate.task_definition_arn IS NULL
         AND candidate.initial_service_arn IS NULL
         AND candidate.previous_stable_manifest_id IS NOT DISTINCT FROM $5
         AND infrastructure.id = $6 AND infrastructure.status = 'applied'
         AND outbox.status = 'published' AND outbox.attempt_count = 1
         AND outbox.published_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM release_image_provenances provenance
           WHERE provenance.intent_id = failed.id
         )
         AND 1 = (
           SELECT count(*) FROM deployment_side_effects effect
           WHERE effect.intent_id = failed.id
             AND effect.effect_type = 'ecr.build_push_immutable_image'
             AND (
               (effect.status = 'uncertain' AND effect.reconciliation_required = true
                 AND effect.failure_code = 'SIDE_EFFECT_OUTCOME_UNKNOWN')
               OR (effect.status = 'failed' AND effect.reconciliation_required = false
                 AND effect.failure_code IN (
                   'FIRST_RELEASE_BUILD_CONTRACT_INVALID',
                   'FIRST_RELEASE_DOCKERFILE_CONTEXT_UNAVAILABLE',
                   'FIRST_RELEASE_DOCKERFILE_UNAVAILABLE',
                   'FIRST_RELEASE_SOURCE_PIN_MISMATCH',
                   'FIRST_RELEASE_APP_ROOT_INVALID',
                   'FIRST_RELEASE_DOCKER_BUILD_FAILED',
                   'FIRST_RELEASE_ECR_LOGIN_FAILED',
                   'FIRST_RELEASE_DOCKER_TAG_FAILED'
                 ))
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM deployment_side_effects effect
           WHERE effect.intent_id = failed.id
             AND effect.effect_type <> 'ecr.build_push_immutable_image'
         )
         AND NOT EXISTS (
           SELECT 1 FROM project_operation_leases lease
           WHERE lease.intent_id = failed.id
             AND lease.status IN ('acquired','heartbeat_active')
             AND lease.expires_at > clock_timestamp()
         )
         AND NOT EXISTS (
           SELECT 1 FROM project_release_lane_ownerships ownership
           WHERE ownership.project_id = failed.project_id
             AND ownership.environment_name = failed.environment_name
             AND ownership.status IN ('acquired','heartbeat_active')
             AND ownership.expires_at > clock_timestamp()
         )
       FOR UPDATE OF failed, candidate, infrastructure, outbox`,
      [
        recovery.failedIntentId,
        input.projectId,
        input.environmentName,
        input.requestedCommitSha,
        currentStable?.id || null,
        currentApplied?.id || null,
      ],
    ) as Array<{ id: string }>;
    if (rows.length !== 1) {
      throw new Error("PRE_MUTATION_RECOVERY_NOT_ELIGIBLE");
    }
  }

  private initialReleaseFoundation(
    input: TransactionalDeploymentPlannerInputV1,
    currentApplied: InfrastructureManifest | null,
    currentStable: ReleaseManifest | null,
  ): InfrastructureManifest | null {
    if (!input.initialReleaseInfrastructureManifestId) return null;
    if (
      input.kind !== "deploy"
      || currentStable !== null
      || !currentApplied
      || currentApplied.id !== input.initialReleaseInfrastructureManifestId
      || currentApplied.status !== "applied"
      || currentApplied.projectId !== input.projectId
      || currentApplied.environmentName !== input.environmentName
    ) {
      throw new Error("INITIAL_RELEASE_FOUNDATION_PIN_INVALID");
    }
    return currentApplied;
  }

  /**
   * The normal first-release bridge never reconstructs a draft.  It can only
   * consume the immutable draft that the infrastructure lane already created.
   */
  private async existingInitialReleaseDraft(
    manager: EntityManager,
    input: TransactionalDeploymentPlannerInputV1,
    currentApplied: InfrastructureManifest | null,
    currentStable: ReleaseManifest | null,
  ): Promise<InitialReleaseDraft | null> {
    if (!input.initialReleaseDraftId) return null;
    if (input.kind !== "deploy" || currentStable || !currentApplied || currentApplied.status !== "applied") {
      throw new Error("INITIAL_RELEASE_DRAFT_FOUNDATION_INVALID");
    }
    const draft = await manager.getRepository(InitialReleaseDraft).findOne({
      where: { id: input.initialReleaseDraftId, projectId: input.projectId, environmentName: input.environmentName },
    });
    const release = draft?.releaseDraft as import("../contracts/release-manifest.types").CreateReleaseManifestInputV1 | undefined;
    if (!draft || draft.infrastructureManifestId !== currentApplied.id
      || draft.infrastructureRevision !== currentApplied.revision
      || !release || release.infrastructureManifestId !== currentApplied.id
      || release.projectId !== input.projectId || release.environmentName !== input.environmentName
      || release.commitSha !== input.requestedCommitSha
      || canonicalSha256(release) !== draft.draftHash) {
      throw new Error("INITIAL_RELEASE_DRAFT_IDENTITY_INVALID");
    }
    return draft;
  }

  /**
   * A pinned source-only deployment must not reconstruct a foundation from
   * ambient defaults. The applied manifest is the authoritative foundation;
   * explicit infrastructure requests still use the normal infrastructure
   * planner path.
   */
  private laterReleaseFoundation(
    input: TransactionalDeploymentPlannerInputV1,
    currentApplied: InfrastructureManifest | null,
    currentStable: ReleaseManifest | null,
  ): InfrastructureManifest | null {
    if (!input.requestedCommitSha || !currentApplied || !currentStable) return null;
    if (
      input.kind !== "deploy"
      || currentApplied.status !== "applied"
      || currentApplied.projectId !== input.projectId
      || currentApplied.environmentName !== input.environmentName
      || currentStable.projectId !== input.projectId
      || currentStable.environmentName !== input.environmentName
      || currentStable.infrastructureManifestId !== currentApplied.id
      || input.requestedCommitSha === currentStable.commitSha
    ) return null;
    return currentApplied;
  }

  private stateBackend(): "local_mock" | "s3" {
    return this.config.get<string>("STATE_MOCK_MODE", "false") === "true"
      ? "local_mock"
      : "s3";
  }

  /**
   * Remote v1 revisions never share a mutable state object. The mock backend
   * retains its existing fixture key because it is not a remote-state scope.
   */
  private stateKey(projectId: string, environmentName: string, revision: string): string {
    const prefix = this.config.get<string>("TERRAFORM_STATE_PREFIX", "projects");
    return this.stateBackend() === "s3"
      ? `${prefix}/${projectId}/${environmentName}/v1/${revision}.tfstate`
      : `${prefix}/${projectId}/terraform.tfstate`;
  }

  private sanitizeIntent(intent: DeploymentIntent): SanitizedDeploymentIntentV1 {
    return {
      id: intent.id,
      schemaVersion: 1,
      projectId: intent.projectId,
      environmentName: intent.environmentName,
      requestedByUserId: intent.requestedByUserId,
      kind: intent.kind,
      classification: intent.classification,
      status: intent.status,
      requestFingerprint: intent.requestFingerprint,
      infrastructureManifestId: intent.infrastructureManifestId,
      releaseManifestId: intent.releaseManifestId,
      sourcePipelineRunId: intent.sourcePipelineRunId,
      pipelineRunId: intent.pipelineRunId,
      receivedAt: intent.receivedAt.toISOString(),
      plannedAt: intent.plannedAt?.toISOString() || null,
    };
  }
}
