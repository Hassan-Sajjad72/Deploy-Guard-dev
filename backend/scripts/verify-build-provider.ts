import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployGuardBuildProvider, RAILPACK_PROVIDER_STATUS } from "../src/projects/detection/build-provider.service";
import { MainstreamDetectorResolverService } from "../src/projects/detection/mainstream-detector-resolver.service";

const root = mkdtempSync(join(tmpdir(), "deployguard-provider-"));
try {
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "5" } }));
  writeFileSync(join(root, "server.js"), "const app=require('express')();app.listen(process.env.PORT||3000,'0.0.0.0')");
  const provider = new DeployGuardBuildProvider(new MainstreamDetectorResolverService());
  const resolved = provider.resolve(root, new Set(["package.json", "server.js"]));
  assert.equal(provider.id, "deployguard-generated/v1");
  assert.equal(resolved.result?.detectorId, "javascript.express");
  assert.match(RAILPACK_PROVIDER_STATUS, /^DEFERRED/);
  console.log("Build-provider boundary passed: generated provider compiles detector evidence into the sole BuildPlan input; Railpack is intentionally deferred without a pinned executable.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
