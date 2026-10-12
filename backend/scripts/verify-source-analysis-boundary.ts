import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBoundedSourceCheckout, RepositorySourceService } from "../src/projects/repository-source.service";

const git = promisify(execFile);

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
    const source = join(outside, "repository"), hooks = join(outside, "hooks"), marker = join(outside, "executed");
    await mkdir(source); await mkdir(hooks);
    await writeFile(join(hooks, "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`); await chmod(join(hooks, "post-checkout"), 0o700);
    const globalConfig = join(outside, "gitconfig");
    await writeFile(globalConfig, `[core]\n hooksPath = ${hooks}\n[filter "danger"]\n smudge = touch '${marker}'\n required = true\n`);
    const service = new RepositorySourceService({} as any, {} as any);
    for (const branch of ["--upload-pack=malicious", "main*", "../main", "main\n", "main@{1}"]) await assert.rejects(() => service.resolveSourceSha({ repositoryUrl: "https://github.com/alice/example", branch }), /Selected branch is invalid/);
    await assert.rejects(() => service.resolveSourceSha({ repositoryUrl: "https://github.com/alice/example?redirect=elsewhere", branch: "main" }), /GitHub repository URL/);
    const inherited = { ...process.env };
    let safeEnvironment;
    try {
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = "core.hooksPath"; process.env.GIT_CONFIG_VALUE_0 = hooks;
      process.env.GIT_DIR = "/must-not-use";
      safeEnvironment = (service as any).gitEnvironment();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in inherited)) delete process.env[key];
      Object.assign(process.env, inherited);
    }
    await git("git", ["init", source], { env: safeEnvironment });
    await writeFile(join(source, ".gitattributes"), "app.txt filter=danger\n");
    await writeFile(join(source, "app.txt"), "source remains plain\n");
    await git("git", ["add", "."], { cwd: source, env: safeEnvironment });
    await git("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { cwd: source, env: safeEnvironment });
    const clone = join(outside, "clone");
    await git("git", ["clone", source, clone], { env: safeEnvironment });
    assert.equal(await readFile(join(clone, "app.txt"), "utf8"), "source remains plain\n");
    await assert.rejects(() => readFile(marker), { code: "ENOENT" }, "host hooks and filters cannot execute during analysis");
    const originalFetch = globalThis.fetch, sha = "a".repeat(40), treeSha = "b".repeat(40);
    let tree: any = { sha: treeSha, truncated: false, tree: [{ type: "blob", path: "app.txt", size: 20 }] }, wrongCommit = false;
    try {
      globalThis.fetch = (async (url, options) => {
        assert.equal(options?.redirect, "error", "repository credentials are not forwarded to redirects");
        const address = String(url);
        assert.ok(address.startsWith("https://api.github.com/repos/alice/example/"));
        return Response.json(address.includes("/commits/") ? { sha: wrongCommit ? "c".repeat(40) : sha, commit: { tree: { sha: treeSha } } } : tree);
      }) as typeof fetch;
      const preflight = () => (service as any).assertRemoteSourceBounds("https://github.com/alice/example.git", sha);
      await preflight();
      tree.truncated = true; await assert.rejects(preflight, /Complete repository size evidence/);
      tree.truncated = false; tree.tree[0].size = 200 * 1024 * 1024 + 1; await assert.rejects(preflight, /200 MiB/);
      tree.tree = Array.from({ length: 5001 }, (_, index) => ({ type: "blob", path: `file${index}`, size: 0 })); await assert.rejects(preflight, /5,000-file/);
      tree.tree = [{ type: "blob", path: "../escape", size: 0 }]; await assert.rejects(preflight, /unsafe tracked path/);
      tree.tree = [{ type: "commit", path: "submodule" }]; await assert.rejects(preflight, /unsupported or unbounded/);
      tree.tree = [{ type: "blob", path: "app", size: "20" }]; await assert.rejects(preflight, /unsupported or unbounded/);
      wrongCommit = true; await assert.rejects(preflight, /exact admitted source identity/);
    } finally { globalThis.fetch = originalFetch; }
    console.log("Source analysis boundary checks passed: symlinks, traversal, file/size limits, and isolated real Git checkout without inherited hooks or filters.");
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
}
verify().catch((error) => { console.error(error); process.exitCode = 1; });
