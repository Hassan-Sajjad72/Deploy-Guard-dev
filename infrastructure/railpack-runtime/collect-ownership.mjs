import { constants, closeSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { captureDeletionManifest, validateDeletionManifest } from "./observe-deletion.mjs";

export const COLLECTION_CONTRACT = "deployguard.aws-resource-collection/v1";
const families = ["terraform", "ecr", "ecs", "state"];
const fail = () => { throw new Error("DG_AWS_OWNERSHIP_INCOMPLETE"); };
const identity = (row) => JSON.stringify([row.type, row.id]);

function validate(collection) {
  if (!collection || collection.contractVersion !== COLLECTION_CONTRACT
    || !/^[a-f0-9]{40}$/.test(collection.sourceSha)
    || !Array.isArray(collection.coverage) || collection.coverage.length !== families.length
    || families.some((family) => !collection.coverage.includes(family))
    || !Array.isArray(collection.unresolvedIntents) || collection.unresolvedIntents.length > 1000
    || new Set(collection.unresolvedIntents).size !== collection.unresolvedIntents.length
    || collection.unresolvedIntents.some((value) => typeof value !== "string" || !/^[a-zA-Z0-9/_-]{1,160}$/.test(value))
    || Object.keys(collection).some((key) => !["contractVersion", "scope", "sourceSha", "coverage", "unresolvedIntents", "resources"].includes(key))) fail();
  const manifest = { contractVersion: "deployguard.aws-deletion-manifest/v1",
    scope: { ...collection.scope, generationIds: [collection.scope.operationId] }, resources: collection.resources };
  validateDeletionManifest(manifest);
  if (Object.keys(collection.scope).length !== 5) fail();
  const state = `projects/${collection.scope.projectId}/${collection.scope.environmentName}/runtime/terraform.tfstate`;
  const states = collection.resources.filter((row) => row.type === "s3_state_object");
  if (states.length !== 2 || ![state, `${state}.tflock`].every((key) => states.some((row) => row.id === key))
    || states[0].parent !== states[1].parent || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(states[0].parent)) fail();
  if (Buffer.byteLength(JSON.stringify(collection)) > 512 * 1024) fail();
  return collection;
}

export function initializeOwnership(scope, sourceSha, bucket) {
  const key = `projects/${scope.projectId}/${scope.environmentName}/runtime/terraform.tfstate`;
  return validate({ contractVersion: COLLECTION_CONTRACT, scope: structuredClone(scope), sourceSha,
    coverage: [...families], unresolvedIntents: [], resources: [key, `${key}.tflock`].map((id) => ({ type: "s3_state_object", id, parent: bucket })) });
}

export function beginOwnershipWrite(collection, intent) {
  validate(collection);
  if (collection.unresolvedIntents.includes(intent)) fail();
  return validate({ ...structuredClone(collection), unresolvedIntents: [...collection.unresolvedIntents, intent] });
}

/** A response-lost write stays unresolved. Never synthesize its physical ID. */
export function resolveOwnershipWrite(collection, intent, resources) {
  validate(collection);
  if (!collection.unresolvedIntents.includes(intent) || !Array.isArray(resources)) fail();
  const merged = new Map(collection.resources.map((row) => [identity(row), row]));
  for (const row of resources) {
    if (merged.has(identity(row)) && merged.get(identity(row)).parent !== row.parent) fail();
    merged.set(identity(row), structuredClone(row));
  }
  const result = { ...structuredClone(collection), resources: [...merged.values()],
    unresolvedIntents: collection.unresolvedIntents.filter((value) => value !== intent) };
  return validate(result);
}

export function resolveTerraformOwnership(collection, state) {
  const manifest = captureDeletionManifest(state, { ...collection.scope, generationIds: [collection.scope.operationId] });
  return resolveOwnershipWrite(collection, "terraform", manifest.resources);
}

export function completedOwnership(collection) {
  validate(collection);
  if (collection.unresolvedIntents.length) fail();
  return structuredClone(collection);
}

// Private runner-local transport; the operation row is retained before dispatch
// and the workflow uploads its pre-write intent before permitting AWS mutations.
// A killed runner or missing final upload NEVER supplies a complete receipt.
export function readOwnershipInput(path, maximum = 512 * 1024) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > maximum) fail();
    return JSON.parse(readFileSync(file, "utf8"));
  } finally { closeSync(file); }
}
function store(path, value) {
  const temporary = `${path}.pending`;
  const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(file, `${JSON.stringify(value)}\n`); fsyncSync(file); }
  finally { closeSync(file); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [, , action, path, argument] = process.argv;
    if (action === "init" && process.argv.length === 5) {
      const runtime = readOwnershipInput(argument);
      if (runtime.operationId !== process.env.OPERATION_ID || runtime.projectId !== process.env.PROJECT_ID
        || runtime.sourceSha !== process.env.SOURCE_SHA || runtime.environmentName !== process.env.ENVIRONMENT_NAME
        || !/^\d{12}$/.test(process.env.AWS_ACCOUNT_ID || "")) fail();
      // Reinitialization must never discard an unresolved earlier write.
      const created = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      closeSync(created);
      store(path, initializeOwnership({ projectId: runtime.projectId, operationId: runtime.operationId,
        environmentName: runtime.environmentName, accountId: process.env.AWS_ACCOUNT_ID, region: process.env.AWS_REGION },
      runtime.sourceSha, process.env.TERRAFORM_STATE_BUCKET));
    } else {
      const collection = validate(readOwnershipInput(path));
      if (action === "begin" && process.argv.length === 5) store(path, beginOwnershipWrite(collection, argument));
      else if (action === "resolve" && process.argv.length === 6) store(path, resolveOwnershipWrite(collection, argument, readOwnershipInput(process.argv[5])));
      else if (action === "terraform" && process.argv.length === 5) {
        // Terraform show can contain secret values. Read it privately but retain
        // only captureDeletionManifest's allowlisted identifiers.
        store(path, resolveTerraformOwnership(collection, readOwnershipInput(argument, 16 * 1024 * 1024)));
      } else if (action === "complete" && process.argv.length === 4) process.stdout.write(`${JSON.stringify(completedOwnership(collection))}\n`);
      else fail();
    }
  } catch { process.stderr.write("DG_FAILURE code=DG_AWS_OWNERSHIP_INCOMPLETE stage=ownership_retention\n"); process.exitCode = 1; }
}
