import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { DurableOutboxDispatcherService } from
  "../outbox/durable-outbox-dispatcher.service";
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
import { DisabledV1FirstReleaseBootstrapClient } from "../worker-runtime/disabled-v1-first-release-bootstrap.client";
import { InactiveV1FirstReleaseBootstrapAdapter } from "../worker-runtime/inactive-v1-first-release-bootstrap.adapter";
import { InactiveV1FirstReleaseBootstrapStore } from "../worker-runtime/inactive-v1-first-release-bootstrap.store";
import { V1FirstReleaseBootstrapInput, V1FirstReleaseBootstrapResult } from "../worker-runtime/inactive-v1-first-release-bootstrap.types";
import { V1FirstReleaseBootstrapClient } from "../worker-runtime/inactive-v1-first-release-bootstrap.types";

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
  mode: "fixture" | "production_canary" | null;
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
  | { state: "blocked"; mode: "fixture" | "production_canary" | null }
  | {
    state: "ready";
    mode: "fixture" | "production_canary";
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
    const handler = new InactiveV1EcsReleaseHandler(mutation, outcomes);
    const handlerRegistry = buildV1InactiveReleaseHandlerRegistry(handler);
    const capabilities = new V1WorkerCapabilityService(this.dataSource);
    const runtime = new InactiveV1WorkerRuntimeService(
      this.dataSource,
      capabilities,
    );
    const ownership = new InactiveV1PreExecutionOwnershipService(
      this.dataSource,
      runtime,
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
    );
    const consumer = new InactiveV1BullMqConsumerService(
      invocation,
      capabilities,
      this.shadowInsertion,
    );
    const reconciliation =
      new InactiveV1SideEffectReconciliationService(this.dataSource);
    const reconciliationCoordinator =
      new InactiveV1SideEffectReconciliationCoordinatorService(
        this.dataSource,
        reconciliation,
      );
    const firstReleaseClient = this.firstReleaseLiveClientEnabled(configuration)
      ? adapters.policy === "deployguard.release-lane/production-canary-adapters-v1"
        ? adapters.firstReleaseClient ?? null
        : null
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
      firstReleaseBootstrap,
      runFirstReleaseBootstrap: async (input) => {
        if (!firstReleaseBootstrap
          || !projectAllowlist.has(input.identity.projectId)
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
        projectAllowlist.has(projectId)
        && environmentAllowlist.has(environmentName),
    });
  }

  private gate(): GateDecision {
    const enabled = this.config.get<unknown>(
      "TWO_LANE_RELEASE_COMPOSITION_ENABLED",
    );
    if (enabled !== "true") return { state: "disabled" };
    const mode = this.config.get<unknown>("TWO_LANE_RELEASE_COMPOSITION_MODE");
    if (mode !== "fixture" && mode !== "production_canary") {
      return { state: "blocked", mode: null };
    }
    const workerId = this.config.get<unknown>(
      "TWO_LANE_RELEASE_WORKER_ID",
    );
    const projects = this.allowlist(
      this.config.get<unknown>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST"),
      UUID,
    );
    const environments = this.allowlist(
      this.config.get<unknown>(
        "TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST",
      ),
      ENVIRONMENT,
    );
    if (
      typeof workerId !== "string"
      || !WORKER_ID.test(workerId)
      || !projects
      || !environments
    ) return { state: "blocked", mode };
    if (mode === "production_canary" && !this.isExactProductionCanary(projects, environments)) {
      return { state: "blocked", mode };
    }
    return {
      state: "ready",
      mode,
      configuration: Object.freeze({
        workerId,
        projectAllowlist: Object.freeze(projects),
        environmentAllowlist: Object.freeze(environments),
      }),
    };
  }

  private firstReleaseBootstrapEnabled(
    configuration: V1ReleaseLaneGateConfiguration,
  ) {
    return this.config.get<unknown>("TWO_LANE_RELEASE_COMPOSITION_MODE") === "production_canary"
      && this.config.get<unknown>("TWO_LANE_FIRST_RELEASE_BOOTSTRAP_ENABLED") === "true"
      && configuration.projectAllowlist.length === 1
      && configuration.environmentAllowlist.length === 1
      && configuration.environmentAllowlist[0] === "dev";
  }

  private firstReleaseLiveClientEnabled(
    configuration: V1ReleaseLaneGateConfiguration,
  ) {
    return this.config.get<unknown>("TWO_LANE_FIRST_RELEASE_LIVE_CLIENT_ENABLED") === "true"
      && this.firstReleaseBootstrapEnabled(configuration)
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
