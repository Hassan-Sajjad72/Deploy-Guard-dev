import { createHash, randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fsyncSync, writeFileSync, readFileSync, mkdirSync, lstatSync, fstatSync, linkSync, unlinkSync, fchmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateDeletionManifest } from "./observe-deletion.mjs";

const CONTRACT = "deployguard.aws-deletion-retention/v1";
const ownerKeys = ["projectId", "environmentName", "accountId", "region"];
const identity = (r) => JSON.stringify([r.type, r.parent || "", r.id]);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failure = (code) => { throw new Error(code); };

// Normalization makes identical retries idempotent without weakening validation.
function canonical(manifest) {
  validateDeletionManifest(manifest);
  return {
    contractVersion: manifest.contractVersion,
    scope: Object.fromEntries(["projectId", "operationId", "environmentName", "accountId", "region", "generationIds"]
      .map((key) => [key, key === "generationIds" ? [...manifest.scope[key]].sort() : manifest.scope[key]])),
    resources: manifest.resources.map((r) => ({ type: r.type, id: r.id, ...(r.parent === undefined ? {} : { parent: r.parent }) }))
      .sort((a, b) => compare(identity(a), identity(b))),
  };
}

function directoryHandle(directory, create) {
  let created = false;
  if (create) {
    try { mkdirSync(directory, { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) failure("DG_DELETION_RETENTION_INVALID");
  if (created) {
    const parent = openSync(dirname(directory), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  return openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

function readSnapshot(directory, hash) {
  const path = join(directory, `${hash}.json`);
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // Only bounded identifier manifests belong in this store, never raw state.
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) failure("DG_DELETION_RETENTION_INVALID");
    const bytes = readFileSync(file, "utf8");
    if (digest(bytes) !== hash) failure("DG_DELETION_RETENTION_INTEGRITY_FAILED");
    const manifest = JSON.parse(bytes);
    const normalized = canonical(manifest);
    if (bytes !== `${JSON.stringify(normalized)}\n`) failure("DG_DELETION_RETENTION_INTEGRITY_FAILED");
    return normalized;
  } finally { closeSync(file); }
}

/**
 * Atomically publish an immutable identifier snapshot before destructive work.
 * The caller must durably retain EVERY returned receipt separately. This store
 * is local evidence transport, not authenticated ownership or completeness proof.
 */
export function retainDeletionManifest(directory, manifest) {
  const bytes = `${JSON.stringify(canonical(manifest))}\n`;
  const manifestSha256 = digest(bytes);
  const handle = directoryHandle(directory, true);
  const pending = join(directory, `.pending-${randomUUID()}`);
  let pendingCreated = false;
  try {
    const file = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    pendingCreated = true;
    try { writeFileSync(file, bytes); fchmodSync(file, 0o400); fsyncSync(file); }
    finally { closeSync(file); }
    try { linkSync(pending, join(directory, `${manifestSha256}.json`)); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Never replace an existing object, including a corrupt same-name object.
      readSnapshot(directory, manifestSha256);
    }
    fsyncSync(handle);
    return { contractVersion: CONTRACT, manifestSha256 };
  } finally {
    try { if (pendingCreated) { unlinkSync(pending); fsyncSync(handle); } }
    finally { closeSync(handle); }
  }
}

/** Rebuild the union from exact trusted receipts, not directory/tag discovery. */
export function restoreDeletionManifest(directory, scope, receipts) {
  if (!Array.isArray(receipts) || !receipts.length || receipts.length > 1000
    || receipts.some((r) => !r || r.contractVersion !== CONTRACT || !/^[a-f0-9]{64}$/.test(r.manifestSha256)
      || Object.keys(r).some((key) => !["contractVersion", "manifestSha256"].includes(key)))
    || new Set(receipts.map((r) => r.manifestSha256)).size !== receipts.length) failure("DG_DELETION_RETENTION_INVALID");
  const handle = directoryHandle(directory, false);
  try {
    const resources = new Map();
    const parents = new Map();
    const generations = new Set();
    for (const receipt of receipts) {
      const manifest = readSnapshot(directory, receipt.manifestSha256);
      if (ownerKeys.some((key) => manifest.scope[key] !== scope?.[key])
        || !Array.isArray(scope?.generationIds)
        || manifest.scope.generationIds.some((id) => !scope.generationIds.includes(id))) failure("DG_DELETION_RETENTION_SCOPE_MISMATCH");
      for (const id of manifest.scope.generationIds) generations.add(id);
      for (const resource of manifest.resources) {
        const key = JSON.stringify([resource.type, resource.id]);
        if (parents.has(key) && parents.get(key) !== resource.parent) failure("DG_DELETION_RETENTION_SCOPE_MISMATCH");
        parents.set(key, resource.parent);
        resources.set(identity(resource), resource);
        if (resources.size > 1000) failure("DG_DELETION_SCOPE_INVALID");
      }
    }
    if (scope.generationIds.length !== generations.size || scope.generationIds.some((id) => !generations.has(id))) failure("DG_DELETION_RETENTION_SCOPE_MISMATCH");
    return canonical({ contractVersion: "deployguard.aws-deletion-manifest/v1", scope, resources: [...resources.values()] });
  } finally { closeSync(handle); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [, , action, input, flag, directory] = process.argv;
    if (process.argv.length !== 6 || !["--retain", "--restore"].includes(action) || flag !== "--directory") {
      failure("DG_DELETION_RETENTION_USAGE");
    }
    // Inputs contain identifiers/receipts only; errors never print their contents.
    const value = JSON.parse(readFileSync(input, "utf8"));
    const result = action === "--retain" ? retainDeletionManifest(directory, value)
      : restoreDeletionManifest(directory, value.scope, value.receipts);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = /^DG_DELETION_[A-Z_]+$/.test(error.message) ? error.message : "DG_DELETION_RETENTION_INVALID";
    process.stderr.write(`${code}\n`);
    if (code === "DG_DELETION_RETENTION_USAGE") process.stderr.write("Usage: node retain-deletion-manifest.mjs --retain manifest.json|--restore request.json --directory evidence-directory\n");
    process.exitCode = 1;
  }
}
