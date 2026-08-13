import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { ECRClient } from "@aws-sdk/client-ecr";
import { ECSClient } from "@aws-sdk/client-ecs";
import AppDataSource from "../src/data-source";
import { TerminalOutboxPolicyService } from "../src/orchestration-contracts/outbox/terminal-outbox-policy.service";
import { CrossLaneOwnershipEnforcementService } from "../src/orchestration-contracts/release-lane/cross-lane-ownership-enforcement.service";
import { InactiveReleaseLaneCorrelationService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-correlation.service";
import { InactiveReleaseLaneOwnershipService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.service";
import { InactiveV1BullMqConsumerService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-bullmq-consumer.service";
import { InactiveV1ExecutionLeaseHeartbeatService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-execution-lease-heartbeat.service";
import { InactiveV1FencedInvocationService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-fenced-invocation.service";
import { InactiveV1HandlerSideEffectSafetyService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-handler-side-effect-safety.service";
import { InactiveV1PreExecutionOwnershipService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-pre-execution-ownership.service";
import { InactiveV1WorkerRuntimeService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.service";
import { NormalV1ReleaseConsumerRuntimeService } from "../src/orchestration-contracts/worker-runtime/normal-v1-release-consumer-runtime.service";
import { NormalReleaseLaneAutoConvergenceScheduler } from "../src/orchestration-contracts/worker-runtime/normal-release-lane-auto-convergence.scheduler";
import { NormalReleaseLaneConvergenceService } from "../src/orchestration-contracts/release-lane/normal-release-lane-convergence.service";
import { ReleaseManifest } from "../src/orchestration-contracts/entities/release-manifest.entity";
import { ReleaseImageProvenance } from "../src/orchestration-contracts/entities/release-image-provenance.entity";
import { DeploymentSideEffect } from "../src/orchestration-contracts/entities/deployment-side-effect.entity";
import { superviseNormalV1ReleaseConsumer } from "../src/orchestration-contracts/worker-runtime/normal-v1-release-consumer-process";
import { NormalV1ReleaseConsumerHealthFile } from "../src/orchestration-contracts/worker-runtime/normal-v1-release-consumer-health";
import {
  V1FencedPlaceholderHandler,
} from "../src/orchestration-contracts/worker-runtime/v1-fenced-invocation.types";
import {
  buildV1FencedPlaceholderHandlerRegistry,
  V1_FENCED_PLACEHOLDER_HANDLERS,
} from "../src/orchestration-contracts/worker-runtime/v1-placeholder-handlers";
import { V1WorkerCapabilityService } from "../src/orchestration-contracts/worker-runtime/v1-worker-capability.service";

async function main() {
  const config = new ConfigService(process.env);
  // The compiled fixture uses the current entity schema and deliberately does
  // not execute the repository's unrelated source-form migration bootstrap.
  AppDataSource.setOptions({ migrations: [] });
  await AppDataSource.initialize();
  if (config.get<unknown>("NORMAL_V1_ISOLATED_AUTO_CONVERGENCE_FIXTURE") === "true") {
    const digest = `sha256:${"6".repeat(64)}`;
    (ECRClient.prototype as any).send = async () => ({
      imageDetails: [{ imageDigest: digest }],
    });
    (ECSClient.prototype as any).send = async (command: {
      input?: { cluster?: string; services?: string[] };
    }) => {
      const clusterArn = command.input?.cluster;
      const serviceArn = command.input?.services?.[0];
      return {
        failures: [],
        services: [{
          status: "ACTIVE",
          clusterArn,
          serviceArn,
          taskDefinition: "isolated-task-definition",
          runningCount: 1,
          desiredCount: 1,
          pendingCount: 0,
          deployments: [{
            status: "PRIMARY",
            taskDefinition: "isolated-task-definition",
            rolloutState: "COMPLETED",
          }],
        }],
      };
    };
  }
  const terminalOutbox = new TerminalOutboxPolicyService();
  const capabilities = new V1WorkerCapabilityService(AppDataSource);
  const workerRuntime = new InactiveV1WorkerRuntimeService(
    AppDataSource,
    capabilities,
    config,
  );
  const ownership = new InactiveV1PreExecutionOwnershipService(
    AppDataSource,
    workerRuntime,
    terminalOutbox,
  );
  const releaseOwnership =
    new InactiveReleaseLaneOwnershipService(AppDataSource);
  const correlation =
    new InactiveReleaseLaneCorrelationService(AppDataSource);
  const crossLane = new CrossLaneOwnershipEnforcementService(
    config,
    releaseOwnership,
    correlation,
    AppDataSource,
  );
  const releaseHandler: V1FencedPlaceholderHandler<
    "intent.release.execute"
  > = {
    messageType: "intent.release.execute",
    sideEffectPolicy: "deployguard.side-effect/v1",
    async invoke(context) {
      if (
        context.execution.signal.aborted
        || !context.execution.isLeaseTrusted()
      ) {
        return {
          outcome: "terminal_failure",
          safeFailureCode: "MOCK_HANDLER_OWNERSHIP_LOST",
        };
      }
      const autoConvergence = config.get<unknown>(
        "NORMAL_V1_ISOLATED_AUTO_CONVERGENCE_FIXTURE",
      ) === "true";
      if (autoConvergence) {
        if (!context.releaseManifest || !context.infrastructureManifest) {
          return {
            outcome: "terminal_failure",
            safeFailureCode: "ISOLATED_CONVERGENCE_CONTEXT_INVALID",
          };
        }
        const [attempt] = await AppDataSource.query(
          `INSERT INTO normal_v1_mock_handler_attempts (intent_id)
           VALUES ($1) RETURNING sequence`,
          [context.intent.id],
        );
        if (attempt.sequence === 1) {
          const digest = `sha256:${"6".repeat(64)}`;
          const release = await AppDataSource.getRepository(ReleaseManifest)
            .findOneByOrFail({ id: context.releaseManifest.id });
          release.status = "deploying";
          release.imageUri = "isolated.invalid/repository";
          release.imageDigest = digest;
          release.taskDefinitionArn = "isolated-task-definition";
          await AppDataSource.getRepository(ReleaseManifest).save(release);
          await AppDataSource.getRepository(ReleaseImageProvenance).save({
            intentId: context.intent.id,
            operationId: randomUUID(),
            idempotencyKey: "7".repeat(64),
            projectId: context.intent.projectId,
            environmentName: "dev",
            infrastructureManifestId: context.infrastructureManifest!.id,
            infrastructureRevision: context.infrastructureManifest!.revision,
            commitSha: context.releaseManifest!.commitSha,
            buildFingerprint: "8".repeat(64),
            imageUri: "isolated.invalid/repository",
            imageDigest: digest,
            evidenceFingerprint: "9".repeat(64),
          });
          for (const [index, effectType] of [
            "ecr.build_push_immutable_image",
            "ecs.register_task_definition_revision",
            "ecs.update_existing_service",
          ].entries()) {
            await AppDataSource.getRepository(DeploymentSideEffect).save({
              intentId: context.intent.id,
              projectId: context.intent.projectId,
              environmentName: "dev",
              operationId: randomUUID(),
              effectType,
              idempotencyKey: String(index).repeat(64),
              requestFingerprint: String(index + 1).repeat(64),
              leaseId: context.leaseId,
              ownerWorkerId: context.workerId,
              fencingToken: context.fencingToken,
              status: "succeeded",
              safeResultCode: "ISOLATED_EFFECT_SUCCEEDED",
              resultFingerprint: "a".repeat(64),
              externalReferenceHash: "b".repeat(64),
              failureCode: null,
              reconciliationRequired: false,
              attemptStartedAt: new Date(),
              deadlineAt: new Date(),
              completedAt: new Date(),
            });
          }
          return {
            outcome: "terminal_failure",
            safeFailureCode: "RELEASE_EVIDENCE_AMBIGUOUS",
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
        return { outcome: "success" };
      }
      const rows = await AppDataSource.query(
        `INSERT INTO normal_v1_mock_handler_calls (
           intent_id, message_type, result_code
         ) VALUES ($1, $2, 'MOCK_RELEASE_COMPLETED')
         ON CONFLICT (intent_id) DO NOTHING
         RETURNING intent_id`,
        [context.intent.id, context.route.messageType],
      );
      if (rows.length !== 1) {
        return {
          outcome: "terminal_failure",
          safeFailureCode: "MOCK_HANDLER_DUPLICATE_INVOCATION",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      if (
        context.execution.signal.aborted
        || !context.execution.isLeaseTrusted()
      ) {
        return {
          outcome: "terminal_failure",
          safeFailureCode: "MOCK_HANDLER_OWNERSHIP_LOST",
        };
      }
      return { outcome: "success" };
    },
  };
  const handlers = buildV1FencedPlaceholderHandlerRegistry(
    V1_FENCED_PLACEHOLDER_HANDLERS.map((handler) =>
      handler.messageType === "intent.release.execute"
        ? releaseHandler
        : handler
    ) as readonly V1FencedPlaceholderHandler[],
  );
  const leaseHeartbeat =
    new InactiveV1ExecutionLeaseHeartbeatService(ownership);
  const invocation = new InactiveV1FencedInvocationService(
    AppDataSource,
    ownership,
    handlers,
    leaseHeartbeat,
    new InactiveV1HandlerSideEffectSafetyService(AppDataSource),
    crossLane,
  );
  const consumer = new InactiveV1BullMqConsumerService(
    invocation,
    capabilities,
    undefined,
    crossLane,
  );
  const projectAllowlist = config
    .get<string>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST", "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const composition = {
    configuration: {
      workerId: config.get<string>(
        "TWO_LANE_RELEASE_WORKER_ID",
        "isolated-normal-v1-consumer",
      ),
      projectAllowlist,
      environmentAllowlist: ["dev"],
    },
    consumer,
    laterReleaseImageClient: Object.freeze({
      policy: "isolated-production-shaped-mock",
    }),
  };
  const runtime = new NormalV1ReleaseConsumerRuntimeService(
    config,
    {
      getStatus: () => ({
        state: "ready",
        mode: "production_canary",
      }),
      getInactiveComposition: () => composition,
    } as never,
    new NormalReleaseLaneAutoConvergenceScheduler(
      config,
      new NormalReleaseLaneConvergenceService(AppDataSource, config),
    ),
  );
  process.exitCode = await superviseNormalV1ReleaseConsumer({
    runtime,
    close: async () => {
      if (AppDataSource.isInitialized) await AppDataSource.destroy();
    },
  });
}

main().catch((error: unknown) => {
  const diagnosticCode = typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    && /^[A-Z0-9_]{3,20}$/i.test(error.code)
    ? error.code.toUpperCase()
    : null;
  const safeCode = error instanceof Error
    && /^[A-Z0-9_]{3,128}$/.test(error.message)
    ? error.message
    : AppDataSource.isInitialized
      ? "ISOLATED_NORMAL_V1_CONSUMER_RUNTIME_FAILED"
      : diagnosticCode
        ? `ISOLATED_NORMAL_V1_CONSUMER_DATABASE_${diagnosticCode}`
        : "ISOLATED_NORMAL_V1_CONSUMER_DATABASE_FAILED";
  new NormalV1ReleaseConsumerHealthFile().writeFailure(safeCode);
  process.stderr.write(`${JSON.stringify({
    state: "blocked",
    safeCode,
  })}\n`);
  process.exitCode = 1;
});
