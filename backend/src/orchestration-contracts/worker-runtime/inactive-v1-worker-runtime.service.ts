import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { DeploymentIntentStatus } from "../contracts/deployment-intent.types";
import { DeployGuardWorkerEnvelopeV1 } from "../contracts/worker-envelope.types";
import { validateWorkerEnvelopeV1 } from "../contracts/worker-envelope.validator";
import {
  assertFrozenQueueRouting,
  workerRoleForMessageType,
} from "../outbox/outbox-dispatcher.pure";
import {
  ExecutableV1MessageType,
  InactiveV1WorkerRuntimeError,
  InactiveV1WorkerRuntimeResult,
  InactiveV1WorkerValidationResult,
  V1WorkerIdempotentNoOp,
  V1WorkerIntentSnapshot,
} from "./inactive-v1-worker-runtime.types";
import { buildV1PlaceholderHandlerRegistry } from "./v1-placeholder-handlers";
import { V1WorkerCapabilityService } from "./v1-worker-capability.service";
import { canonicalSha256 } from "../contracts/canonical-json";

type IntentRow = V1WorkerIntentSnapshot & {
  requestedByUserId: number | null;
  requestedByRole: string | null;
  projectOwnerUserId: number;
  projectStatus: string;
  projectArchivedAt: Date | null;
  contractCommitSha: string | null;
  contractHash: string | null;
  contractDeployable: boolean | null;
  contractInvalidatedAt: Date | null;
  preflightFingerprint: string | null;
  preflightStatus: string | null;
  infrastructureRevision: string | null;
  releaseRevision: string | null;
  createdAt: Date;
  projectDeletionFenceToken: string | null;
  projectDeletionIntentId: string | null;
  projectDeletionStartedAt: Date | null;
  releaseManifestStatus: string | null;
  infrastructureManifestStatus: string | null;
  hasNewerAcceptedIntent: boolean;
};

const TERMINAL_INTENT_STATUSES = new Set<DeploymentIntentStatus>([
  "completed",
  "failed",
  "cancelled",
  "no_op",
  "rejected",
]);

const SUPERSEDED_RELEASE_STATUSES = new Set([
  "superseded",
  "cancelled",
  "rolled_back",
]);
const SUPERSEDED_INFRASTRUCTURE_STATUSES = new Set([
  "superseded",
  "destroyed",
]);

@Injectable()
export class InactiveV1WorkerRuntimeService {
  private readonly handlers = buildV1PlaceholderHandlerRegistry();

  constructor(
    private readonly dataSource: DataSource,
    private readonly capabilities: V1WorkerCapabilityService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async route(input: {
    workerId: string;
    queueName: string;
    envelope: unknown;
  }): Promise<InactiveV1WorkerRuntimeResult> {
    const validated = await this.validate(input);
    if (validated.disposition === "idempotent_no_op") return validated;

    const handler = this.handlers.get(validated.messageType);
    if (!handler) {
      throw new InactiveV1WorkerRuntimeError(
        "PLACEHOLDER_HANDLER_UNAVAILABLE",
      );
    }
    return handler.handle({
      workerId: validated.workerId,
      queueName: validated.queueName,
      messageType: validated.messageType,
      envelope: validated.envelope,
      intent: validated.intent,
    });
  }

  async validate(input: {
    workerId: string;
    queueName: string;
    envelope: unknown;
  }): Promise<InactiveV1WorkerValidationResult> {
    let envelope: DeployGuardWorkerEnvelopeV1;
    try {
      envelope = validateWorkerEnvelopeV1(input.envelope);
    } catch {
      throw new InactiveV1WorkerRuntimeError("WORKER_ENVELOPE_INVALID");
    }

    let frozenQueue: string;
    try {
      frozenQueue = assertFrozenQueueRouting(envelope);
    } catch {
      throw new InactiveV1WorkerRuntimeError("WORKER_QUEUE_MISMATCH");
    }
    if (input.queueName !== frozenQueue) {
      throw new InactiveV1WorkerRuntimeError("WORKER_QUEUE_MISMATCH");
    }

    await this.capabilities.requireLiveCompatible(
      input.workerId,
      envelope.protocol.messageType,
    );
    const intent = await this.loadIntent(envelope.identity.intentId);
    if (!intent) {
      throw new InactiveV1WorkerRuntimeError("INTENT_NOT_FOUND");
    }
    this.assertIntentIdentity(intent, envelope);
    this.assertSharedAuthorization(intent, envelope);

    const messageType = envelope.protocol.messageType as ExecutableV1MessageType;
    if (TERMINAL_INTENT_STATUSES.has(intent.status)) {
      return this.noOp(input.workerId, intent, messageType, "intent_terminal");
    }
    if (this.isSuperseded(intent)) {
      return this.noOp(
        input.workerId,
        intent,
        messageType,
        "intent_superseded",
      );
    }
    this.assertIntentClassification(intent, envelope);
    this.assertDeletionFence(intent, envelope);

    return {
      disposition: "validated",
      workerId: input.workerId,
      queueName: input.queueName,
      messageType,
      envelope: envelope as DeployGuardWorkerEnvelopeV1 & {
        protocol: DeployGuardWorkerEnvelopeV1["protocol"] & {
          messageType: ExecutableV1MessageType;
        };
      },
      intent,
    };
  }

  private async loadIntent(intentId: string): Promise<IntentRow | null> {
    const rows = this.rows<IntentRow>(await this.dataSource.query(
      `SELECT
         intent.id,
         intent.requested_by_user_id AS "requestedByUserId",
         intent.project_id AS "projectId",
         intent.environment_name AS "environmentName",
         intent.classification,
         intent.status,
         intent.canonical_idempotency_key AS "canonicalIdempotencyKey",
         intent.infrastructure_manifest_id AS "infrastructureManifestId",
         intent.release_manifest_id AS "releaseManifestId",
         intent.pipeline_run_id AS "pipelineRunId",
         intent.destroy_operation_id AS "destroyOperationId",
         intent.created_at AS "createdAt",
         actor.role AS "requestedByRole",
         project.owner_user_id AS "projectOwnerUserId",
         project.status AS "projectStatus",
         project.archived_at AS "projectArchivedAt",
         contract.commit_sha AS "contractCommitSha",
         contract.contract_hash AS "contractHash",
         contract.deployable AS "contractDeployable",
         contract.invalidated_at AS "contractInvalidatedAt",
         preflight.input_fingerprint AS "preflightFingerprint",
         preflight.validation_status AS "preflightStatus",
         infrastructure.revision::text AS "infrastructureRevision",
         release.revision::text AS "releaseRevision",
         project.deletion_fence_token AS "projectDeletionFenceToken",
         project.deletion_intent_id AS "projectDeletionIntentId",
         project.deletion_started_at AS "projectDeletionStartedAt",
         release.status AS "releaseManifestStatus",
         infrastructure.status AS "infrastructureManifestStatus",
         EXISTS (
           SELECT 1
           FROM deployment_intents newer
           WHERE newer.project_id = intent.project_id
             AND newer.environment_name = intent.environment_name
             AND newer.created_at > intent.created_at
             AND newer.status IN ('planned','enqueued','running','completed')
             AND newer.classification IN (
               'release_only','infrastructure_change','deletion'
             )
             AND (
               newer.classification = intent.classification
               OR newer.classification = 'deletion'
             )
         ) AS "hasNewerAcceptedIntent"
       FROM deployment_intents intent
       INNER JOIN projects project ON project.id = intent.project_id
       LEFT JOIN users actor ON actor.id = intent.requested_by_user_id
       LEFT JOIN project_deployment_contracts contract
         ON contract.project_id = intent.project_id
       LEFT JOIN project_preflight_reports preflight
         ON preflight.project_id = intent.project_id
       LEFT JOIN release_manifests release
         ON release.id = intent.release_manifest_id
       LEFT JOIN infrastructure_manifests infrastructure
         ON infrastructure.id = intent.infrastructure_manifest_id
       WHERE intent.id = $1
       LIMIT 1`,
      [intentId],
    ));
    return rows[0] || null;
  }

  private assertIntentIdentity(
    intent: IntentRow,
    envelope: DeployGuardWorkerEnvelopeV1,
  ) {
    const identityMatches =
      intent.projectId === envelope.identity.projectId
      && intent.environmentName === envelope.identity.environmentName
      && intent.pipelineRunId === envelope.identity.pipelineRunId
      && intent.destroyOperationId === envelope.identity.destroyOperationId
      && intent.infrastructureManifestId
        === envelope.identity.infrastructureManifestId
      && intent.releaseManifestId === envelope.identity.releaseManifestId
      && intent.canonicalIdempotencyKey === envelope.idempotency.canonicalKey;
    if (!identityMatches) {
      throw new InactiveV1WorkerRuntimeError("INTENT_IDENTITY_MISMATCH");
    }
  }

  private assertSharedAuthorization(
    intent: IntentRow,
    envelope: DeployGuardWorkerEnvelopeV1,
  ) {
    if (!envelope.identity.workspaceId) return;
    const authorization = envelope.authorization;
    const expected = envelope.expectations;
    const workspaceId = `workspace:${intent.projectOwnerUserId}`;
    const actorAuthorized = authorization?.actorRole === "admin"
      || (authorization?.actorRole === "developer"
        && authorization.actorUserId === intent.projectOwnerUserId);
    const policyHash = authorization ? canonicalSha256({
      workspaceId,
      projectId: intent.projectId,
      environmentName: intent.environmentName,
      actorUserId: authorization.actorUserId,
      actorRole: authorization.actorRole,
      projectOwnerUserId: authorization.projectOwnerUserId,
    }) : null;
    const accountId = this.config?.get<unknown>("TWO_LANE_EXPECTED_AWS_ACCOUNT_ID")
      || this.config?.get<unknown>("TWO_LANE_CANARY_EXPECTED_AWS_ACCOUNT");
    const region = this.config?.get<unknown>("AWS_REGION");
    if (
      !authorization || !expected || !this.config
      || envelope.identity.workspaceId !== workspaceId
      || authorization.projectOwnerUserId !== intent.projectOwnerUserId
      || authorization.actorUserId !== intent.requestedByUserId
      || authorization.actorRole !== intent.requestedByRole
      || authorization.policySnapshotSha256 !== policyHash
      || !actorAuthorized
      || intent.projectStatus === "archived" || intent.projectArchivedAt !== null
      || intent.environmentName !== "dev"
      || intent.contractDeployable !== true || intent.contractInvalidatedAt !== null
      || intent.preflightFingerprint !== intent.contractHash
      || !["passed", "passed_with_warnings"].includes(intent.preflightStatus || "")
      || expected.sourceCommitSha !== intent.contractCommitSha
      || expected.deploymentContractHash !== intent.contractHash
      || expected.infrastructureRevision !== intent.infrastructureRevision
      || expected.releaseRevision !== intent.releaseRevision
      || expected.awsAccountId !== accountId
      || expected.awsRegion !== region
      || expected.resourceNamespace
        !== `dg-${intent.projectId.replace(/-/g, "").slice(0, 12)}-dev`
    ) {
      throw new InactiveV1WorkerRuntimeError("WORKER_AUTHORIZATION_INVALID");
    }
  }

  private assertIntentClassification(
    intent: IntentRow,
    envelope: DeployGuardWorkerEnvelopeV1,
  ) {
    const expectedRole = workerRoleForMessageType(
      envelope.protocol.messageType,
    );
    const classificationMatches =
      (expectedRole === "release" && intent.classification === "release_only")
      || (
        expectedRole === "infrastructure"
        && intent.classification === "infrastructure_change"
      )
      || (expectedRole === "deletion" && intent.classification === "deletion");
    if (!classificationMatches) {
      throw new InactiveV1WorkerRuntimeError(
        "INTENT_CLASSIFICATION_MISMATCH",
      );
    }
    const initialOneShot = expectedRole === "release"
      && intent.infrastructureManifestId !== null
      && intent.releaseManifestId === null
      && envelope.execution.reasonCodes.length === 1
      && envelope.execution.reasonCodes[0] === "INITIAL_RELEASE_ONE_SHOT";
    if (
      expectedRole === "release"
      && (!intent.infrastructureManifestId || (!intent.releaseManifestId && !initialOneShot))
    ) {
      throw new InactiveV1WorkerRuntimeError("INTENT_IDENTITY_MISMATCH");
    }
  }

  private isSuperseded(intent: IntentRow) {
    return intent.hasNewerAcceptedIntent
      || (
        !!intent.releaseManifestStatus
        && SUPERSEDED_RELEASE_STATUSES.has(intent.releaseManifestStatus)
      )
      || (
        !!intent.infrastructureManifestStatus
        && SUPERSEDED_INFRASTRUCTURE_STATUSES.has(
          intent.infrastructureManifestStatus,
        )
      );
  }

  private assertDeletionFence(
    intent: IntentRow,
    envelope: DeployGuardWorkerEnvelopeV1,
  ) {
    const isDeletion =
      envelope.protocol.messageType === "intent.deletion.execute";
    const hasFence =
      intent.projectDeletionFenceToken !== null
      || intent.projectDeletionIntentId !== null
      || intent.projectDeletionStartedAt !== null;
    if (!isDeletion && hasFence) {
      throw new InactiveV1WorkerRuntimeError("DELETION_FENCE_ACTIVE");
    }
    if (
      isDeletion
      && (
        !intent.projectDeletionFenceToken
        || intent.projectDeletionIntentId !== intent.id
        || !intent.projectDeletionStartedAt
      )
    ) {
      throw new InactiveV1WorkerRuntimeError("DELETION_FENCE_MISSING");
    }
  }

  private noOp(
    workerId: string,
    intent: IntentRow,
    messageType: ExecutableV1MessageType,
    reason: "intent_terminal" | "intent_superseded",
  ): V1WorkerIdempotentNoOp {
    return {
      disposition: "idempotent_no_op",
      reason,
      workerId,
      intentId: intent.id,
      projectId: intent.projectId,
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
