import { NestFactory } from "@nestjs/core";
import { NormalV1InfrastructureApplyConsumerModule } from "./normal-v1-infrastructure-apply-consumer.module";
import { NormalV1InfrastructureApplyConsumerRuntimeService } from "./orchestration-contracts/worker-runtime/normal-v1-infrastructure-apply-consumer-runtime.service";
void (async () => { const app = await NestFactory.createApplicationContext(NormalV1InfrastructureApplyConsumerModule, { abortOnError: false }); const runtime = app.get(NormalV1InfrastructureApplyConsumerRuntimeService); const initial = await runtime.start(); process.stdout.write(`${JSON.stringify(initial)}\n`); if (!initial.ready) { await app.close(); return; } await new Promise<void>((resolve) => { const stop = () => resolve(); process.once("SIGTERM", stop); process.once("SIGINT", stop); process.on("SIGUSR1", () => runtime.observe()); }); await runtime.stop(); await app.close(); })().catch((error: unknown) => {
  // Process supervision receives a stable code without leaking database, Redis,
  // queue, or provider details from a startup exception.
  const messageCode = error instanceof Error
    ? error.message.match(/\b[A-Z][A-Z0-9_]{3,119}\b/)?.[0]
    : undefined;
  const kind = messageCode
    || (error instanceof Error && /^[A-Za-z0-9_]{1,80}$/.test(error.name) ? error.name : "UnknownError");
  process.stderr.write(`NORMAL_V1_INFRASTRUCTURE_APPLY_CONSUMER_START_FAILED:${kind}\n`);
  process.exitCode = 1;
});
