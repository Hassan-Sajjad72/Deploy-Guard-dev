import { strict as assert } from "node:assert";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBoundedSourceCheckout } from "../src/projects/repository-source.service";

async function verify() {
  const root = await mkdtemp(join(tmpdir(), "deployguard-source-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "deployguard-source-outside-"));
  try {
    await writeFile(join(root, "package.json"), "{}");
    await assertBoundedSourceCheckout(root, ["package.json"]);
    await symlink(join(root, "package.json"), join(root, "inside-link"));
    await assertBoundedSourceCheckout(root, ["package.json", "inside-link"]);
    await writeFile(join(outside, "template"), "PRIVATE_VALUE=must-not-read");
    await symlink(join(outside, "template"), join(root, ".env.example"));
    await assert.rejects(() => assertBoundedSourceCheckout(root, [".env.example"]), /escaping symlink/);
    await assert.rejects(() => assertBoundedSourceCheckout(root, ["../template"]), /unsafe tracked path/);
    await assert.rejects(() => assertBoundedSourceCheckout(root, Array(5001).fill("package.json")), /5,000-file/);
    await truncate(join(root, "package.json"), 200 * 1024 * 1024 + 1);
    await assert.rejects(() => assertBoundedSourceCheckout(root, ["package.json"]), /200 MiB/);
    console.log("Source analysis boundary checks passed: safe symlinks, escaped templates, traversal, file count and source size.");
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
}
verify().catch((error) => { console.error(error); process.exitCode = 1; });
