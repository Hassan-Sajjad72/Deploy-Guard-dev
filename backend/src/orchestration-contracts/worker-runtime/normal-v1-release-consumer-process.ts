import {
  NormalV1ReleaseConsumerRuntimeService,
} from "./normal-v1-release-consumer-runtime.service";

export async function superviseNormalV1ReleaseConsumer(input: {
  runtime: NormalV1ReleaseConsumerRuntimeService;
  close(): Promise<void>;
}) {
  const initial = await input.runtime.start();
  if (initial.state === "disabled" || initial.state === "blocked") {
    await input.close();
    // Configuration failures are intentionally non-restartable. The
    // supervisor health record retains the fail-closed reason.
    return 0;
  }

  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  let signalled = false;
  const requestShutdown = () => {
    if (signalled) return;
    signalled = true;
    resolveShutdown();
  };
  const observe = () => input.runtime.observe();
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
  process.on("SIGUSR1", observe);
  try {
    await shutdown;
    await input.runtime.stop();
    await input.close();
    return 0;
  } finally {
    process.removeListener("SIGTERM", requestShutdown);
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGUSR1", observe);
  }
}
