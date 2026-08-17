type InfrastructureConsumerStatus = Readonly<{
  state: string;
}>;

type InfrastructureConsumerRuntime = Readonly<{
  start(): Promise<InfrastructureConsumerStatus>;
  stop(): Promise<InfrastructureConsumerStatus>;
  observe(): InfrastructureConsumerStatus;
}>;

/**
 * Signal supervision shared by the two infrastructure-only roles. Handlers
 * are installed before start so a supervisor cannot terminate the process in
 * the narrow ready-before-handler window.
 */
export async function superviseNormalV1InfrastructureConsumer(input: {
  runtime: InfrastructureConsumerRuntime;
  close(): Promise<void>;
}) {
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
    const initial = await input.runtime.start();
    if (initial.state === "disabled" || initial.state === "blocked") {
      await input.close();
      return 0;
    }
    await shutdown;
    await input.runtime.stop();
    await input.close();
    return 0;
  } catch (error) {
    await input.close();
    throw error;
  } finally {
    process.removeListener("SIGTERM", requestShutdown);
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGUSR1", observe);
  }
}
