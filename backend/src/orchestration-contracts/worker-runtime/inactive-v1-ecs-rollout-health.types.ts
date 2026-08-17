import type { ECSClient } from "@aws-sdk/client-ecs";
import type { ElasticLoadBalancingV2Client } from
  "@aws-sdk/client-elastic-load-balancing-v2";
import {
  V1EcsReleaseManifestStore,
  V1EcsReleaseRevisionIdentity,
} from "./inactive-v1-ecs-release-mutation.types";
import {
  V1EcsReleaseMutationExecution,
} from "./inactive-v1-ecs-release-mutation.types";

export type V1InjectedEcsRolloutReadClient = Pick<ECSClient, "send">;
export type V1InjectedElbv2HealthReadClient =
  Pick<ElasticLoadBalancingV2Client, "send">;

export type V1EcsRolloutHealthVerificationStatus =
  | "healthy"
  | "progressing"
  | "failed"
  | "timed_out"
  | "ambiguous";

export type V1EcsRolloutHealthSafeCode =
  | "ECS_ROLLOUT_AND_TARGETS_HEALTHY"
  | "ECS_ROLLOUT_PROGRESSING"
  | "ECS_TARGETS_REGISTERING"
  | "ECS_ROLLOUT_FAILED"
  | "ECS_TASK_START_FAILED"
  | "ALB_TARGET_UNHEALTHY"
  | "ECS_ROLLOUT_HEALTH_TIMEOUT"
  | "ECS_ROLLOUT_EVIDENCE_AMBIGUOUS";

export type V1EcsRolloutHealthVerificationResult = {
  status: V1EcsRolloutHealthVerificationStatus;
  safeCode: V1EcsRolloutHealthSafeCode;
  evidenceHash: string;
};

export type V1EcsRolloutHealthVerificationInput = {
  revision: V1EcsReleaseRevisionIdentity;
  manifests: Pick<V1EcsReleaseManifestStore, "loadExact">;
  execution: V1EcsReleaseMutationExecution;
  deadlineAt: Date;
};

export interface V1EcsRolloutHealthVerifier {
  readonly policy: "deployguard.ecs-rollout-health/disabled-read-only-v1";
  verify(
    input: V1EcsRolloutHealthVerificationInput,
  ): Promise<V1EcsRolloutHealthVerificationResult>;
}

export type V1DisabledEcsRolloutHealthVerifierOptions = {
  region: string;
  maxTaskPages?: number;
  taskPageSize?: number;
  now?: () => Date;
};

export class V1EcsRolloutHealthVerificationError extends Error {
  constructor(
    readonly code:
      | "ECS_ROLLOUT_HEALTH_CANCELLED"
      | "ECS_ROLLOUT_HEALTH_CONTRACT_INVALID"
      | "ECS_ROLLOUT_HEALTH_OWNERSHIP_LOST",
  ) {
    super(code);
    this.name = "V1EcsRolloutHealthVerificationError";
  }
}
