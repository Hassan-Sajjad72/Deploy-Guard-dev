import { strict as assert } from "node:assert";
import { cp, mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

void (async () => {
  const root = join(__dirname, "..", "..");
  const workspace = await mkdtemp(join(tmpdir(), "deployguard-materialization-"));
  try {
    const deployguard = join(workspace, ".deployguard");
    await mkdir(deployguard, { recursive: true });
    await cp(join(root, "infrastructure", "railpack-runtime"), join(deployguard, "terraform"), { recursive: true });
    assert.equal((await stat(join(deployguard, "terraform"))).isDirectory(), true);
    assert.equal((await stat(join(deployguard, "terraform", "main.tf"))).isFile(), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  const workflow = readFileSync(join(root, ".github", "workflows", "deployguard-reusable.yml"), "utf8");
  assert.match(workflow, /mkdir -p \.deployguard\/terraform; cp -R \/tmp\/deployguard-control-plane\/infrastructure\/railpack-runtime\/\. \.deployguard\/terraform\//);
  console.log("RAILPACK_MATERIALIZATION_WORKSPACE=PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; });
