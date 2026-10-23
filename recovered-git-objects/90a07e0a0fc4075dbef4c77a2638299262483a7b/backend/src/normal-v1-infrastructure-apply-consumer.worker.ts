import { NestFactory } from "@nestjs/core";
import { NormalV1InfrastructureApplyConsumerModule } from "./normal-v1-infrastructure-apply-consumer.module";
import { NormalV1InfrastructureApplyConsumerRuntimeService } from "./orchestration-contracts/worker-runtime/normal-v1-infrastructure-apply-consumer-runtime.service";
import { NormalV1InfrastructureApplyConsumerHealthFile } from "./orchestration-contracts/worker-runtime/normal-v1-infrastructure-apply-consumer-health";
import { superviseNormalV1InfrastructureConsumer } from "./orchestration-contracts/worker-runtime/normal-v1-infrastructure-consumer-process";

async function main() {
  const app = await NestFactory.createApplicationContext(
    NormalV1InfrastructureApplyConsumerModule,
    { abortOnError: false },
  );
  const runtime = app.get(NormalV1InfrastructureApplyConsumerRuntimeService);
  process.exitCode = await superviseNormalV1InfrastructureConsumer({
    runtime,
    close: () => app.close(),
  });
}

main().catch((error: unknown) => {
  const safeCode = error instanceof Error
    && /^[A-Z0-9_]{3,128}$/.test(error.message)
    ? error.message
    : "NORMAL_V1_INFRASTRUCTURE_APPLY_CONSUMER_PROCESS_FAILED";
  new NormalV1InfrastructureApplyConsumerHealthFile().writeFailure(safeCode);
  process.stderr.write(`${JSON.stringify({
    state: "blocked",
    ready: false,
    safeCode,
  })}\n`);
  process.exitCode = 1;
});
