import {
  NormalV1ReleaseConsumerHealthFile,
} from "./orchestration-contracts/worker-runtime/normal-v1-release-consumer-health";

type Mode = "status" | "readiness" | "liveness";

function main() {
  const mode = process.argv[2] as Mode | undefined;
  if (!mode || !["status", "readiness", "liveness"].includes(mode)) {
    process.stderr.write(
      '{"state":"failed","ready":false,"live":false,'
        + '"safeCode":"NORMAL_V1_RELEASE_CONSUMER_HEALTH_MODE_INVALID"}\n',
    );
    process.exitCode = 2;
    return;
  }
  const health = new NormalV1ReleaseConsumerHealthFile().read();
  process.stdout.write(`${JSON.stringify(health)}\n`);
  if (mode === "readiness") process.exitCode = health.ready ? 0 : 1;
  if (mode === "liveness") process.exitCode = health.live ? 0 : 1;
}

main();
