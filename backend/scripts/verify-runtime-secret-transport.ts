import { strict as assert } from "node:assert";
import { runtimeSecretRequestHandler } from "../src/projects/github-actions-runtime-secret.service";

async function main() {
  const handler = runtimeSecretRequestHandler() as unknown as {
    configProvider: Promise<{ connectionTimeout: number; socketTimeout: number; httpsAgent: { options: { family?: number } } }>;
  };
  const config = await handler.configProvider;
  assert.equal(config.httpsAgent.options.family, 4, "runtime secrets must use IPv4 on this host");
  assert.equal(config.connectionTimeout, 10_000);
  assert.equal(config.socketTimeout, 30_000);
  console.log("RUNTIME_SECRET_TRANSPORT=PASS IPV4=1");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
