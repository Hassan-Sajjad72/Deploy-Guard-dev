import {
  EXECUTABLE_V1_MESSAGE_TYPES,
  ExecutableV1MessageType,
  V1PlaceholderHandler,
  V1PlaceholderHandlerContext,
  V1PlaceholderHandlerResult,
} from "./inactive-v1-worker-runtime.types";
import {
  V1FencedPlaceholderHandler,
  V1FencedPlaceholderHandlerContext,
  V1FencedPlaceholderOutcome,
} from "./v1-fenced-invocation.types";

function placeholderHandler<TMessage extends ExecutableV1MessageType>(
  messageType: TMessage,
): V1PlaceholderHandler<TMessage> {
  return Object.freeze({
    messageType,
    handle(
      context: V1PlaceholderHandlerContext<TMessage>,
    ): V1PlaceholderHandlerResult<TMessage> {
      return Object.freeze({
        disposition: "placeholder_routed",
        handler: messageType,
        workerId: context.workerId,
        intentId: context.intent.id,
        projectId: context.intent.projectId,
        messageType,
      });
    },
  });
}

export const V1_PLACEHOLDER_HANDLERS = Object.freeze([
  placeholderHandler("intent.release.execute"),
  placeholderHandler("intent.infrastructure.plan"),
  placeholderHandler("intent.infrastructure.apply"),
  placeholderHandler("intent.deletion.execute"),
]);

export function buildV1PlaceholderHandlerRegistry(
  handlers: readonly V1PlaceholderHandler[] = V1_PLACEHOLDER_HANDLERS,
) {
  const registry = new Map<ExecutableV1MessageType, V1PlaceholderHandler>();
  for (const handler of handlers) {
    if (registry.has(handler.messageType)) {
      throw new Error(`Duplicate v1 placeholder handler: ${handler.messageType}`);
    }
    registry.set(handler.messageType, handler);
  }
  for (const messageType of EXECUTABLE_V1_MESSAGE_TYPES) {
    if (!registry.has(messageType)) {
      throw new Error(`Missing v1 placeholder handler: ${messageType}`);
    }
  }
  if (registry.size !== EXECUTABLE_V1_MESSAGE_TYPES.length) {
    throw new Error("Unexpected v1 placeholder handler registration.");
  }
  return registry;
}

function fencedPlaceholderHandler<
  TMessage extends ExecutableV1MessageType,
>(
  messageType: TMessage,
): V1FencedPlaceholderHandler<TMessage> {
  return Object.freeze({
    messageType,
    sideEffectPolicy: "deployguard.side-effect/v1" as const,
    invoke(
      _context: V1FencedPlaceholderHandlerContext<TMessage>,
    ): V1FencedPlaceholderOutcome {
      if (messageType === "intent.deletion.execute") {
        return Object.freeze({ outcome: "retryable" });
      }
      return Object.freeze({ outcome: "success" });
    },
  });
}

export const V1_FENCED_PLACEHOLDER_HANDLERS = Object.freeze([
  fencedPlaceholderHandler("intent.release.execute"),
  fencedPlaceholderHandler("intent.infrastructure.plan"),
  fencedPlaceholderHandler("intent.infrastructure.apply"),
  fencedPlaceholderHandler("intent.deletion.execute"),
]);

export function buildV1FencedPlaceholderHandlerRegistry(
  handlers: readonly V1FencedPlaceholderHandler[] =
    V1_FENCED_PLACEHOLDER_HANDLERS,
) {
  const registry = new Map<
    ExecutableV1MessageType,
    V1FencedPlaceholderHandler
  >();
  for (const handler of handlers) {
    if (handler.sideEffectPolicy !== "deployguard.side-effect/v1") {
      throw new Error(
        `Unsafe v1 handler side-effect policy: ${handler.messageType}`,
      );
    }
    if (registry.has(handler.messageType)) {
      throw new Error(
        `Duplicate v1 fenced placeholder handler: ${handler.messageType}`,
      );
    }
    registry.set(handler.messageType, handler);
  }
  for (const messageType of EXECUTABLE_V1_MESSAGE_TYPES) {
    if (!registry.has(messageType)) {
      throw new Error(
        `Missing v1 fenced placeholder handler: ${messageType}`,
      );
    }
  }
  if (registry.size !== EXECUTABLE_V1_MESSAGE_TYPES.length) {
    throw new Error("Unexpected v1 fenced placeholder handler registration.");
  }
  return registry;
}

export function buildV1InactiveReleaseHandlerRegistry(
  releaseHandler: V1FencedPlaceholderHandler<"intent.release.execute"> & {
    readonly releasePolicy:
      "deployguard.release-handler/inactive-ecs-release-v1";
  },
) {
  if (
    !releaseHandler
    || releaseHandler.messageType !== "intent.release.execute"
    || releaseHandler.sideEffectPolicy !== "deployguard.side-effect/v1"
    || releaseHandler.releasePolicy
      !== "deployguard.release-handler/inactive-ecs-release-v1"
  ) {
    throw new Error("Invalid inactive v1 release handler.");
  }
  return buildV1FencedPlaceholderHandlerRegistry([
    releaseHandler,
    ...V1_FENCED_PLACEHOLDER_HANDLERS.filter(
      (handler) => handler.messageType !== "intent.release.execute",
    ),
  ]);
}

export function buildV1InactiveInfrastructurePlanHandlerRegistry(
  planHandler: V1FencedPlaceholderHandler<"intent.infrastructure.plan"> & {
    readonly infrastructurePlanPolicy:
      "deployguard.infrastructure-plan-handler/inactive-v1";
  },
) {
  if (
    !planHandler
    || planHandler.messageType !== "intent.infrastructure.plan"
    || planHandler.sideEffectPolicy !== "deployguard.side-effect/v1"
    || planHandler.infrastructurePlanPolicy
      !== "deployguard.infrastructure-plan-handler/inactive-v1"
  ) {
    throw new Error("Invalid inactive v1 infrastructure plan handler.");
  }
  return buildV1FencedPlaceholderHandlerRegistry([
    planHandler,
    ...V1_FENCED_PLACEHOLDER_HANDLERS.filter(
      (handler) => handler.messageType !== "intent.infrastructure.plan",
    ),
  ]);
}

export function buildV1InactiveInfrastructureApplyHandlerRegistry(
  applyHandler: V1FencedPlaceholderHandler<"intent.infrastructure.apply"> & {
    readonly infrastructureApplyPolicy: "deployguard.infrastructure-apply-handler/inactive-v1";
  },
) {
  if (!applyHandler || applyHandler.messageType !== "intent.infrastructure.apply"
    || applyHandler.sideEffectPolicy !== "deployguard.side-effect/v1"
    || applyHandler.infrastructureApplyPolicy !== "deployguard.infrastructure-apply-handler/inactive-v1") {
    throw new Error("Invalid inactive v1 infrastructure apply handler.");
  }
  return buildV1FencedPlaceholderHandlerRegistry([
    applyHandler,
    ...V1_FENCED_PLACEHOLDER_HANDLERS.filter((handler) => handler.messageType !== "intent.infrastructure.apply"),
  ]);
}
