import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ECSClient } from "@aws-sdk/client-ecs";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { DisabledV1EcsMutationClient } from "../worker-runtime/disabled-v1-ecs-mutation.client";
import { DisabledV1EcsReadOnlyEvidenceClient } from "../worker-runtime/disabled-v1-ecs-read-only-evidence.client";
import { DisabledV1EcsRolloutHealthVerifier } from "../worker-runtime/disabled-v1-ecs-rollout-health.verifier";
import type {
  V1EcsRuntimeReferenceResolver,
  V1ResolvedEcsRuntimeReferences,
} from "../worker-runtime/disabled-v1-ecs-mutation.client";
import type { V1HandlerSideEffectExecutorContext } from "../worker-runtime/v1-handler-side-effect.types";
import type {
  V1ReleaseLaneGateConfiguration,
  V1ReleaseLaneProductionCanaryAdapters,
} from "./inactive-v1-release-lane-composition";

const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/;

class PreflightOnlyRuntimeReferenceResolver
implements V1EcsRuntimeReferenceResolver {
  readonly policy =
    "deployguard.ecs-release-mutation/runtime-reference-resolver-v1" as const;

  async resolve(
    _input: unknown,
    _ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<V1ResolvedEcsRuntimeReferences> {
    throw new Error("ECS_MUTATION_PRELIGHT_ONLY");
  }
}

/**
 * Constructs existing production-shaped clients only after the composition
 * gate has accepted the exact canary configuration. It has no Nest lifecycle
 * hook and does not send a command during construction.
 */
@Injectable()
export class ProductionV1ReleaseCanaryAdapterFactory {
  constructor(private readonly config: ConfigService) {}

  create(
    _configuration: V1ReleaseLaneGateConfiguration,
  ): V1ReleaseLaneProductionCanaryAdapters {
    const region = this.config.get<unknown>("AWS_REGION");
    if (typeof region !== "string" || !REGION.test(region)) {
      throw new Error("CANARY_REGION_INVALID");
    }
    const ecs = new ECSClient({ region });
    const elbv2 = new ElasticLoadBalancingV2Client({ region });
    return Object.freeze({
      policy: "deployguard.release-lane/production-canary-adapters-v1" as const,
      mutationClient: new DisabledV1EcsMutationClient(
        ecs,
        new PreflightOnlyRuntimeReferenceResolver(),
        { region },
      ),
      rolloutVerifier: new DisabledV1EcsRolloutHealthVerifier(
        ecs,
        elbv2,
        { region },
      ),
      readOnlyEvidenceClient: new DisabledV1EcsReadOnlyEvidenceClient(
        ecs,
        { region },
      ),
    });
  }
}
