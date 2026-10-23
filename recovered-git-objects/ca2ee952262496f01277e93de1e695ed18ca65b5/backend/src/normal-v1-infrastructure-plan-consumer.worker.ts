import { NestFactory } from "@nestjs/core";
import { NormalV1InfrastructurePlanConsumerModule } from "./normal-v1-infrastructure-plan-consumer.module";
import { NormalV1InfrastructurePlanConsumerRuntimeService } from "./orchestration-contracts/worker-runtime/normal-v1-infrastructure-plan-consumer-runtime.service";
import { NormalV1InfrastructurePlanConsumerHealthFile } from "./orchestration-contracts/worker-runtime/normal-v1-infrastructure-plan-consumer-health";
import { superviseNormalV1InfrastructureConsumer } from "./orchestration-contracts/worker-runtime/normal-v1-infrastructure-consumer-process";

async function main() {
  const app = await NestFactory.createApplicationContext(NormalV1InfrastructurePlanConsumerModule, { abortOnError: false });
  const runtime = app.get(NormalV1InfrastructurePlanConsumerRuntimeService);
  process.exitCode = await superviseNormalV1InfrastructureConsumer({
    runtime,
    close: () => app.close(),
  });
}
main().catch((error: unknown) => {
  const safeCode = error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message) ? error.message : "NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_PROCESS_FAILED";
  new NormalV1InfrastructurePlanConsumerHealthFile().writeFailure(safeCode);
  process.stderr.write(`${JSON.stringify({ state: "blocked", ready: false, safeCode })}\n`);
  process.exitCode = 1;
});
