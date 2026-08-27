import { strict as assert } from "node:assert";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  harness,
  rejected,
} from "./verify-apply-entry-point";

async function main() {
  const unchanged = await harness("valid");
  try {
    await unchanged.service.runInfrastructureApply(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    );
    assert.equal(unchanged.applyCalls, 1);
    assert.deepEqual(unchanged.appliedPlanPaths, [join(unchanged.workdir, "tfplan")]);
    assert.doesNotMatch(JSON.stringify(unchanged.run.metadata), /immutable-saved-plan/);
  } finally {
    await rm(unchanged.workdir, { recursive: true, force: true });
  }

  for (const scenario of [
    "modified_after_init",
    "replaced_after_init",
    "missing_after_init",
    "path_changed_after_init",
    "contract_changed_after_init",
    "input_changed_after_init",
  ] as const) {
    await rejected(scenario, "plan_artifact_changed_before_apply");
  }

  const source = await readFile(
    join(process.cwd(), "src/infrastructure/infrastructure.service.ts"),
    "utf8",
  );
  assert.match(
    source,
    /const verifiedPlanPath = await this\.verifyFinalPlanIntegrity\([\s\S]*?\);\s*await this\.terraformRunner\.runTerraformApply\([^;]*verifiedPlanPath\);/,
  );
  const finalToApply = source.slice(
    source.indexOf("const verifiedPlanPath = await this.verifyFinalPlanIntegrity"),
    source.indexOf("const outputs = await this.terraformRunner.parseOutputs"),
  );
  assert.equal(
    (finalToApply.match(/\bawait\b/g) || []).length,
    2,
    "Only the final verification and immediately following apply executor may be awaited",
  );
  assert.doesNotMatch(finalToApply, /writeFile|runTerraformInit|writeBackendConfig|event\(|audit\(/);

  console.log("Final Terraform plan rehash, replacement, identity, and executor-path verification passed.");
}

void main();
