import { NestFactory } from "@nestjs/core";
import { NormalV1InfrastructurePlanConsumerModule } from "./normal-v1-infrastructure-plan-consumer.module";
import { NormalV1InfrastructurePlanConsumerRuntimeService } from "./orchestration-contracts/worker-runtime/normal-v1-infrastructure-plan-consumer-runtime.service";
import { NormalV1InfrastructurePlanConsumerHealthFile } from "./orchestration-contracts/worker-runtime/normal-v1-infrastructure-plan-consumer-health";

async function main() {
  const app = await NestFactory.createApplicationContext(NormalV1InfrastructurePlanConsumerModule, { abortOnError: false });
  const runtime = app.get(NormalV1InfrastructurePlanConsumerRuntimeService);
  const initial = await runtime.start();
  if (initial.state === "disabled" || initial.state === "blocked") { await app.close(); return; }
  let shutdown: (() => void) | null = null;
  const done = new Promise<void>((resolve) => { shutdown = resolve; });
  const stop = () => shutdown?.();
  const observe = () => runtime.observe();
  process.once("SIGTERM", stop); process.once("SIGINT", stop); process.on("SIGUSR1", observe);
  await done;
  await runtime.stop();
  await app.close();
  process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); process.removeListener("SIGUSR1", observe);
}
main().catch((error: unknown) => {
  const safeCode = error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message) ? error.message : "NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_PROCESS_FAILED";
  new NormalV1InfrastructurePlanConsumerHealthFile().writeFailure(safeCode);
  process.stderr.write(`${JSON.stringify({ state: "blocked", ready: false, safeCode })}\n`);
  process.exitCode = 1;
});
