import { strict as assert } from "node:assert";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InfracostService } from "../src/finops/infracost.service";

async function failure(service: InfracostService, workdir: string) {
  try {
    await service.runInfracostBreakdown("{}", workdir);
    assert.fail("The fake Infracost provider should fail.");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function run() {
  const directory = await mkdtemp(join(tmpdir(), "deployguard-infracost-diagnostic-"));
  const executable = join(directory, "infracost");
  const credential = "test-infracost-credential-that-must-never-be-reported";
  const service = new InfracostService({
    get: (key: string, fallback?: string) => key === "INFRACOST_API_KEY" ? credential : key === "INFRACOST_CLI_PATH" ? executable : fallback,
  } as never);
  try {
    await writeFile(executable, "#!/bin/sh\necho 'failed to log in: not logged in — set INFRACOST_CLI_AUTHENTICATION_TOKEN' >&2\nexit 1\n");
    await chmod(executable, 0o700);
    assert.match(await failure(service, directory), /^INFRACOST_AUTHENTICATION_REQUIRED \(exit 1\):/);

    await writeFile(executable, `#!/bin/sh\necho 'Unauthorized ${credential}' >&2\nexit 1\n`);
    const rejected = await failure(service, directory);
    assert.match(rejected, /^INFRACOST_AUTHENTICATION_REJECTED \(exit 1\):/);
    assert.doesNotMatch(rejected, new RegExp(credential));

    await writeFile(executable, "#!/bin/sh\necho 'dial tcp: lookup pricing provider: ENOTFOUND' >&2\nexit 1\n");
    assert.match(await failure(service, directory), /^INFRACOST_PROVIDER_CONNECTIVITY_FAILED \(exit 1\):/);
    console.log("Infracost CLI diagnostic classification and credential redaction passed.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
