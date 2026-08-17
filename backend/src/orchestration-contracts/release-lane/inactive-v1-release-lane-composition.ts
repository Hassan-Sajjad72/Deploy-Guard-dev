import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { DurableOutboxDispatcherService } from
  "../outbox/durable-outbox-dispatcher.service";
import { TerminalOutboxPolicyService } from
  "../outbox/terminal-outbox-policy.service";
import { TransactionalDeploymentPlannerService } from
  "../planner/transactional-deployment-planner.service";
import { InactiveV1BullMqConsumerService } from
  "../worker-runtime/inactive-v1-bullmq-consumer.service";
import { InactiveV1EcsReleaseHandler } from
  "../worker-runtime/inactive-v1-ecs-release-handler";
import { InactiveV1EcsReleaseManifestStore } from
  "../worker-runtime/inactive-v1-ecs-release-manifest.store";
import { InactiveV1EcsReleaseMutationAdapter } from
  "../worker-runtime/inactive-v1-ecs-release-mutation.adapter";
import {
  V1EcsReleaseMutationClient,
} from "../worker-runtime/inactive-v1-ecs-release-mutation.types";
import { InactiveV1EcsReleaseOutcomeCoordinator } from
  "../worker-runtime/inactive-v1-ecs-release-outcome.coordinator";
import { InactiveV1EcsReleaseOutcomeStore } from
  "../worker-runtime/inactive-v1-ecs-release-outcome.store";
import {
  prepareInactiveV1EcsReleaseReconciliationAdapter,
} from "../worker-runtime/inactive-v1-ecs-release-reconciliation.adapter";
import {
  V1EcsReleaseReadOnlyClient,
  V1EcsReleaseReconciliationAdapterInput,
} from "../worker-runtime/inactive-v1-ecs-release-reconciliation.types";
import {
  V1EcsRolloutHealthVerifier,
} from "../worker-runtime/inactive-v1-ecs-rollout-health.types";
import { InactiveV1ExecutionLeaseHeartbeatService } from
  "../worker-runtime/inactive-v1-execution-lease-heartbeat.service";
import { InactiveV1FencedInvocationService } from
  "../worker-runtime/inactive-v1-fenced-invocation.service";
import { InactiveV1HandlerSideEffectSafetyService } from
  "../worker-runtime/inactive-v1-handler-side-effect-safety.service";
import { InactiveV1PreExecutionOwnershipService } from
  "../worker-runtime/inactive-v1-pre-execution-ownership.service";
import {
  InactiveV1SideEffectReconciliationCoordinatorService,
} from "../worker-runtime/inactive-v1-side-effect-reconciliation-coordinator.service";
import { InactiveV1SideEffectReconciliationService } from
  "../worker-runtime/inactive-v1-side-effect-reconciliation.service";
import { InactiveV1WorkerRuntimeService } from
  "../worker-runtime/inactive-v1-worker-runtime.service";
import {
  buildV1InactiveReleaseHandlerRegistry,
} from "../worker-runtime/v1-placeholder-handlers";
import { V1WorkerCapabilityService } from
  "../worker-runtime/v1-worker-capability.service";
import { InactiveV1ShadowInsertionAdapter } from "./inactive-v1-shadow-insertion.adapter";
import { CrossLaneOwnershipEnforcementService } from "./cross-lane-ownership-enforcement.service";
import { DisabledV1FirstReleaseBootstrapClient } from "../worker-runtime/disabled-v1-first-release-bootstrap.client";
import { InactiveV1FirstReleaseBootstrapAdapter } from "../worker-runtime/inactive-v1-first-release-bootstrap.adapter";
import { InactiveV1FirstReleaseBootstrapStore } from "../worker-runtime/inactive-v1-first-release-bootstrap.store";
import { V1FirstReleaseBootstrapInput, V1FirstReleaseBootstrapResult } from "../worker-runtime/inactive-v1-first-release-bootstrap.types";
import { V1FirstReleaseBootstrapClient } from "../worker-runtime/inactive-v1-first-release-bootstrap.types";
import { LaterReleaseImagePreparationService } from "./later-release-image-preparation.service";
import {
  normalV1Activation,
  NormalV1OperatingMode,
} from "./normal-v1-activation-policy";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,159}$/;

export const V1_RELEASE_LANE_FIXTURE_ADAPTER_FACTORY =
  Symbol("V1_RELEASE_LANE_FIXTURE_ADAPTER_FACTORY");
export const V1_RELEASE_LANE_PRODUCTION_CANARY_ADAPTER_FACTORY =
  Symbol("V1_RELEASE_LANE_PRODUCTION_CANARY_ADAPTER_FACTORY");

export type V1ReleaseLaneGateConfiguration = {
  workerId: string;
  operatingMode?: NormalV1OperatingMode;
  projectAllowlist: readonly string[];
  environmentAllowlist: readonly string[];
};

export type V1ReleaseLaneFixtureAdapters = {
  readonly policy: "deployguard.release-lane/fixture-adapters-v1";
  readonly mutationClient: V1EcsReleaseMutationClient;
  readonly rolloutVerifier: V1EcsRolloutHealthVerifier;
  readonly readOnlyEvidenceClient: V1EcsReleaseReadOnlyClient & {
    readonly policy:
      "deployguard.ecs-release-reconciliation/fixture-read-only-v1";
  };
  /** Test-process only; never constructed by the normal application. */
  readonly firstReleaseClient?: V1FirstReleaseBootstrapClient;
};

export type V1ReleaseLaneFixtureAdapterFactory = (
  configuration: V1ReleaseLaneGateConfiguration,
) => V1ReleaseLaneFixtureAdapters;

/**
 * This is deliberately an adapter factory, rather than a Nest lifecycle
 * provider. Constructing the normal application must not create AWS clients.
 */
export type V1ReleaseLaneProductionCanaryAdapters = {
  readonly policy: "deployguard.release-lane/production-canary-adapters-v1";
  readonly mutationClient: V1EcsReleaseMutationClient;
  readonly rolloutVerifier: V1EcsRolloutHealthVerifier;
  readonly readOnlyEvidenceClient: V1EcsReleaseReadOnlyClient & {
    readonly policy:
      "deployguard.ecs-release-reconciliation/disabled-aws-read-only-v1";
  };
  readonly firstReleaseClient?: V1FirstReleaseBootstrapClient;
};

export type V1ReleaseLaneProductionCanaryAdapterFactory = (
  configuration: V1ReleaseLaneGateConfiguration,
) => V1ReleaseLaneProductionCanaryAdapters;

export type V1ReleaseLaneCompositionStatus = Readonly<{
  state: "disabled" | "blocked" | "ready";
  mode: "fixture" | "production_canary" | "production_shared" | null;
  safeCode:
    | "RELEASE_LANE_DISABLED"
    | "RELEASE_LANE_CONFIGURATION_INVALID"
    | "RELEASE_LANE_FIXTURE_ADAPTERS_UNAVAILABLE"
    | "RELEASE_LANE_PRODUCTION_CANARY_ADAPTERS_UNAVAILABLE"
    | "RELEASE_LANE_COMPOSITION_READY";
  workerConfigured: boolean;
  projectAllowlistCount: number;
  environmentAllowlistCount: number;
  consumerStarted: false;
}>;

export type InactiveV1ReleaseLaneComposition = Readonly<{
  policy: "deployguard.release-lane/inactive-composition-v1";
  configuration: V1ReleaseLaneGateConfiguration;
  planner: TransactionalDeploymentPlannerService;
  outboxDispatcher: DurableOutboxDispatcherService;
  handler: InactiveV1EcsReleaseHandler;
  handlerRegistry: ReturnType<
    typeof buildV1InactiveReleaseHandlerRegistry
  >;
  consumer: InactiveV1BullMqConsumerService;
  mutation: InactiveV1EcsReleaseMutationAdapter;
  outcomes: InactiveV1EcsReleaseOutcomeCoordinator;
  reconciliation: InactiveV1SideEffectReconciliationService;
  reconciliationCoordinator:
    InactiveV1SideEffectReconciliationCoordinatorService;
  invokeRelease(input: Parameters<InactiveV1FencedInvocationService["invoke"]>[0]):
    ReturnType<InactiveV1FencedInvocationService["invoke"]>;
  laterReleaseImageClient: V1FirstReleaseBootstrapClient | null;
  firstReleaseBootstrap: InactiveV1FirstReleaseBootstrapAdapter | null;
  runFirstReleaseBootstrap(
    input: V1FirstReleaseBootstrapInput,
  ): Promise<V1FirstReleaseBootstrapResult>;
  prepareEcsReconciliation(
    input: Omit<V1EcsReleaseReconciliationAdapterInput, "client" | "manifests">,
  ): ReturnType<typeof prepareInactiveV1EcsReleaseReconciliationAdapter>;
  allows(projectId: string, environmentName: string): boolean;
}>;

type GateDecision =
  | { state: "disabled" }
  | { state: "blocked"; mode: "fixture" | "production_canary" | "production_shared" | null }
  | {
    state: "ready";
    mode: "fixture" | "production_canary" | "production_shared";
    configuration: V1ReleaseLaneGateConfiguration;
  };

@Injectable()
export class InactiveV1ReleaseLaneCompositionService {
  private readonly composition: InactiveV1ReleaseLaneComposition | null;
  private readonly status: V1ReleaseLaneCompositionStatus;

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly planner: TransactionalDeploymentPlannerService,
    private readonly outboxDispatcher: DurableOutboxDispatcherService,
    @Optional()
    @Inject(V1_RELEASE_LANE_FIXTURE_ADAPTER_FACTORY)
    fixtureAdapters?: V1ReleaseLaneFixtureAdapterFactory,
    @Optional()
    @Inject(V1_RELEASE_LANE_PRODUCTION_CANARY_ADAPTER_FACTORY)
    productionCanaryAdapters?: V1ReleaseLaneProductionCanaryAdapterFactory,
    @Optional()
    private readonly shadowInsertion?: InactiveV1ShadowInsertionAdapter,
    @Inject(TerminalOutboxPolicyService)
    @Optional()
    private readonly terminalOutbox = new TerminalOutboxPolicyService(),
    @Optional()
    private readonly crossLane?: CrossLaneOwnershipEnforcementService,
  ) {
    const decision = this.gate();
    if (decision.state === "disabled") {
      this.composition = null;
      this.status = this.statusOf(
        "disabled",
        "RELEASE_LANE_DISABLED",
        null,
      );
      return;
    }
    if (decision.state === "blocked") {
      this.composition = null;
      this.status = this.statusOf(
        "blocked",
        "RELEASE_LANE_CONFIGURATION_INVALID",
        decision.mode,
      );
      return;
    }
    const factory = decision.mode === "fixture"
      ? fixtureAdapters
      : productionCanaryAdapters;
    if (!factory) {
      this.composition = null;
      this.status = this.statusOf(
        "blocked",
        decision.mode === "fixture"
          ? "RELEASE_LANE_FIXTURE_ADAPTERS_UNAVAILABLE"
          : "RELEASE_LANE_PRODUCTION_CANARY_ADAPTERS_UNAVAILABLE",
        decision.mode,
        decision.configuration,
      );
      return;
    }
    try {
      const adapters = factory(decision.configuration);
      this.composition = this.compose(decision.configuration, adapters);
      this.status = this.statusOf(
        "ready",
        "RELEASE_LANE_COMPOSITION_READY",
        decision.mode,
        decision.configuration,
      );
    } catch {
      this.composition = null;
      this.status = this.statusOf(
        "blocked",
        "RELEASE_LANE_CONFIGURATION_INVALID",
        decision.mode,
        decision.configuration,
      );
    }
  }

  getStatus(): V1ReleaseLaneCompositionStatus {
    return this.status;
  }

  getInactiveComposition(): InactiveV1ReleaseLaneComposition | null {
    return this.composition;
  }

  private compose(
    configuration: V1ReleaseLaneGateConfiguration,
    adapters:
      | V1ReleaseLaneFixtureAdapters
      | V1ReleaseLaneProductionCanaryAdapters,
  ): InactiveV1ReleaseLaneComposition {
    if (
      (adapters?.policy !== "deployguard.release-lane/fixture-adapters-v1"
        && adapters?.policy
          !== "deployguard.release-lane/production-canary-adapters-v1")
      || adapters.mutationClient?.policy
        !== "deployguard.ecs-release-mutation/client-v1"
      || adapters.rolloutVerifier?.policy
        !== "deployguard.ecs-rollout-health/disabled-read-only-v1"
      || (adapters.readOnlyEvidenceClient?.policy
        !== "deployguard.ecs-release-reconciliation/fixture-read-only-v1"
        && adapters.readOnlyEvidenceClient?.policy
          !== "deployguard.ecs-release-reconciliation/disabled-aws-read-only-v1")
    ) {
      throw new Error("RELEASE_LANE_FIXTURE_ADAPTERS_INVALID");
    }
    const manifests = new InactiveV1EcsReleaseManifestStore(this.dataSource);
    const mutation = new InactiveV1EcsReleaseMutationAdapter(
      manifests,
      adapters.mutationClient,
    );
    const outcomes = new InactiveV1EcsReleaseOutcomeCoordinator({
      manifests,
      outcomes: new InactiveV1EcsReleaseOutcomeStore(this.dataSource),
      mutationClient: adapters.mutationClient,
      verifier: adapters.rolloutVerifier,
    });
    const firstReleaseClient = this.config.get<unknown>("TWO_LANE_RELEASE_COMPOSITION_MODE") === "fixture"
      && this.firstReleaseBootstrapEnabled(configuration)
      ? adapters.firstReleaseClient ?? null
      : this.firstReleaseLiveClientEnabled(configuration)
        ? adapters.firstReleaseClient ?? null
        : new DisabledV1FirstReleaseBootstrapClient();
    if (this.firstReleaseBootstrapEnabled(configuration) && !firstReleaseClient) {
      throw new Error("FIRST_RELEASE_LIVE_CLIENT_UNAVAILABLE");
    }
    const firstReleaseBootstrap = this.firstReleaseBootstrapEnabled(configuration)
      ? new InactiveV1FirstReleaseBootstrapAdapter(
        new InactiveV1FirstReleaseBootstrapStore(this.dataSource),
        firstReleaseClient!,
      )
      : null;
    const handler = new InactiveV1EcsReleaseHandler(mutation, outcomes, {
      // A pinned first-release image build includes a fresh source checkout and
      // dependency build.  Keep its single fenced effect within the existing
      // 15-minute side-effect limit instead of the 60-second later-release
      // default; the consumer heartbeat continues to protect the lease.
      sideEffectTimeoutMs: 10 * 60_000,
      firstRelease: firstReleaseBootstrap
        && this.config.get<unknown>(
          "TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_EXECUTION_ENABLED",
        ) === "true"
        ? { dataSource: this.dataSource, bootstrap: firstReleaseBootstrap }
        : undefined,
    });
    const handlerRegistry = buildV1InactiveReleaseHandlerRegistry(handler);
    const capabilities = new V1WorkerCapabilityService(this.dataSource);
    const runtime = new InactiveV1WorkerRuntimeService(
      this.dataSource,
      capabilities,
      this.config,
    );
    const ownership = new InactiveV1PreExecutionOwnershipService(
      this.dataSource,
      runtime,
      this.terminalOutbox,
    );
    const heartbeat =
      new InactiveV1ExecutionLeaseHeartbeatService(ownership);
    const sideEffects =
      new InactiveV1HandlerSideEffectSafetyService(this.dataSource);
    const invocation = new InactiveV1FencedInvocationService(
      this.dataSource,
      ownership,
      handlerRegistry,
      heartbeat,
      sideEffects,
      this.crossLane,
    );
    const laterReleaseImageClient = (
      this.laterReleaseLiveClientEnabled(configuration)
      || this.localFixtureExecutionEnabled(configuration)
    )
      ? adapters.firstReleaseClient ?? null
      : null;
    const normalReleasePreparation = laterReleaseImageClient
      ? new LaterReleaseImagePreparationService(
        this.dataSource,
        laterReleaseImageClient,
      )
      : undefined;
    const consumer = new InactiveV1BullMqConsumerService(
      invocation,
      capabilities,
      this.shadowInsertion,
      this.crossLane,
      normalReleasePreparation
        ? (context) => normalReleasePreparation.prepare(context)
        : undefined,
    );
    const reconciliation =
      new InactiveV1SideEffectReconciliationService(this.dataSource);
    const reconciliationCoordinator =
      new InactiveV1SideEffectReconciliationCoordinatorService(
        this.dataSource,
        reconciliation,
      );
    const projectAllowlist = new Set(configuration.projectAllowlist);
    const environmentAllowlist =
      new Set(configuration.environmentAllowlist);
    return Object.freeze({
      policy: "deployguard.release-lane/inactive-composition-v1" as const,
      configuration,
      planner: this.planner,
      outboxDispatcher: this.outboxDispatcher,
      handler,
      handlerRegistry,
      consumer,
      mutation,
      outcomes,
      reconciliation,
      reconciliationCoordinator,
      invokeRelease: (input) => invocation.invoke(input),
      laterReleaseImageClient,
      firstReleaseBootstrap,
      runFirstReleaseBootstrap: async (input) => {
        if (!firstReleaseBootstrap
          || (configuration.operatingMode !== "shared"
            && !projectAllowlist.has(input.identity.projectId))
          || !environmentAllowlist.has(input.identity.environmentName)
          || input.identity.environmentName !== "dev") {
          throw new Error("FIRST_RELEASE_BOOTSTRAP_NOT_ALLOWED");
        }
        return firstReleaseBootstrap.bootstrap(input);
      },
      prepareEcsReconciliation: (
        input: Omit<
          V1EcsReleaseReconciliationAdapterInput,
          "client" | "manifests"
        >,
      ) => prepareInactiveV1EcsReleaseReconciliationAdapter({
        ...input,
        client: adapters.readOnlyEvidenceClient,
        manifests,
      }),
      allows: (projectId: string, environmentName: string) =>
        (configuration.operatingMode === "shared"
          || projectAllowlist.has(projectId))
        && environmentAllowlist.has(environmentName),
    });
  }

  private gate(): GateDecision {
    const enabled = this.config.get<unknown>(
      "TWO_LANE_RELEASE_COMPOSITION_ENABLED",
    );
    if (enabled !== "true") return { state: "disabled" };
    const mode = this.config.get<unknown>("TWO_LANE_RELEASE_COMPOSITION_MODE");
    if (mode !== "fixture" && mode !== "production_canary"
      && mode !== "production_shared") {
      return { state: "blocked", mode: null };
    }
    const activation = mode === "fixture" ? null : normalV1Activation(this.config);
    if (mode !== "fixture" && (!activation
      || (mode === "production_canary" && activation.mode !== "canary")
      || (mode === "production_shared" && activation.mode !== "shared"))) {
      return { state: "blocked", mode };
    }
    const workerId = this.config.get<unknown>(
      "TWO_LANE_RELEASE_WORKER_ID",
    );
    const projects = mode === "fixture"
      ? this.allowlist(
        this.config.get<unknown>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST"), UUID,
      )
      : activation!.projectIds;
    const environments = mode === "fixture"
      ? this.allowlist(
        this.config.get<unknown>("TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST"),
        ENVIRONMENT,
      )
      : activation!.environmentNames;
    if (
      typeof workerId !== "string"
      || !WORKER_ID.test(workerId)
      || !projects
      || !environments
    ) return { state: "blocked", mode };
    if (mode === "production_canary" && !this.isExactProductionCanary(projects, environments)) {
      return { state: "blocked", mode };
    }
    if (mode === "production_shared" && !this.isSharedProduction(environments)) {
      return { state: "blocked", mode };
    }
    return {
      state: "ready",
      mode,
      configuration: Object.freeze({
        workerId,
        operatingMode: activation?.mode ?? "canary",
        projectAllowlist: Object.freeze(projects),
        environmentAllowlist: Object.freeze(environments),
      }),
    };
  }

  private firstReleaseBootstrapEnabled(
    configuration: V1ReleaseLaneGateConfiguration,
  ) {
    return this.config.get<unknown>("TWO_LANE_FIRST_RELEASE_BOOTSTRAP_ENABLED") === "true"
      && (this.config.get<unknown>("TWO_LANE_RELEASE_COMPOSITION_MODE") === "production_canary"
        || this.config.get<unknown>("TWO_LANE_RELEASE_COMPOSITION_MODE") === "production_shared"
        || (this.config.get<unknown>("TWO_LANE_RELEASE_COMPOSITION_MODE") === "fixture"
          && this.config.get<unknown>("TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_EXECUTION_ENABLED") === "true"))
      && (configuration.operatingMode === "shared"
        || configuration.projectAllowlist.length === 1)
      && configuration.environmentAllowlist.length === 1
      && configuration.environmentAllowlist[0] === "dev";
  }

  private firstReleaseLiveClientEnabled(
    configuration: V1ReleaseLaneGateConfiguration,
  ) {
    return this.config.get<unknown>("TWO_LANE_FIRST_RELEASE_LIVE_CLIENT_ENABLED") === "true"
      && this.firstReleaseBootstrapEnabled(configuration)
      && (configuration.operatingMode === "shared"
        || configuration.projectAllowlist.length === 1)
      && configuration.environmentAllowlist.length === 1
      && configuration.environmentAllowlist[0] === "dev";
  }

  private laterReleaseLiveClientEnabled(
    configuration: V1ReleaseLaneGateConfiguration,
  ) {
    return this.config.get<unknown>("TWO_LANE_LATER_RELEASE_LIVE_CLIENT_ENABLED") === "true"
      && ["production_canary", "production_shared"].includes(String(
        this.config.get<unknown>("TWO_LANE_RELEASE_COMPOSITION_MODE"),
      ))
      && (configuration.operatingMode === "shared"
        || configuration.projectAllowlist.length === 1)
      && configuration.environmentAllowlist.length === 1
      && configuration.environmentAllowlist[0] === "dev";
  }

  private localFixtureExecutionEnabled(
    configuration: V1ReleaseLaneGateConfiguration,
  ) {
    return this.config.get<unknown>("NODE_ENV") === "test"
      && this.config.get<unknown>(
        "TWO_LANE_LOCAL_RELEASE_FIXTURE_EXECUTION_ENABLED",
      ) === "true"
      && this.config.get<unknown>("TWO_LANE_RELEASE_COMPOSITION_MODE")
        === "fixture"
      && configuration.projectAllowlist.length === 1
      && configuration.environmentAllowlist.length === 1
      && configuration.environmentAllowlist[0] === "dev";
  }

  private isExactProductionCanary(
    projects: readonly string[],
    environments: readonly string[],
  ) {
    if (
      projects.length !== 1
      || environments.length !== 1
      || environments[0] !== "dev"
      || this.config.get<unknown>("TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_MODE") !== "read_only"
    ) return false;
    const ownershipProjects = this.allowlist(
      this.config.get<unknown>("TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST"),
      UUID,
    );
    const ownershipEnvironments = this.allowlist(
      this.config.get<unknown>("TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST"),
      ENVIRONMENT,
    );
    return ownershipProjects?.length === 1
      && ownershipProjects[0] === projects[0]
      && ownershipEnvironments?.length === 1
      && ownershipEnvironments[0] === "dev";
  }

  private isSharedProduction(environments: readonly string[]) {
    const ownershipEnvironments = this.allowlist(
      this.config.get<unknown>("TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST"),
      ENVIRONMENT,
    );
    return environments.length === 1
      && environments[0] === "dev"
      && ownershipEnvironments?.length === 1
      && ownershipEnvironments[0] === "dev"
      && this.config.get<unknown>("TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED") === "true"
      && this.config.get<unknown>("TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED") === "true"
      && this.config.get<unknown>("TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED") === "true";
  }

  private allowlist(value: unknown, pattern: RegExp) {
    if (typeof value !== "string") return null;
    const entries = value.split(",").map((entry) => entry.trim());
    if (
      entries.length === 0
      || entries.some((entry) => !entry || !pattern.test(entry))
    ) return null;
    return [...new Set(entries)].sort();
  }

  private statusOf(
    state: V1ReleaseLaneCompositionStatus["state"],
    safeCode: V1ReleaseLaneCompositionStatus["safeCode"],
    mode: V1ReleaseLaneCompositionStatus["mode"],
    configuration?: V1ReleaseLaneGateConfiguration,
  ): V1ReleaseLaneCompositionStatus {
    return Object.freeze({
      state,
      mode,
      safeCode,
      workerConfigured: Boolean(configuration?.workerId),
      projectAllowlistCount: configuration?.projectAllowlist.length ?? 0,
      environmentAllowlistCount:
        configuration?.environmentAllowlist.length ?? 0,
      consumerStarted: false,
    });
  }
}
