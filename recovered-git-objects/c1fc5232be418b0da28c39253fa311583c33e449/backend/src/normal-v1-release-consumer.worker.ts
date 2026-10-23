import { NestFactory } from "@nestjs/core";
import {
  NormalV1ReleaseConsumerModule,
} from "./normal-v1-release-consumer.module";
import {
  NormalV1ReleaseConsumerRuntimeService,
} from "./orchestration-contracts/worker-runtime/normal-v1-release-consumer-runtime.service";
import {
  superviseNormalV1ReleaseConsumer,
} from "./orchestration-contracts/worker-runtime/normal-v1-release-consumer-process";
import {
  NormalV1ReleaseConsumerHealthFile,
} from "./orchestration-contracts/worker-runtime/normal-v1-release-consumer-health";

async function main() {
  const app = await NestFactory.createApplicationContext(
    NormalV1ReleaseConsumerModule,
    { abortOnError: false },
  );
  const runtime = app.get(NormalV1ReleaseConsumerRuntimeService);
  process.exitCode = await superviseNormalV1ReleaseConsumer({
    runtime,
    close: () => app.close(),
  });
}

main().catch((error: unknown) => {
  const safeCode = error instanceof Error
    && /^[A-Z0-9_]{3,128}$/.test(error.message)
    ? error.message
    : "NORMAL_V1_RELEASE_CONSUMER_PROCESS_FAILED";
  new NormalV1ReleaseConsumerHealthFile().writeFailure(safeCode);
  process.stderr.write(`${JSON.stringify({
    state: "blocked",
    ready: false,
    safeCode,
  })}\n`);
  process.exitCode = 1;
});
