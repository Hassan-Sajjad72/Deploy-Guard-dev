import {
  InfrastructureChangeSetV1,
  InfrastructureManifestOrigin,
  InfrastructureManifestStatus,
  InfrastructureSpecV1,
} from "../contracts/infrastructure-manifest.types";
import {
  ReleaseManifestOrigin,
  ReleaseManifestStatus,
  ReleaseSpecV1,
} from "../contracts/release-manifest.types";
import { DeployGuardWorkerEnvelopeV1 } from "../contracts/worker-envelope.types";
import {
  ExecutableV1MessageType,
  V1WorkerIntentSnapshot,
} from "./inactive-v1-worker-runtime.types";
import { PreExecutionLeaseSnapshot } from "./v1-pre-execution-ownership.types";
import { V1HandlerSideEffectBoundary } from "./v1-handler-side-effect.types";

export const V1_FENCED_PLACEHOLDER_HANDLER_REGISTRY = Symbol(
  "V1_FENCED_PLACEHOLDER_HANDLER_REGISTRY",
);

export type V1InfrastructureManifestSnapshot = {
  id: string;
  schemaVersion: 1;
  projectId: string;
  environmentName: string;
  revision: string;
  parentManifestId: string | null;
  createdByIntentId: string | null;
  createdByUserId: number | null;
  origin: InfrastructureManifestOrigin;
  status: InfrastructureManifestStatus;
  specHash: string;
  terraformTemplateVersion: string;
  stateBackend: "s3" | "local_mock";
  stateKey: string;
  desiredSpec: InfrastructureSpecV1;
  changeSet: InfrastructureChangeSetV1;
  requiresTerraform: boolean;
};

export type V1ReleaseManifestSnapshot = {
  id: string;
  schemaVersion: 1;
  projectId: string;
  environmentName: string;
  revision: string;
  parentManifestId: string | null;
  previousStableManifestId: string | null;
  infrastructureManifestId: string;
  createdByIntentId: string | null;
  pipelineRunId: string | null;
  deploymentContractId: string | null;
  configurationSnapshotId: string | null;
  origin: ReleaseManifestOrigin;
  status: ReleaseManifestStatus;
  specHash: string;
  repositoryFullName: string;
  branch: string;
  commitSha: string;
  appRoot: string;
  deploymentContractHash: string;
  configurationFingerprint: string;
  buildFingerprint: string;
  runtimeFingerprint: string;
  releaseSpec: ReleaseSpecV1;
};

export type V1FencedRouteContext<
  TMessage extends ExecutableV1MessageType = ExecutableV1MessageType,
> = {
  messageType: TMessage;
  queueName: string;
  lane: "release" | "infrastructure" | "deletion";
  operation: "execute" | "plan" | "apply" | "destroy";
};

export type V1FencedPlaceholderHandlerContext<
  TMessage extends ExecutableV1MessageType = ExecutableV1MessageType,
> = {
  leaseId: string;
  workerId: string;
  fencingToken: string;
  logicalJobId: string;
  lease: PreExecutionLeaseSnapshot;
  intent: V1WorkerIntentSnapshot & { status: "running" };
  infrastructureManifest: V1InfrastructureManifestSnapshot | null;
  releaseManifest: V1ReleaseManifestSnapshot | null;
  route: V1FencedRouteContext<TMessage>;
  execution: {
    readonly signal: AbortSignal;
    isLeaseTrusted(): boolean;
  };
  sideEffects: V1HandlerSideEffectBoundary;
  envelope: DeployGuardWorkerEnvelopeV1 & {
    protocol: DeployGuardWorkerEnvelopeV1["protocol"] & {
      messageType: TMessage;
    };
  };
};

export type V1FencedPlaceholderOutcome =
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
  };

export interface V1FencedPlaceholderHandler<
  TMessage extends ExecutableV1MessageType = ExecutableV1MessageType,
> {
  readonly messageType: TMessage;
  readonly sideEffectPolicy: "deployguard.side-effect/v1";
  invoke(
    context: V1FencedPlaceholderHandlerContext<TMessage>,
  ): Promise<V1FencedPlaceholderOutcome> | V1FencedPlaceholderOutcome;
}

export type V1FencedInvocationNoOpReason =
  | "intent_terminal"
  | "intent_superseded"
  | "duplicate_delivery_owned_elsewhere"
  | "duplicate_delivery_already_owned"
  | "ownership_lost";

export type V1FencedInvocationResult =
  | {
      disposition: "completed";
      handler: ExecutableV1MessageType;
      workerId: string;
      intentId: string;
      projectId: string;
      leaseId: string;
      fencingToken: string;
    }
  | {
      disposition: "released";
      handler: ExecutableV1MessageType;
      workerId: string;
      intentId: string;
      projectId: string;
      leaseId: string;
      fencingToken: string;
      reason: "handler_retryable" | "execution_cancelled" | "apply_reconciliation_required";
    }
  | {
      disposition: "failed";
      handler: ExecutableV1MessageType;
      workerId: string;
      intentId: string;
      projectId: string;
      leaseId: string;
      fencingToken: string;
      safeFailureCode: string;
    }
  | {
      disposition: "plan_completed";
      handler: "intent.infrastructure.plan";
      workerId: string;
      intentId: string;
      projectId: string;
      leaseId: string;
      fencingToken: string;
      applyIntentId: string;
      applyOutboxId: string;
    }
  | {
      disposition: "idempotent_no_op";
      reason: V1FencedInvocationNoOpReason;
      workerId: string;
      intentId: string;
      projectId: string;
      messageType: ExecutableV1MessageType;
    };

export class V1FencedInvocationError extends Error {
  constructor(
    readonly code:
      | "INVOCATION_CONTEXT_UNAVAILABLE"
      | "INVOCATION_MANIFEST_INVALID"
      | "INVOCATION_HANDLER_UNAVAILABLE"
      | "INVOCATION_HANDLER_OUTCOME_INVALID",
  ) {
    super(code);
    this.name = "V1FencedInvocationError";
  }
}
