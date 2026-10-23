import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXECUTABLE_V1_MESSAGE_TYPES,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.types";
import {
  V1FencedPlaceholderHandler,
} from "../src/orchestration-contracts/worker-runtime/v1-fenced-invocation.types";
import {
  buildV1FencedPlaceholderHandlerRegistry,
  V1_FENCED_PLACEHOLDER_HANDLERS,
} from "../src/orchestration-contracts/worker-runtime/v1-placeholder-handlers";

const registry = buildV1FencedPlaceholderHandlerRegistry();
assert.equal(registry.size, EXECUTABLE_V1_MESSAGE_TYPES.length);
for (const messageType of EXECUTABLE_V1_MESSAGE_TYPES) {
  const handler = registry.get(messageType);
  assert.ok(handler);
  assert.equal(handler.messageType, messageType);
  assert.equal(handler.sideEffectPolicy, "deployguard.side-effect/v1");
}

assert.throws(
  () => buildV1FencedPlaceholderHandlerRegistry([
    {
      ...V1_FENCED_PLACEHOLDER_HANDLERS[0],
      sideEffectPolicy: "unsafe",
    } as unknown as V1FencedPlaceholderHandler,
    ...V1_FENCED_PLACEHOLDER_HANDLERS.slice(1),
  ]),
  /Unsafe v1 handler side-effect policy/,
);
assert.throws(
  () => buildV1FencedPlaceholderHandlerRegistry([
    V1_FENCED_PLACEHOLDER_HANDLERS[0],
    V1_FENCED_PLACEHOLDER_HANDLERS[0],
    ...V1_FENCED_PLACEHOLDER_HANDLERS.slice(1),
  ]),
  /Duplicate v1 fenced placeholder handler/,
);
assert.throws(
  () => buildV1FencedPlaceholderHandlerRegistry(
    V1_FENCED_PLACEHOLDER_HANDLERS.slice(1) as readonly
      V1FencedPlaceholderHandler[],
  ),
  /Missing v1 fenced placeholder handler/,
);
assert.throws(
  () => buildV1FencedPlaceholderHandlerRegistry([
    ...V1_FENCED_PLACEHOLDER_HANDLERS,
    {
      messageType: "outbox.reconcile",
      sideEffectPolicy: "deployguard.side-effect/v1",
      invoke: () => ({ outcome: "success" }),
    } as unknown as V1FencedPlaceholderHandler,
  ]),
  /Unexpected v1 fenced placeholder handler registration/,
);

const runtimeRoot = join(
  process.cwd(),
  "src",
  "orchestration-contracts",
  "worker-runtime",
);
const sourceFiles = [
  "inactive-v1-fenced-invocation.service.ts",
  "v1-fenced-invocation.types.ts",
  "v1-placeholder-handlers.ts",
].map((file) => readFileSync(join(runtimeRoot, file), "utf8"));
const moduleSource = readFileSync(
  join(
    process.cwd(),
    "src",
    "orchestration-contracts",
    "orchestration-contracts.module.ts",
  ),
  "utf8",
);
for (const source of [...sourceFiles, moduleSource]) {
  assert.doesNotMatch(source, /\bnew\s+Worker\s*\(/);
  assert.doesNotMatch(
    source,
    /OnModuleInit|OnApplicationBootstrap|@Cron|ScheduleModule/,
  );
}
for (const source of sourceFiles) {
  assert.doesNotMatch(
    source,
    /from ["'][^"']*(terraform|ecs|aws|docker|pipeline-worker|pipeline\.worker)/i,
  );
}
assert.doesNotMatch(
  sourceFiles.join("\n"),
  /Controller|BullMQ|@aws-sdk|child_process/,
);

console.log("Inactive v1 fenced invocation pure verification passed");
