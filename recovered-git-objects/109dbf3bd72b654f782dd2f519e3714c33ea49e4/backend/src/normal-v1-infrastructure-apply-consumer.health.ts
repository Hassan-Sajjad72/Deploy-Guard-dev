import {
  NormalV1InfrastructureApplyConsumerHealthFile,
} from "./orchestration-contracts/worker-runtime/normal-v1-infrastructure-apply-consumer-health";

const mode = process.argv[2];
if (!mode || !["status", "readiness", "liveness"].includes(mode)) {
  process.stderr.write(`${JSON.stringify({
    state: "failed",
    ready: false,
    live: false,
    safeCode: "NORMAL_V1_INFRASTRUCTURE_APPLY_CONSUMER_HEALTH_MODE_INVALID",
  })}\n`);
  process.exitCode = 2;
} else {
  const health = new NormalV1InfrastructureApplyConsumerHealthFile().read();
  process.stdout.write(`${JSON.stringify(health)}\n`);
  if (mode === "readiness") process.exitCode = health.ready ? 0 : 1;
  if (mode === "liveness") process.exitCode = health.live ? 0 : 1;
}
