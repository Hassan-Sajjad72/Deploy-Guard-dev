// Real local Docker/Trivy build pipeline check. No AWS: images are pushed only to a throwaway local registry.
// Requires local, digest-pinned images; override with DG_TEST_* variables.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HostingBuildService } from "../src/planning/hosting-build.service";
import { pushOciArchive } from "../src/planning/oci-push";

const run = promisify(execFile);
const images = {
  node: process.env.DG_TEST_NODE_BUILDER || "node@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436",
  python: process.env.DG_TEST_PYTHON_BUILDER || "python@sha256:90744cff8f32887f075c47d747a173ff333e9e98801667af93c357fa9f5e28ff",
  trivy: process.env.DG_TEST_TRIVY || "aquasec/trivy@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7",
  base: process.env.DG_TEST_IMAGE_BASE || "node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
};
const lock = (name: string) => JSON.stringify({ name, version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name, version: "1.0.0" } } });
const write = async (dir: string, files: Record<string, string>) => { for (const [path, content] of Object.entries(files)) { await mkdir(join(dir, path, ".."), { recursive: true }); await writeFile(join(dir, path), content); } };
const service = (builder: string, root: string) => new HostingBuildService({} as any, { get: (name: string, fallback: string) => ({ HOSTING_BUILD_ARTIFACT_ROOT: root, HOSTING_BUILD_PROOF_SIGNING_KEY: "k".repeat(40), HOSTING_BUILDER_IMAGE: builder, HOSTING_TRIVY_IMAGE: images.trivy, HOSTING_TRIVY_CACHE_DIR: process.env.DG_TEST_TRIVY_CACHE || join(tmpdir(), "deployguard-trivy-cache") } as Record<string, string>)[name] ?? fallback } as any, {} as any, {} as any, {} as any, {} as any);
const sha = "a".repeat(40);

async function main() {
  const root = await mkdtemp(join(tmpdir(), "dg-build-docker-"));
  await mkdir(process.env.DG_TEST_TRIVY_CACHE || join(tmpdir(), "deployguard-trivy-cache"), { recursive: true });
  let registry: string | null = null;
  try {
    // Static: real npm build in the sandbox, real Trivy filesystem scan, hashed assets.
    const staticApp = await mkdtemp(join(tmpdir(), "dg-static-"));
    await write(staticApp, { "package.json": JSON.stringify({ name: "site", version: "1.0.0", scripts: { build: "node build.js" } }), "package-lock.json": lock("site"),
      "build.js": "const fs=require('fs');fs.mkdirSync('dist/assets',{recursive:true});fs.writeFileSync('dist/index.html','<h1>ok</h1>');fs.writeFileSync('dist/assets/app.js','console.log(1)');" });
    const staticResult = await service(images.node, root).buildWorkspace(staticApp, join(root, "s1"), sha, { profile: "static", serviceId: "web" });
    assert.equal(staticResult.scan.status, "passed", "a clean static build passes Trivy");
    const assets = (staticResult.evidence as any).assets;
    assert.deepEqual(assets.map((a: any) => a.path), ["assets/app.js", "index.html"]);
    const index = await readFile(join(root, "s1", "assets", "index.html"));
    assert.equal(assets[1].sha256, createHash("sha256").update(index).digest("hex"), "recorded hashes match staged bytes");
    assert.equal(assets[1].contentType, "text/html");

    // A planted credential must fail the secret scan.
    const leaky = await mkdtemp(join(tmpdir(), "dg-leaky-"));
    await write(leaky, { "package.json": JSON.stringify({ name: "leaky", version: "1.0.0", scripts: { build: "node build.js" } }), "package-lock.json": lock("leaky"),
      "build.js": "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','ok');",
      "config.js": "module.exports = { stripe: 'sk_live_" + "51H8xJ2eZvKYlo2C0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdEFGHijklMNOP' };" });
    const leakyResult = await service(images.node, root).buildWorkspace(leaky, join(root, "s2"), sha, { profile: "static", serviceId: "web" });
    assert.equal(leakyResult.scan.status, "failed", "Trivy secret scanning fails a build containing a live credential");

    // Node and Python Lambda packages.
    const nodeFn = await mkdtemp(join(tmpdir(), "dg-node-fn-"));
    await write(nodeFn, { "package.json": JSON.stringify({ name: "fn", version: "1.0.0" }), "package-lock.json": lock("fn"), "index.js": "exports.handler = async () => ({ statusCode: 200, body: 'ok' });" });
    const nodeResult: any = await service(images.node, root).buildWorkspace(nodeFn, join(root, "l1"), sha, { profile: "lambda", serviceId: "api", handler: "index.handler", runtime: "nodejs22.x" });
    const zip = await readFile(join(root, "l1", "assets", "function.zip"));
    assert.equal(nodeResult.evidence.artifact.sha256, createHash("sha256").update(zip).digest("hex"));
    assert.equal(nodeResult.evidence.adapter.fingerprint, createHash("sha256").update(await readFile(join(nodeFn, "index.js"))).digest("hex"));
    const listing = (await run("unzip", ["-l", join(root, "l1", "assets", "function.zip")])).stdout;
    assert(listing.includes("index.js") && !listing.includes(".env"), "the Lambda ZIP contains the handler");
    const pyFn = await mkdtemp(join(tmpdir(), "dg-py-fn-"));
    await write(pyFn, { "app.py": "def handler(event, context):\n    return {'statusCode': 200}\n", "requirements.txt": "" });
    const pyResult: any = await service(images.python, root).buildWorkspace(pyFn, join(root, "l2"), sha, { profile: "lambda", serviceId: "api", handler: "app.handler", runtime: "python3.12" });
    assert.equal(pyResult.scan.status, "passed"); assert.equal(pyResult.evidence.runtime, "python3.12");

    // EC2: BuildKit OCI archive, Trivy image scan, digest-preserving registry push.
    const vm = await mkdtemp(join(tmpdir(), "dg-vm-"));
    await write(vm, { Dockerfile: `FROM ${images.base}\nCOPY server.js /app/server.js\nCMD ["node","/app/server.js"]\n`, "server.js": "require('http').createServer((q,s)=>s.end('ok')).listen(8080);" });
    const vmResult: any = await service(images.node, root).buildWorkspace(vm, join(root, "v1"), sha, { profile: "ec2", serviceId: "web" });
    const built = vmResult.evidence.images.web;
    assert.match(built.digest, /^sha256:[a-f0-9]{64}$/);
    assert(["passed", "failed"].includes(vmResult.scan.status) && /^[a-f0-9]{64}$/.test(vmResult.scan.fingerprint), "the image received a real Trivy verdict");
    const { stdout: container } = await run("docker", ["run", "-d", "--rm", "-p", "127.0.0.1::5000", "registry:2"]);
    registry = container.trim();
    const { stdout: port } = await run("docker", ["port", registry, "5000"]);
    const address = port.trim().split("\n")[0].replace("0.0.0.0", "127.0.0.1");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const pushed = await pushOciArchive(join(root, "v1", "assets", built.archive), { registry: address, repository: "dg-test/web", protocol: "http" });
    assert.equal(pushed.digest, built.digest, "the registry digest equals the scanned, sealed digest");
    const head = await fetch(`http://${address}/v2/dg-test/web/manifests/${built.digest}`, { method: "HEAD", headers: { Accept: "application/vnd.oci.image.manifest.v1+json" } });
    assert.equal(head.status, 200); assert.equal(head.headers.get("docker-content-digest"), built.digest);
    await pushOciArchive(join(root, "v1", "assets", built.archive), { registry: address, repository: "dg-test/web", protocol: "http" });
    console.log(`Real Docker/Trivy pipeline passed: static, secret-leak rejection, Node and Python Lambda, EC2 OCI image (Trivy ${vmResult.scan.status}) and digest-preserving push ${built.digest.slice(0, 19)}.`);
    await Promise.all([staticApp, leaky, nodeFn, pyFn, vm].map((dir) => rm(dir, { recursive: true, force: true })));
  } finally {
    if (registry) await run("docker", ["rm", "-f", registry]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch((error) => { console.error(error); process.exit(1); });
