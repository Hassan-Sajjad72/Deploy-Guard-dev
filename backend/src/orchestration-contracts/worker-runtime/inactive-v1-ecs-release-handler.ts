import { canonicalSha256 } from "../contracts/canonical-json";
import { DataSource } from "typeorm";
import { InitialReleaseDraft } from "../entities/initial-release-draft.entity";
import { InactiveV1FirstReleaseBootstrapAdapter } from "./inactive-v1-first-release-bootstrap.adapter";
import {
  InactiveV1EcsReleaseMutationAdapter,
} from "./inactive-v1-ecs-release-mutation.adapter";
import {
  V1EcsReleaseMutationError,
  V1EcsReleaseRevisionIdentity,
} from "./inactive-v1-ecs-release-mutation.types";
import {
  InactiveV1EcsReleaseOutcomeCoordinator,
} from "./inactive-v1-ecs-release-outcome.coordinator";
import {
  V1EcsReleaseOutcomeError,
} from "./inactive-v1-ecs-release-outcome.types";
import {
  V1FencedPlaceholderHandler,
  V1FencedPlaceholderHandlerContext,
  V1FencedPlaceholderOutcome,
} from "./v1-fenced-invocation.types";

export type InactiveV1EcsReleaseHandlerOptions = {
  sideEffectTimeoutMs?: number;
  rolloutTimeoutMs?: number;
  rollbackTimeoutMs?: number;
  now?: () => Date;
  firstRelease?: {
    dataSource: DataSource;
    bootstrap: InactiveV1FirstReleaseBootstrapAdapter;
  };
};

export class InactiveV1EcsReleaseHandler
implements V1FencedPlaceholderHandler<"intent.release.execute"> {
  readonly messageType = "intent.release.execute" as const;
  readonly sideEffectPolicy = "deployguard.side-effect/v1" as const;
  readonly releasePolicy =
    "deployguard.release-handler/inactive-ecs-release-v1" as const;
  private readonly sideEffectTimeoutMs: number;
  private readonly rolloutTimeoutMs: number;
  private readonly rollbackTimeoutMs: number;
  private readonly now: () => Date;
  private readonly firstRelease?: InactiveV1EcsReleaseHandlerOptions["firstRelease"];

  constructor(
    private readonly mutation: InactiveV1EcsReleaseMutationAdapter,
    private readonly outcomes: InactiveV1EcsReleaseOutcomeCoordinator,
    options: InactiveV1EcsReleaseHandlerOptions = {},
  ) {
    this.sideEffectTimeoutMs = options.sideEffectTimeoutMs ?? 60_000;
    this.rolloutTimeoutMs = options.rolloutTimeoutMs ?? 10 * 60_000;
    this.rollbackTimeoutMs = options.rollbackTimeoutMs ?? 10 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.firstRelease = options.firstRelease;
    if (
      !mutation
      || typeof mutation.mutate !== "function"
      || !outcomes
      || typeof outcomes.coordinate !== "function"
      || !this.validTimeout(this.sideEffectTimeoutMs)
      || !this.validTimeout(this.rolloutTimeoutMs)
      || !this.validTimeout(this.rollbackTimeoutMs)
      || typeof this.now !== "function"
    ) {
      throw new Error("INACTIVE_RELEASE_HANDLER_CONTRACT_INVALID");
    }
  }

  async invoke(
    context: V1FencedPlaceholderHandlerContext<
      "intent.release.execute"
    >,
  ): Promise<V1FencedPlaceholderOutcome> {
    if (this.isInitialRelease(context)) return this.invokeInitialRelease(context);
    const revision = this.revision(context);
    const rootKey = canonicalSha256({
      schemaVersion: 1,
      intentId: context.intent.id,
      canonicalIdempotencyKey: context.intent.canonicalIdempotencyKey,
      revision,
    });
    const execution = context.execution;
    try {
      this.assertTrusted(context);
      await this.mutation.mutate({
        revision,
        mutation: {
          idempotencyKey: rootKey,
          registerTaskDefinitionOperationId:
            this.deterministicOperationId(rootKey, "register-task"),
          updateServiceOperationId:
            this.deterministicOperationId(rootKey, "update-service"),
        },
        fence: {
          intentId: context.intent.id,
          leaseId: context.leaseId,
          workerId: context.workerId,
          fencingToken: context.fencingToken,
        },
        timeoutMs: this.sideEffectTimeoutMs,
        execution,
        sideEffects: context.sideEffects,
      });
      this.assertTrusted(context);
      const now = this.now();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        return this.failure("RELEASE_HANDLER_CLOCK_INVALID");
      }
      const outcome = await this.outcomes.coordinate({
        revision,
        idempotencyKey: rootKey,
        rollbackOperationId:
          this.deterministicOperationId(rootKey, "rollback-service"),
        timeoutMs: this.sideEffectTimeoutMs,
        candidateDeadlineAt:
          new Date(now.getTime() + this.rolloutTimeoutMs),
        rollbackDeadlineAt:
          new Date(now.getTime() + this.rollbackTimeoutMs),
        execution,
        sideEffects: context.sideEffects,
        fence: {
          intentId: context.intent.id,
          leaseId: context.leaseId,
          workerId: context.workerId,
          fencingToken: context.fencingToken,
        },
      });
      this.assertTrusted(context);
      if (
        outcome.disposition === "candidate_promoted"
        || outcome.disposition === "rollback_completed"
      ) {
        return Object.freeze({ outcome: "success" });
      }
      if (
        outcome.disposition === "candidate_progressing"
        || outcome.disposition === "rollback_verification_pending"
      ) {
        return Object.freeze({ outcome: "retryable" });
      }
      if (
        outcome.disposition === "rollback_reconciliation_required"
      ) {
        return this.failure("RELEASE_RECONCILIATION_REQUIRED");
      }
      if (outcome.disposition === "manual_review_required") {
        return this.failure("RELEASE_EVIDENCE_AMBIGUOUS");
      }
      if (outcome.disposition === "rollback_target_missing") {
        return this.failure("RELEASE_ROLLBACK_TARGET_MISSING");
      }
      return this.failure("RELEASE_ROLLBACK_FAILED");
    } catch (error) {
      const finalization = context.sideEffects.finalizationStatus();
      if (!finalization.allowed) {
        return this.failure("RELEASE_RECONCILIATION_REQUIRED");
      }
      if (
        error instanceof V1EcsReleaseMutationError
        && error.code === "ECS_RELEASE_OWNERSHIP_LOST"
      ) {
        return this.failure("RELEASE_OWNERSHIP_LOST");
      }
      if (
        error instanceof V1EcsReleaseOutcomeError
        && error.code === "ECS_RELEASE_OUTCOME_OWNERSHIP_LOST"
      ) {
        return this.failure("RELEASE_OWNERSHIP_LOST");
      }
      if (error instanceof V1EcsReleaseMutationError) {
        return this.failure("RELEASE_MUTATION_FAILED");
      }
      if (error instanceof V1EcsReleaseOutcomeError) {
        return this.failure("RELEASE_OUTCOME_FAILED");
      }
      return this.failure("RELEASE_HANDLER_FAILED");
    }
  }

  private async invokeInitialRelease(context: V1FencedPlaceholderHandlerContext<"intent.release.execute">): Promise<V1FencedPlaceholderOutcome> {
    if (!this.firstRelease) return this.failure("FIRST_RELEASE_NORMAL_HANDLER_DISABLED");
    const release = context.releaseManifest;
    const infrastructure = context.infrastructureManifest;
    if (!release || !infrastructure || release.previousStableManifestId !== null || release.parentManifestId !== null
      || !["desired", "built", "building"].includes(release.status) || infrastructure.status !== "applied"
      || context.intent.classification !== "release_only" || context.intent.releaseManifestId !== release.id) {
      return this.failure("FIRST_RELEASE_NORMAL_CONTEXT_INVALID");
    }
    const draft = await this.firstRelease.dataSource.getRepository(InitialReleaseDraft).findOne({
      where: { projectId: context.intent.projectId, environmentName: context.intent.environmentName, infrastructureManifestId: infrastructure.id },
      order: { createdAt: "ASC" },
    });
    if (!draft || draft.infrastructureRevision !== infrastructure.revision) return this.failure("FIRST_RELEASE_NORMAL_DRAFT_INVALID");
    const root = canonicalSha256({ intentId: context.intent.id, key: context.intent.canonicalIdempotencyKey, draftHash: draft.draftHash });
    try {
      const initialOperations = {
        buildPushOperationId: this.deterministicOperationId(root, "push-image"),
        registerTaskDefinitionOperationId: this.deterministicOperationId(root, "register-task"),
        createServiceOperationId: this.deterministicOperationId(root, "create-service"),
      };
      await this.firstRelease.bootstrap.bootstrap({
        identity: {
          projectId: context.intent.projectId, environmentName: context.intent.environmentName,
          infrastructureManifestId: infrastructure.id, infrastructureRevision: infrastructure.revision,
          intentId: context.intent.id, idempotencyKey: root,
          ...initialOperations,
        },
        releaseDraft: draft.releaseDraft as any,
        timeoutMs: this.sideEffectTimeoutMs,
        execution: context.execution,
        fence: { intentId: context.intent.id, leaseId: context.leaseId, workerId: context.workerId, fencingToken: context.fencingToken },
        sideEffects: context.sideEffects,
      });
      return Object.freeze({ outcome: "success" });
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)
        ? error.message : "FIRST_RELEASE_NORMAL_HANDLER_FAILED";
      return this.failure(code);
    }
  }

  private isInitialRelease(context: V1FencedPlaceholderHandlerContext<"intent.release.execute">) {
    return context.releaseManifest?.previousStableManifestId === null
      && context.releaseManifest?.parentManifestId === null
      && context.intent.classification === "release_only";
  }

  private revision(
    context: V1FencedPlaceholderHandlerContext<
      "intent.release.execute"
    >,
  ): V1EcsReleaseRevisionIdentity {
    const release = context.releaseManifest;
    const infrastructure = context.infrastructureManifest;
    if (
      context.route.messageType !== "intent.release.execute"
      || context.route.lane !== "release"
      || context.route.operation !== "execute"
      || context.intent.classification !== "release_only"
      || context.intent.status !== "running"
      || !release
      || !infrastructure
      || infrastructure.status !== "applied"
      || release.infrastructureManifestId !== infrastructure.id
      || release.id !== context.intent.releaseManifestId
      || infrastructure.id !== context.intent.infrastructureManifestId
      || release.projectId !== context.intent.projectId
      || infrastructure.projectId !== context.intent.projectId
      || release.environmentName !== context.intent.environmentName
      || infrastructure.environmentName !== context.intent.environmentName
    ) {
      throw new Error("INACTIVE_RELEASE_HANDLER_CONTEXT_INVALID");
    }
    return {
      projectId: context.intent.projectId,
      environmentName: context.intent.environmentName,
      releaseManifestId: release.id,
      releaseRevision: release.revision,
      infrastructureManifestId: infrastructure.id,
      infrastructureRevision: infrastructure.revision,
    };
  }

  private assertTrusted(
    context: V1FencedPlaceholderHandlerContext<
      "intent.release.execute"
    >,
  ) {
    if (
      context.execution.signal.aborted
      || !context.execution.isLeaseTrusted()
    ) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_OWNERSHIP_LOST",
      );
    }
  }

  private deterministicOperationId(root: string, operation: string) {
    const hash = canonicalSha256({
      schemaVersion: 1,
      root,
      operation,
    });
    const variant = (parseInt(hash[16], 16) & 0x3) | 0x8;
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}`
      + `-${variant.toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  }

  private validTimeout(value: number) {
    return Number.isInteger(value) && value >= 100 && value <= 3_600_000;
  }

  private failure(safeFailureCode: string) {
    return Object.freeze({
      outcome: "terminal_failure" as const,
      safeFailureCode,
    });
  }
}
