import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { ECRClient } from "@aws-sdk/client-ecr";
import { ECSClient } from "@aws-sdk/client-ecs";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { DisabledV1EcsMutationClient } from "../worker-runtime/disabled-v1-ecs-mutation.client";
import { DisabledV1EcsReadOnlyEvidenceClient } from "../worker-runtime/disabled-v1-ecs-read-only-evidence.client";
import { DisabledV1EcsRolloutHealthVerifier } from "../worker-runtime/disabled-v1-ecs-rollout-health.verifier";
import { ProductionV1FirstReleaseBootstrapClient } from "../worker-runtime/production-v1-first-release-bootstrap.client";
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

class ProductionCanaryRuntimeReferenceResolver
implements V1EcsRuntimeReferenceResolver {
  readonly policy =
    "deployguard.ecs-release-mutation/runtime-reference-resolver-v1" as const;

  async resolve(
    input: {
      environmentReferences: readonly unknown[];
      serviceBindingReferences: readonly unknown[];
    },
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<V1ResolvedEcsRuntimeReferences> {
    if (
      ownership.signal.aborted
      || !ownership.isLeaseTrusted()
      || this.config.get<unknown>("TWO_LANE_LATER_RELEASE_LIVE_CLIENT_ENABLED")
        !== "true"
    ) {
      throw new Error("ECS_MUTATION_RUNTIME_REFERENCES_UNAVAILABLE");
    }
    // The production canary has no runtime configuration or service bindings.
    // Do not guess values or read secrets until a separately fenced resolver
    // exists for those references.
    if (
      !Array.isArray(input.environmentReferences)
      || !Array.isArray(input.serviceBindingReferences)
      || input.environmentReferences.length !== 0
      || input.serviceBindingReferences.length !== 0
    ) {
      throw new Error("ECS_MUTATION_RUNTIME_REFERENCES_UNAVAILABLE");
    }
    return Object.freeze({ environment: [], secrets: [] });
  }

  constructor(private readonly config: ConfigService) {}
}

/**
 * Constructs existing production-shaped clients only after the composition
 * gate has accepted the exact canary configuration. It has no Nest lifecycle
 * hook and does not send a command during construction.
 */
@Injectable()
export class ProductionV1ReleaseCanaryAdapterFactory {
  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  create(
    _configuration: V1ReleaseLaneGateConfiguration,
  ): V1ReleaseLaneProductionCanaryAdapters {
    const region = this.config.get<unknown>("AWS_REGION");
    if (typeof region !== "string" || !REGION.test(region)) {
      throw new Error("CANARY_REGION_INVALID");
    }
    const ecs = new ECSClient({ region });
    const ecr = new ECRClient({ region });
    const elbv2 = new ElasticLoadBalancingV2Client({ region });
    return Object.freeze({
      policy: "deployguard.release-lane/production-canary-adapters-v1" as const,
      mutationClient: new DisabledV1EcsMutationClient(
        ecs,
        new ProductionCanaryRuntimeReferenceResolver(this.config),
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
      firstReleaseClient: new ProductionV1FirstReleaseBootstrapClient(
        this.dataSource,
        ecr,
        ecs,
        elbv2,
      ),
    });
  }
}
