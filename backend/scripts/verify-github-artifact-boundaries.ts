import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import { deflateRawSync } from "node:zlib";
import { buildDeterministicZip } from "../src/terraform-export/zip-builder";
import { exactZipEntry, GithubActionsDispatchError, GithubActionsService } from "../src/projects/pipeline/github-actions.service";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { LogSanitizerService } from "../src/observability/log-sanitizer.service";

const name = "deployguard-result.json";
const zip = (content = "verified fixture") => buildDeterministicZip([{ path: name, content: Buffer.from(content) }]);
const invalid = (error: unknown) => error instanceof GithubActionsDispatchError && error.diagnosticCode === "unknown_github_error";
function compressedZip(content: Buffer, declaredLength = content.length) {
  const source = buildDeterministicZip([{ path: name, content }]);
  const centralOffset = source.readUInt32LE(source.length - 6);
  const header = Buffer.from(source.subarray(0, 30 + Buffer.byteLength(name)));
  const central = Buffer.from(source.subarray(centralOffset, source.length - 22));
  const compressed = deflateRawSync(content);
  header.writeUInt16LE(8, 8); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(declaredLength, 22);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(declaredLength, 24);
  const end = Buffer.from(source.subarray(source.length - 22));
  end.writeUInt32LE(header.length + compressed.length, 16);
  return Buffer.concat([header, compressed, central, end]);
}

async function verifyZipBoundaries() {
  assert.equal(exactZipEntry(zip(), name), "verified fixture");
  assert.equal(exactZipEntry(compressedZip(Buffer.from("deflated fixture")), name), "deflated fixture");
  assert.equal(exactZipEntry(zip(), "not-requested.json"), null);
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const originalInflate = zlib.inflateRawSync;
  let outputLimit: number | undefined;
  (zlib as any).inflateRawSync = (buffer: Buffer, options: { maxOutputLength?: number }) => {
    outputLimit = options?.maxOutputLength;
    return originalInflate(buffer, options);
  };
  try {
    assert.throws(() => exactZipEntry(compressedZip(Buffer.alloc(8 * 1024 * 1024, 65), 16), name, 128), invalid);
    assert.equal(outputLimit, 128, "actual inflation must be bounded even when the ZIP lies about its uncompressed size");
  } finally { (zlib as any).inflateRawSync = originalInflate; }

  const duplicate = buildDeterministicZip([{ path: name, content: Buffer.from("first") }, { path: name, content: Buffer.from("second") }]);
  assert.throws(() => exactZipEntry(duplicate, name), invalid, "duplicate result entries must not select the first");
  for (const mutate of [
    (value: Buffer) => value.subarray(0, 10),
    (value: Buffer) => { value.writeUInt32LE(0xfffffff0, value.length - 6); return value; },
    (value: Buffer) => { value.writeUInt32LE(0xfffffff0, value.readUInt32LE(value.length - 6) + 42); return value; },
    (value: Buffer) => { value.writeUInt32LE(0xfffffff0, value.readUInt32LE(value.length - 6) + 20); return value; },
    (value: Buffer) => { value.writeUInt16LE(0xffff, value.readUInt32LE(value.length - 6) + 28); return value; },
    (value: Buffer) => { value.writeUInt16LE(0xffff, 26); return value; },
    (value: Buffer) => { value.writeUInt16LE(1, value.length - 18); return value; },
    (value: Buffer) => { value.writeUInt16LE(1, 6); value.writeUInt16LE(1, value.readUInt32LE(value.length - 6) + 8); return value; },
    (value: Buffer) => { value[30] = 88; return value; },
    (value: Buffer) => { value.writeUInt16LE(8, 8); return value; },
    (value: Buffer) => { value.writeUInt16LE(99, 8); value.writeUInt16LE(99, value.readUInt32LE(value.length - 6) + 10); return value; },
    (value: Buffer) => { value.writeUInt16LE(2, value.length - 12); return value; },
  ]) assert.throws(() => exactZipEntry(mutate(zip()), name), invalid, "malformed archives must fail safely, not with Buffer bounds or raw decompressor errors");
  assert.throws(() => exactZipEntry(zip("large"), name, 4), invalid);
}

async function verifyDownloadBoundaries() {
  const originalFetch = globalThis.fetch;
  const service = new GithubActionsService(new ConfigService({}));
  let download: () => Response = () => new Response(zip());
  let listing: unknown = { artifacts: [{ id: 1, name: "deployguard-result-operation", expired: false }] };
  let listingHeaders: Record<string, string> = {};
  let listingStatus = 200;
  let downloads = 0;
  globalThis.fetch = async (url, options) => {
    assert.ok(options?.signal, "artifact HTTP requests must have a bounded timeout");
    if (String(url).includes("/artifacts?")) return new Response(JSON.stringify(listing), { headers: listingHeaders, status: listingStatus });
    downloads += 1;
    return download();
  };
  const read = () => service.getArtifactEntry("fixture/repository", "123", "operation", "mock-token", name, 512 * 1024);
  try {
    assert.equal(await read(), "verified fixture");
    for (const headers of [{}, { "content-length": "16" }]) {
      let cancelled = false;
      let chunks = 0;
      download = () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled = true; },
      }), { headers });
      await assert.rejects(read, invalid, "missing/false Content-Length cannot bypass the streamed archive byte limit");
      assert.equal(cancelled, true, "oversized downloads must cancel their response stream");
      assert.ok(chunks <= 4, "the client must stop consuming once the archive limit is reached");
    }
    download = () => new Response(zip(), { headers: { "content-length": String(32 * 1024 * 1024 + 1) } });
    await assert.rejects(read, invalid);
    download = () => new Response(zip());
    for (const invalidListing of [null, {}, { artifacts: {} }, { artifacts: [null] },
      { artifacts: [{ id: "../other", name: "deployguard-result-operation", expired: false }] },
      { artifacts: [{ id: 1, name: "deployguard-result-operation", expired: false }, { id: 2, name: "deployguard-result-operation", expired: false }] },
    ]) {
      listing = invalidListing;
      const before = downloads;
      await assert.rejects(read, invalid);
      assert.equal(downloads, before, "invalid or ambiguous artifact identity must block download");
    }
    listing = { artifacts: [] };
    assert.equal(await read(), null, "a valid empty listing remains pending evidence");
    listing = { artifacts: [{ id: 1, name: "deployguard-result-operation", expired: false }] };
    listingHeaders = { link: '<https://api.github.com/ignored>; rel="next"' };
    await assert.rejects(read, invalid, "truncated artifact listings cannot establish a unique identity");
    listingHeaders = {};
    download = () => new Response(Buffer.from("PRIVATE-MALFORMED-ARCHIVE"));
    const operation: any = { id: "10000000-0000-4000-8000-000000000001", projectId: "20000000-0000-4000-8000-000000000002", triggeredByUserId: 7, githubWorkflowRunId: "123", status: PipelineRunStatus.RUNNING, currentStage: "github_actions", metadata: { executionEngine: "railpack", deploymentAction: "deploy" } };
    listing = { artifacts: [{ id: 1, name: `deployguard-result-${operation.id}`, expired: false }] };
    const lifecycle = Object.create(RailpackDeploymentService.prototype) as any;
    lifecycle.projects = { findOne: async () => ({ id: operation.projectId, repositoryFullName: "fixture/repository", environmentName: "dev" }) };
    lifecycle.users = { findOne: async () => ({ id: 7 }) };
    lifecycle.githubApp = { tokenForRepository: async () => ({ token: "mock-token" }) };
    lifecycle.actions = { getWorkflowRun: async () => ({ status: "completed", conclusion: "success" }), getResultArtifact: (...args: Parameters<typeof service.getResultArtifact>) => service.getResultArtifact(...args) };
    lifecycle.runs = { save: async (row: unknown) => row };
    lifecycle.sanitizer = new LogSanitizerService();
    let promotions = 0;
    lifecycle.finalizeVerifiedRelease = async () => { promotions++; };
    await lifecycle.reconcile(operation);
    assert.equal(operation.status, PipelineRunStatus.FAILED, "invalid terminal archives must converge to failure, not remain eternally running");
    assert.equal(operation.currentStage, "release_evidence_validation");
    assert.equal(promotions, 0, "invalid or unverified artifacts can never promote a release");
    assert.doesNotMatch(JSON.stringify(operation.metadata), /PRIVATE-MALFORMED-ARCHIVE|mock-token/);
    listingStatus = 503;
    const unavailable = { ...operation, status: PipelineRunStatus.RUNNING, currentStage: "github_actions", metadata: { executionEngine: "railpack", deploymentAction: "deploy", releaseEvidencePendingAttempts: 2, releaseEvidencePendingSince: new Date(Date.now() - 3 * 60_000).toISOString() } };
    await lifecycle.reconcile(unavailable);
    assert.equal(unavailable.status, PipelineRunStatus.FAILED, "terminal evidence retrieval outages must also honor the bounded reconciliation deadline");
    assert.equal(unavailable.metadata.releaseEvidenceReadUnavailable, true);
    assert.equal(promotions, 0);
    const retryable: any = { ...operation, status: PipelineRunStatus.RUNNING, currentStage: "github_actions", metadata: { executionEngine: "railpack", deploymentAction: "deploy", releaseEvidencePendingAttempts: "invalid", releaseEvidencePendingSince: "invalid" } };
    await lifecycle.reconcile(retryable);
    assert.equal(retryable.status, PipelineRunStatus.RUNNING, "temporary outages remain retryable within the evidence window");
    assert.equal(retryable.currentStage, "release_evidence_pending");
    assert.equal(retryable.metadata.releaseEvidencePendingAttempts, 1);
    assert.ok(Number.isFinite(Date.parse(retryable.metadata.releaseEvidencePendingSince)), "invalid historical retry metadata must not defeat the deadline");
    listingStatus = 200;
    listing = { artifacts: [] };
    await lifecycle.reconcile(retryable);
    assert.equal(retryable.metadata.releaseEvidencePendingAttempts, 2);
    assert.equal(retryable.metadata.releaseEvidenceReadUnavailable, false, "successful reads must clear stale provider-unavailable state");
    assert.equal(promotions, 0);
  } finally { globalThis.fetch = originalFetch; }
}

void (async () => {
  await verifyZipBoundaries();
  await verifyDownloadBoundaries();
  console.log("GITHUB_ARTIFACT_BOUNDARIES=PASS BOUNDED_INFLATION=1 BOUNDED_STREAM=1 TIMEOUT=1 DUPLICATE_AND_MALFORMED_FAIL_CLOSED=1 MOCKED_HTTP_ONLY=1");
})().catch((error) => { console.error(error); process.exitCode = 1; });
