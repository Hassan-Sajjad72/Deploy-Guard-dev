import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxArguments, HostingBuildService } from "../src/planning/hosting-build.service";
import { verifyHostingBuildProof } from "../src/planning/hosting-provider-adapter.service";
import { planFingerprint } from "../src/planning/deployment-plan";

async function main() {
  const image = `registry.example/builder@sha256:${"a".repeat(64)}`;
  const args = buildSandboxArguments("/work", image, "npm ci", "dg-test");
  for (const flag of ["--read-only", "--cap-drop", "no-new-privileges", "65534:65534", "--pids-limit", "--memory"]) assert(args.includes(flag), `sandbox keeps ${flag}`);
  assert.throws(() => buildSandboxArguments("/work", "node:22", "npm ci", "dg-test"), /digest-pinned/);

  const root = await mkdtemp(join(tmpdir(), "dg-build-evidence-"));
  const key = "k".repeat(40);
  const config: any = { get: (name: string, fallback: string) => ({ HOSTING_BUILD_ARTIFACT_ROOT: root, HOSTING_BUILD_PROOF_SIGNING_KEY: key } as Record<string, string>)[name] ?? fallback };
  const service = new HostingBuildService({} as any, config, {} as any, {} as any, {} as any, {} as any);
  try {
    const ids = { organizationId: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222" };
    const buildId = "33333333-3333-4333-8333-333333333333", sourceSha = "b".repeat(40);
    const evidence = { build: { sourceSha, kind: "static", fingerprint: "c".repeat(64), securityScanFingerprint: "d".repeat(64), status: "verified" }, assets: [{ path: "index.html", sha256: "e".repeat(64), bytes: 5, contentType: "text/html" }] };
    const record: any = { contractVersion: "deployguard.hosting-build/v1", buildId, status: "succeeded", ...ids, sourceSha, profile: "static", serviceIds: [], evidence,
      securityScan: { status: "passed", fingerprint: "d".repeat(64), source: "trivy" }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    const staging = join(root, "staging", buildId);
    await mkdir(join(staging, "assets"), { recursive: true });
    await writeFile(join(staging, "assets", "index.html"), "hello");
    await writeFile(join(staging, "build.json"), JSON.stringify(record));

    const expected = { ...ids, sourceSha, profile: "static" };
    const { inputs } = await service.mergeInputs(buildId, expected, { spa: true, priceClass: "PriceClass_100", healthPath: "/", assets: [{ path: "forged.html" }] });
    assert.deepEqual(inputs.assets, evidence.assets, "trusted build assets override user-supplied values");
    await assert.rejects(service.mergeInputs(buildId, { ...expected, sourceSha: "f".repeat(40) }, {}), /different source SHA/);
    await assert.rejects(service.mergeInputs(buildId, { ...expected, profile: "lambda" }, {}), /another project or profile/);
    await writeFile(join(staging, "build.json"), JSON.stringify({ ...record, securityScan: { ...record.securityScan, status: "failed" } }));
    await assert.rejects(service.mergeInputs(buildId, expected, {}), /security scan/);
    await writeFile(join(staging, "build.json"), JSON.stringify({ ...record, status: "running" }));
    await assert.rejects(service.mergeInputs(buildId, expected, {}), /still running/);

    const { directory } = await service.seal(record, inputs);
    assert.equal(await readFile(join(directory, "assets", "index.html"), "utf8"), "hello", "assets are copied beside the provenance");
    const envelope = JSON.parse(await readFile(join(directory, "provenance.json"), "utf8"));
    const admission = { ...ids, sourceSha, profile: "static", profileInputsFingerprint: planFingerprint(inputs) };
    assert.equal(verifyHostingBuildProof(envelope, admission, key), true, "the provider adapter admits the sealed proof");
    assert.equal(verifyHostingBuildProof(envelope, { ...admission, profileInputsFingerprint: "0".repeat(64) }, key), false, "changed inputs invalidate the proof");
    assert.equal(verifyHostingBuildProof(envelope, admission, "x".repeat(40)), false, "a different signing key is rejected");
    console.log("Hosting build evidence checks passed: sandbox hardening, trusted merge, stale/failed rejection and adapter-verifiable signed provenance.");
  } finally { await rm(root, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exit(1); });
