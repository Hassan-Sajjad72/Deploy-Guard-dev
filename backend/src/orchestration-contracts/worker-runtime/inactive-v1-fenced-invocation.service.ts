import { Inject, Injectable, Optional } from "@nestjs/common";
import { DataSource } from "typeorm";
import {
  validateInfrastructureManifestCreate,
  validateReleaseManifestCreate,
} from "../contracts/manifest.validator";
import { validateWorkerEnvelopeV1 } from "../contracts/worker-envelope.validator";
import {
  ExecutableV1MessageType,
  V1WorkerIntentSnapshot,
} from "./inactive-v1-worker-runtime.types";
import { InactiveV1ExecutionLeaseHeartbeatService } from "./inactive-v1-execution-lease-heartbeat.service";
import { InactiveV1HandlerSideEffectSafetyService } from "./inactive-v1-handler-side-effect-safety.service";
import { InactiveV1PreExecutionOwnershipService } from "./inactive-v1-pre-execution-ownership.service";
import {
  V1_FENCED_PLACEHOLDER_HANDLER_REGISTRY,
  V1FencedInvocationError,
  V1FencedInvocationResult,
  V1FencedPlaceholderOutcome,
  V1FencedPlaceholderHandler,
  V1FencedPlaceholderHandlerContext,
  V1InfrastructureManifestSnapshot,
  V1ReleaseManifestSnapshot,
} from "./v1-fenced-invocation.types";
import { assertSafeOwnershipFailureCode } from "./v1-pre-execution-ownership.pure";
import { PreExecutionLeaseSnapshot } from "./v1-pre-execution-ownership.types";
import {
  V1ExecutionLeaseHeartbeatDisposition,
} from "./v1-execution-lease-heartbeat.types";
import {
  CrossLaneOwnershipClaim,
  CrossLaneOwnershipEnforcementService,
} from "../release-lane/cross-lane-ownership-enforcement.service";
import {
  InfrastructurePlanCompletionContinuationError,
  InfrastructurePlanCompletionContinuationService,
} from "../infrastructure/infrastructure-plan-completion-continuation.service";

type InvocationContextRow = {
  leaseId: string;
  ownerWorkerId: string;
  fencingToken: string;
  intentId: string;
  projectId: string;
  environmentName: string;
  classification: V1WorkerIntentSnapshot["classification"];
  intentStatus: "running";
  canonicalIdempotencyKey: string;
  requestFingerprint: string;
  infrastructureManifestId: string | null;
  releaseManifestId: string | null;
  pipelineRunId: string | null;
  destroyOperationId: string | null;
  infrastructureManifest: V1InfrastructureManifestSnapshot | null;
  releaseManifest: V1ReleaseManifestSnapshot | null;
};

type LoadedInvocationContext = Omit<
  V1FencedPlaceholderHandlerContext,
  "execution" | "sideEffects"
>;

const HANDLER_THROWN_FAILURE_CODE = "PLACEHOLDER_HANDLER_THROWN";
const HANDLER_INVALID_OUTCOME_FAILURE_CODE =
  "PLACEHOLDER_HANDLER_INVALID_OUTCOME";

@Injectable()
export class InactiveV1FencedInvocationService {
  private readonly leaseHeartbeat: InactiveV1ExecutionLeaseHeartbeatService;
  private readonly sideEffectSafety: InactiveV1HandlerSideEffectSafetyService;

  constructor(
    private readonly dataSource: DataSource,
    private readonly ownership: InactiveV1PreExecutionOwnershipService,
    @Inject(V1_FENCED_PLACEHOLDER_HANDLER_REGISTRY)
    private readonly handlers: ReadonlyMap<
      ExecutableV1MessageType,
      V1FencedPlaceholderHandler
    >,
    @Optional()
    leaseHeartbeat?: InactiveV1ExecutionLeaseHeartbeatService,
    @Optional()
    sideEffectSafety?: InactiveV1HandlerSideEffectSafetyService,
    @Optional()
    private readonly crossLane?: CrossLaneOwnershipEnforcementService,
    @Optional()
    private readonly infrastructurePlanContinuation?:
      InfrastructurePlanCompletionContinuationService,
  ) {
    this.leaseHeartbeat = leaseHeartbeat
      ?? new InactiveV1ExecutionLeaseHeartbeatService(ownership);
    this.sideEffectSafety = sideEffectSafety
      ?? new InactiveV1HandlerSideEffectSafetyService(dataSource);
  }

  async invoke(input: {
    workerId: string;
    queueName: string;
    envelope: unknown;
    leaseTtlMs?: number;
    leaseHeartbeatIntervalMs?: number;
    abortSignal?: AbortSignal;
    crossLaneClaim?: CrossLaneOwnershipClaim;
    isCrossLaneTrusted?: () => boolean;
    /** Explicit one-shot preparation only; it runs after both fences are held. */
    beforeHandler?: (
      context: V1FencedPlaceholderHandlerContext,
    ) => Promise<void>;
  }): Promise<V1FencedInvocationResult> {
    const envelope = this.validatedEnvelope(this.snapshotEnvelope(
      input.envelope,
    ));
    const ownership = await this.ownership.claim({
      ...input,
      envelope,
    });
    if (ownership.disposition === "idempotent_no_op") {
      return ownership;
    }

    const messageType =
      envelope.protocol.messageType as ExecutableV1MessageType;
    if (ownership.disposition === "already_owned") {
      return this.noOp(
        input.workerId,
        ownership.lease.intentId,
        ownership.lease.projectId,
        messageType,
        "duplicate_delivery_already_owned",
      );
    }
    try {
      await this.crossLane?.attachV1OperationLease(
        input.crossLaneClaim ?? { enabled: false },
        {
          intentId: ownership.lease.intentId,
          operationLeaseId: ownership.lease.leaseId,
          operationWorkerId: ownership.lease.ownerWorkerId,
          operationFencingToken: ownership.lease.fencingToken,
        },
      );
    } catch (error) {
      await this.ownership.release({
        leaseId: ownership.lease.leaseId,
        workerId: ownership.lease.ownerWorkerId,
        fencingToken: ownership.lease.fencingToken,
      });
      throw error;
    }

    let context: LoadedInvocationContext | null;
    try {
      context = await this.loadContext(
        ownership.lease,
        ownership.logicalJobId,
        envelope,
      );
    } catch (error) {
      if (
        error instanceof V1FencedInvocationError
        && error.code === "INVOCATION_MANIFEST_INVALID"
      ) {
        return this.finalizeClaimFailure(
          ownership.lease,
          messageType,
          "INVOCATION_MANIFEST_INVALID",
        );
      }
      throw error;
    }
    if (!context) {
      return this.noOp(
        input.workerId,
        ownership.lease.intentId,
        ownership.lease.projectId,
        messageType,
        "ownership_lost",
      );
    }

    const handler = this.handlers.get(messageType);
    if (!handler || handler.messageType !== messageType) {
      return this.finalizeClaimFailure(
        ownership.lease,
        messageType,
        "INVOCATION_HANDLER_UNAVAILABLE",
      );
    }

    const heartbeat = this.leaseHeartbeat.start({
      ...this.fence(context),
      leaseTtlMs: input.leaseTtlMs ?? 60_000,
      intervalMs: input.leaseHeartbeatIntervalMs,
      abortSignal: input.abortSignal,
    });
    const handlerContext: V1FencedPlaceholderHandlerContext = Object.freeze({
      ...context,
      execution: Object.freeze({
        signal: heartbeat.signal,
        isLeaseTrusted: () =>
          heartbeat.isTrusted()
          && (input.isCrossLaneTrusted?.() ?? true),
      }),
      sideEffects: this.sideEffectSafety.forExecution({
        intentId: context.intent.id,
        projectId: context.intent.projectId,
        environmentName: context.intent.environmentName,
        leaseId: context.leaseId,
        workerId: context.workerId,
        fencingToken: context.fencingToken,
        signal: heartbeat.signal,
        isLeaseTrusted: () =>
          heartbeat.isTrusted()
          && (input.isCrossLaneTrusted?.() ?? true),
      }),
    });
    if (!heartbeat.isTrusted()) {
      const disposition = await heartbeat.stop();
      return this.finalizeHeartbeatDisposition(
        handlerContext,
        messageType,
        disposition,
      );
    }

    try {
      await input.beforeHandler?.(handlerContext);
    } catch {
      const heartbeatDisposition = await heartbeat.stop();
      if (heartbeatDisposition !== "stopped") {
        return this.finalizeHeartbeatDisposition(
          handlerContext,
          messageType,
          heartbeatDisposition,
        );
      }
      return this.finalizeFailure(
        handlerContext,
        messageType,
        "INVOCATION_PREPARATION_FAILED",
      );
    }

    let outcome;
    let handlerFailureCode: string | null = null;
    try {
      outcome = await handler.invoke(handlerContext);
      this.assertHandlerOutcome(outcome);
    } catch {
      handlerFailureCode = HANDLER_THROWN_FAILURE_CODE;
    }
    const heartbeatDisposition = await heartbeat.stop();
    if (heartbeatDisposition !== "stopped") {
      return this.finalizeHeartbeatDisposition(
        handlerContext,
        messageType,
        heartbeatDisposition,
      );
    }
    if (handlerFailureCode) {
      return this.finalizeFailure(
        handlerContext,
        messageType,
        handlerFailureCode,
      );
    }
    if (outcome.outcome === "plan_completed") {
      return this.finalizeInfrastructurePlanCompletion(
        handlerContext,
        input.crossLaneClaim,
        outcome,
      );
    }
    if (outcome.outcome === "success") {
      const sideEffectFinalization =
        handlerContext.sideEffects.finalizationStatus();
      if (!sideEffectFinalization.allowed) {
        return this.finalizeFailure(
          handlerContext,
          messageType,
          sideEffectFinalization.safeFailureCode,
        );
      }
      const completed = await this.ownership.complete(
        this.fence(handlerContext),
      );
      return completed
        ? this.terminalResult("completed", handlerContext, messageType)
        : this.ownershipLost(handlerContext, messageType);
    }
    if (outcome.outcome === "retryable") {
      const released = await this.ownership.release(
        this.fence(handlerContext),
      );
      return released
        ? {
            ...this.terminalResult("released", handlerContext, messageType),
            reason: "handler_retryable",
          }
        : this.ownershipLost(handlerContext, messageType);
    }
    if (outcome.outcome === "apply_reconciliation_required") {
      if (messageType !== "intent.infrastructure.apply") {
        return this.finalizeFailure(handlerContext, messageType, "INVOCATION_HANDLER_OUTCOME_INVALID");
      }
      const released = await this.ownership.release(this.fence(handlerContext));
      return released
        ? { ...this.terminalResult("released", handlerContext, messageType), reason: "apply_reconciliation_required" }
        : this.ownershipLost(handlerContext, messageType);
    }
    const sideEffectFinalization = handlerContext.sideEffects.finalizationStatus();
    if (!sideEffectFinalization.allowed) {
      return this.finalizeFailure(handlerContext, messageType, sideEffectFinalization.safeFailureCode);
    }
    return this.finalizeFailure(
      handlerContext,
      messageType,
      outcome.safeFailureCode,
    );
  }

  private async loadContext(
    lease: PreExecutionLeaseSnapshot,
    logicalJobId: string,
    envelope: ReturnType<typeof validateWorkerEnvelopeV1>,
  ): Promise<LoadedInvocationContext | null> {
    const rows = this.rows<InvocationContextRow>(await this.dataSource.query(
      `SELECT
         lease.id AS "leaseId",
         lease.owner_worker_id AS "ownerWorkerId",
         lease.fencing_token AS "fencingToken",
         intent.id AS "intentId",
         intent.project_id AS "projectId",
         intent.environment_name AS "environmentName",
         intent.classification,
         intent.status AS "intentStatus",
         intent.canonical_idempotency_key AS "canonicalIdempotencyKey",
         intent.request_fingerprint AS "requestFingerprint",
         intent.infrastructure_manifest_id AS "infrastructureManifestId",
         intent.release_manifest_id AS "releaseManifestId",
         intent.pipeline_run_id AS "pipelineRunId",
         intent.destroy_operation_id AS "destroyOperationId",
         CASE WHEN infrastructure.id IS NULL THEN NULL ELSE jsonb_build_object(
           'id', infrastructure.id,
           'schemaVersion', infrastructure.schema_version,
           'projectId', infrastructure.project_id,
           'environmentName', infrastructure.environment_name,
           'revision', infrastructure.revision::text,
           'parentManifestId', infrastructure.parent_manifest_id,
           'createdByIntentId', infrastructure.created_by_intent_id,
           'createdByUserId', infrastructure.created_by_user_id,
           'origin', infrastructure.origin,
           'status', infrastructure.status,
           'specHash', infrastructure.spec_hash,
           'terraformTemplateVersion',
             infrastructure.terraform_template_version,
           'stateBackend', infrastructure.state_backend,
           'stateKey', infrastructure.state_key,
           'desiredSpec', infrastructure.desired_spec,
           'changeSet', infrastructure.change_set,
           'requiresTerraform', infrastructure.requires_terraform
         ) END AS "infrastructureManifest",
         CASE WHEN release.id IS NULL THEN NULL ELSE jsonb_build_object(
           'id', release.id,
           'schemaVersion', release.schema_version,
           'projectId', release.project_id,
           'environmentName', release.environment_name,
           'revision', release.revision::text,
           'parentManifestId', release.parent_manifest_id,
           'previousStableManifestId', release.previous_stable_manifest_id,
           'infrastructureManifestId',
             release.infrastructure_manifest_id,
           'createdByIntentId', release.created_by_intent_id,
           'pipelineRunId', release.pipeline_run_id,
           'deploymentContractId', release.deployment_contract_id,
           'configurationSnapshotId', release.configuration_snapshot_id,
           'origin', release.origin,
           'status', release.status,
           'specHash', release.spec_hash,
           'repositoryFullName', release.repository_full_name,
           'branch', release.branch,
           'commitSha', release.commit_sha,
           'appRoot', release.app_root,
           'deploymentContractHash', release.deployment_contract_hash,
           'configurationFingerprint', release.configuration_fingerprint,
           'buildFingerprint', release.build_fingerprint,
           'runtimeFingerprint', release.runtime_fingerprint,
           'releaseSpec', release.release_spec
         ) END AS "releaseManifest"
       FROM project_operation_leases lease
       INNER JOIN deployment_intents intent ON intent.id = lease.intent_id
       LEFT JOIN infrastructure_manifests infrastructure
         ON infrastructure.id = intent.infrastructure_manifest_id
       LEFT JOIN release_manifests release
         ON release.id = intent.release_manifest_id
       WHERE lease.id = $1
         AND lease.owner_worker_id = $2
         AND lease.fencing_token = $3::bigint
         AND lease.intent_id = $4
         AND lease.project_id = $5
         AND lease.environment_name = $6
         AND lease.status IN ('acquired','heartbeat_active')
         AND lease.expires_at > clock_timestamp()
         AND lease.metadata->>'logicalJobId' = $7
         AND intent.status = 'running'
       LIMIT 1`,
      [
        lease.leaseId,
        lease.ownerWorkerId,
        lease.fencingToken,
        lease.intentId,
        lease.projectId,
        lease.environmentName,
        logicalJobId,
      ],
    ));
    const row = rows[0];
    if (!row) return null;
    if (!this.identityMatches(row, envelope)) {
      throw new V1FencedInvocationError("INVOCATION_MANIFEST_INVALID");
    }

    this.validateManifests(row);
    const intent: V1WorkerIntentSnapshot & { status: "running" } = {
      id: row.intentId,
      projectId: row.projectId,
      environmentName: row.environmentName,
      classification: row.classification,
      status: "running",
      canonicalIdempotencyKey: row.canonicalIdempotencyKey,
      requestFingerprint: row.requestFingerprint,
      infrastructureManifestId: row.infrastructureManifestId,
      releaseManifestId: row.releaseManifestId,
      pipelineRunId: row.pipelineRunId,
      destroyOperationId: row.destroyOperationId,
    };
    return Object.freeze({
      leaseId: lease.leaseId,
      workerId: lease.ownerWorkerId,
      fencingToken: lease.fencingToken,
      logicalJobId,
      lease: Object.freeze({ ...lease }),
      intent: Object.freeze(intent),
      infrastructureManifest: row.infrastructureManifest
        ? this.deepFreeze(row.infrastructureManifest)
        : null,
      releaseManifest: row.releaseManifest
        ? this.deepFreeze(row.releaseManifest)
        : null,
      route: Object.freeze({
        messageType:
          envelope.protocol.messageType as ExecutableV1MessageType,
        queueName: envelope.routing.queue,
        lane: envelope.routing.lane,
        operation: envelope.routing.operation,
      }),
      envelope: envelope as LoadedInvocationContext["envelope"],
    });
  }

  private async finalizeHeartbeatDisposition(
    context: V1FencedPlaceholderHandlerContext,
    messageType: ExecutableV1MessageType,
    disposition: V1ExecutionLeaseHeartbeatDisposition,
  ): Promise<V1FencedInvocationResult> {
    if (disposition === "ownership_lost") {
      return this.ownershipLost(context, messageType);
    }
    if (disposition === "cancelled") {
      const released = await this.ownership.release(this.fence(context));
      return released
        ? {
            ...this.terminalResult("released", context, messageType),
            reason: "execution_cancelled",
          }
        : this.ownershipLost(context, messageType);
    }
    if (disposition === "heartbeat_failed") {
      return this.finalizeFailure(
        context,
        messageType,
        "EXECUTION_HEARTBEAT_FAILED",
      );
    }
    throw new V1FencedInvocationError("INVOCATION_CONTEXT_UNAVAILABLE");
  }

  private validateManifests(row: InvocationContextRow) {
    try {
      if (row.infrastructureManifest) {
        const manifest = row.infrastructureManifest;
        validateInfrastructureManifestCreate({
          schemaVersion: manifest.schemaVersion,
          projectId: manifest.projectId,
          environmentName: manifest.environmentName,
          parentManifestId: manifest.parentManifestId,
          createdByUserId: manifest.createdByUserId,
          origin: manifest.origin,
          terraformTemplateVersion: manifest.terraformTemplateVersion,
          stateBackend: manifest.stateBackend,
          stateKey: manifest.stateKey,
          desiredSpec: manifest.desiredSpec,
          changeSet: manifest.changeSet,
          requiresTerraform: manifest.requiresTerraform,
          specHash: manifest.specHash,
        });
      }
      if (row.releaseManifest) {
        const manifest = row.releaseManifest;
        validateReleaseManifestCreate({
          schemaVersion: manifest.schemaVersion,
          projectId: manifest.projectId,
          environmentName: manifest.environmentName,
          infrastructureManifestId: manifest.infrastructureManifestId,
          parentManifestId: manifest.parentManifestId,
          previousStableManifestId: manifest.previousStableManifestId,
          deploymentContractId: manifest.deploymentContractId,
          configurationSnapshotId: manifest.configurationSnapshotId,
          origin: manifest.origin,
          repositoryFullName: manifest.repositoryFullName,
          branch: manifest.branch,
          commitSha: manifest.commitSha,
          appRoot: manifest.appRoot,
          deploymentContractHash: manifest.deploymentContractHash,
          configurationFingerprint: manifest.configurationFingerprint,
          buildFingerprint: manifest.buildFingerprint,
          runtimeFingerprint: manifest.runtimeFingerprint,
          releaseSpec: manifest.releaseSpec,
          specHash: manifest.specHash,
        });
      }
    } catch {
      throw new V1FencedInvocationError("INVOCATION_MANIFEST_INVALID");
    }
  }

  private identityMatches(
    row: InvocationContextRow,
    envelope: ReturnType<typeof validateWorkerEnvelopeV1>,
  ) {
    const infrastructureRequired =
      envelope.protocol.messageType !== "intent.deletion.execute";
    const releaseRequired =
      envelope.protocol.messageType === "intent.release.execute";
    return row.projectId === envelope.identity.projectId
      && row.environmentName === envelope.identity.environmentName
      && row.pipelineRunId === envelope.identity.pipelineRunId
      && row.destroyOperationId === envelope.identity.destroyOperationId
      && row.infrastructureManifestId
        === envelope.identity.infrastructureManifestId
      && row.releaseManifestId === envelope.identity.releaseManifestId
      && row.canonicalIdempotencyKey
        === envelope.idempotency.canonicalKey
      && (!infrastructureRequired || !!row.infrastructureManifest)
      && (!releaseRequired || !!row.releaseManifest)
      && (
        !row.infrastructureManifest
        || (
          row.infrastructureManifest.projectId === row.projectId
          && row.infrastructureManifest.environmentName
            === row.environmentName
        )
      )
      && (
        !row.releaseManifest
        || (
          row.releaseManifest.projectId === row.projectId
          && row.releaseManifest.environmentName === row.environmentName
        )
      )
      && (
        !row.releaseManifest
        || row.releaseManifest.infrastructureManifestId
          === row.infrastructureManifestId
      );
  }

  private validatedEnvelope(value: unknown) {
    try {
      return validateWorkerEnvelopeV1(value);
    } catch {
      throw new V1FencedInvocationError("INVOCATION_CONTEXT_UNAVAILABLE");
    }
  }

  private snapshotEnvelope(value: unknown) {
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        throw new Error("Envelope is not serializable.");
      }
      return JSON.parse(serialized) as unknown;
    } catch {
      throw new V1FencedInvocationError("INVOCATION_CONTEXT_UNAVAILABLE");
    }
  }

  private deepFreeze<T>(value: T): T {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) {
      return value;
    }
    for (const item of Object.values(value as Record<string, unknown>)) {
      this.deepFreeze(item);
    }
    return Object.freeze(value);
  }

  private assertHandlerOutcome(
    value: unknown,
  ): asserts value is
    | { outcome: "success" }
    | { outcome: "retryable" }
    | { outcome: "apply_reconciliation_required" }
    | { outcome: "terminal_failure"; safeFailureCode: string }
    | {
      outcome: "plan_completed";
      initialReleaseDraftId: string;
      planOutboxId: string;
      planArtifactSha256: string;
      planInputFingerprint: string;
    } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new V1FencedInvocationError(
        "INVOCATION_HANDLER_OUTCOME_INVALID",
      );
    }
    const outcome = (value as { outcome?: unknown }).outcome;
    if (outcome === "success" || outcome === "retryable" || outcome === "apply_reconciliation_required") return;
    if (outcome === "plan_completed") {
      const candidate = value as {
        initialReleaseDraftId?: unknown;
        planOutboxId?: unknown;
        planArtifactSha256?: unknown;
        planInputFingerprint?: unknown;
      };
      if (
        typeof candidate.initialReleaseDraftId !== "string"
        || typeof candidate.planOutboxId !== "string"
        || !/^[0-9a-f]{64}$/.test(candidate.planArtifactSha256 as string)
        || !/^[0-9a-f]{64}$/.test(candidate.planInputFingerprint as string)
      ) {
        throw new V1FencedInvocationError(
          "INVOCATION_HANDLER_OUTCOME_INVALID",
        );
      }
      return;
    }
    if (outcome === "terminal_failure") {
      assertSafeOwnershipFailureCode(
        (value as { safeFailureCode: string }).safeFailureCode,
      );
      return;
    }
    throw new V1FencedInvocationError(
      "INVOCATION_HANDLER_OUTCOME_INVALID",
    );
  }

  private async finalizeFailure(
    context: V1FencedPlaceholderHandlerContext,
    messageType: ExecutableV1MessageType,
    failureCode: string,
  ): Promise<V1FencedInvocationResult> {
    let safeFailureCode: string;
    try {
      safeFailureCode = assertSafeOwnershipFailureCode(failureCode);
    } catch {
      safeFailureCode = HANDLER_INVALID_OUTCOME_FAILURE_CODE;
    }
    const failed = await this.ownership.fail({
      ...this.fence(context),
      safeFailureCode,
    });
    return failed
      ? {
          ...this.terminalResult("failed", context, messageType),
          safeFailureCode,
        }
      : this.ownershipLost(context, messageType);
  }

  private async finalizeInfrastructurePlanCompletion(
    context: V1FencedPlaceholderHandlerContext,
    crossLaneClaim: CrossLaneOwnershipClaim | undefined,
    outcome: Extract<V1FencedPlaceholderOutcome, { outcome: "plan_completed" }>,
  ): Promise<V1FencedInvocationResult> {
    if (
      context.route.messageType !== "intent.infrastructure.plan"
      || !this.infrastructurePlanContinuation
      || !crossLaneClaim?.enabled
    ) {
      return this.finalizeFailure(
        context,
        context.route.messageType,
        "INFRASTRUCTURE_PLAN_CONTINUATION_UNAVAILABLE",
      );
    }
    try {
      const continuation = await this.infrastructurePlanContinuation.complete({
        parentIntentId: context.intent.id,
        parentCanonicalIdempotencyKey: context.intent.canonicalIdempotencyKey,
        // The continuation validates the planner's immutable request payload,
        // not the independently hashed queue envelope.
        parentRequestFingerprint: context.intent.requestFingerprint || "",
        infrastructureManifestId: context.intent.infrastructureManifestId!,
        initialReleaseDraftId: outcome.initialReleaseDraftId,
        planOutboxId: outcome.planOutboxId,
        planArtifactSha256: outcome.planArtifactSha256,
        planInputFingerprint: outcome.planInputFingerprint,
        operationLeaseId: context.leaseId,
        operationWorkerId: context.workerId,
        operationFencingToken: context.fencingToken,
        ownershipLeaseId: crossLaneClaim.fence.ownershipLeaseId,
        ownershipActorId: crossLaneClaim.fence.actorId,
        ownershipFencingToken: crossLaneClaim.fence.ownershipFencingToken,
      });
      return {
        disposition: "plan_completed",
        handler: "intent.infrastructure.plan",
        workerId: context.workerId,
        intentId: context.intent.id,
        projectId: context.intent.projectId,
        leaseId: context.leaseId,
        fencingToken: context.fencingToken,
        applyIntentId: continuation.applyIntentId,
        applyOutboxId: continuation.applyOutboxId,
      };
    } catch (error) {
      if (error instanceof InfrastructurePlanCompletionContinuationError) {
        return this.finalizeFailure(
          context,
          context.route.messageType,
          error.code,
        );
      }
      return this.finalizeFailure(
        context,
        context.route.messageType,
        "INFRASTRUCTURE_PLAN_CONTINUATION_FAILED",
      );
    }
  }

  private async finalizeClaimFailure(
    lease: PreExecutionLeaseSnapshot,
    messageType: ExecutableV1MessageType,
    safeFailureCode: string,
  ): Promise<V1FencedInvocationResult> {
    const failed = await this.ownership.fail({
      leaseId: lease.leaseId,
      workerId: lease.ownerWorkerId,
      fencingToken: lease.fencingToken,
      safeFailureCode,
    });
    return failed
      ? {
          disposition: "failed",
          handler: messageType,
          workerId: lease.ownerWorkerId,
          intentId: lease.intentId,
          projectId: lease.projectId,
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
          safeFailureCode,
        }
      : this.noOp(
          lease.ownerWorkerId,
          lease.intentId,
          lease.projectId,
          messageType,
          "ownership_lost",
        );
  }

  private fence(context: Pick<
    V1FencedPlaceholderHandlerContext,
    "leaseId" | "workerId" | "fencingToken"
  >) {
    return {
      leaseId: context.leaseId,
      workerId: context.workerId,
      fencingToken: context.fencingToken,
    };
  }

  private terminalResult<
    TDisposition extends "completed" | "released" | "failed",
  >(
    disposition: TDisposition,
    context: V1FencedPlaceholderHandlerContext,
    handler: ExecutableV1MessageType,
  ) {
    return {
      disposition,
      handler,
      workerId: context.workerId,
      intentId: context.intent.id,
      projectId: context.intent.projectId,
      leaseId: context.leaseId,
      fencingToken: context.fencingToken,
    };
  }

  private ownershipLost(
    context: V1FencedPlaceholderHandlerContext,
    messageType: ExecutableV1MessageType,
  ): V1FencedInvocationResult {
    return this.noOp(
      context.workerId,
      context.intent.id,
      context.intent.projectId,
      messageType,
      "ownership_lost",
    );
  }

  private noOp(
    workerId: string,
    intentId: string,
    projectId: string,
    messageType: ExecutableV1MessageType,
    reason: Extract<
      V1FencedInvocationResult,
      { disposition: "idempotent_no_op" }
    >["reason"],
  ): V1FencedInvocationResult {
    return {
      disposition: "idempotent_no_op",
      reason,
      workerId,
      intentId,
      projectId,
      messageType,
    };
  }

  private rows<T>(result: unknown): T[] {
    if (
      Array.isArray(result)
      && result.length === 2
      && Array.isArray(result[0])
      && typeof result[1] === "number"
    ) {
      return result[0] as T[];
    }
    return Array.isArray(result) ? result as T[] : [];
  }
}
