import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { awsCliRunner, captureDeletionManifest, observeDeletion, validateDeletionManifest } from "./observe-deletion.mjs";
import { readOwnershipInput } from "./collect-ownership.mjs";

const fail = () => { throw new Error("DG_DESTROY_OWNERSHIP_INCOMPLETE"); };
const keys = (object, names) => object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).every((key) => names.includes(key));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identity = (row) => JSON.stringify([row.type, row.id, row.parent]);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

/** The backend freezes all receipts before dispatch. The runner may not narrow
 * that authority to current Terraform state or to its selected LIVE services.
 */
export function retainedDestroyOwnership(runtime) {
  const ownership = runtime?.projectDeletion?.ownership;
  if (!keys(ownership, ["contractVersion", "manifest", "receipts"]) || ownership.contractVersion !== "deployguard.destroy-ownership/v1") fail();
  validateDeletionManifest(ownership.manifest);
  const scope = ownership.manifest.scope;
  if (scope.generationIds.length > 1000 || new Set(ownership.manifest.resources.map((row) => JSON.stringify([row.type, row.id]))).size !== ownership.manifest.resources.length) fail();
  if (runtime.schemaVersion !== 3 || runtime.projectId !== scope.projectId || runtime.operationId !== scope.operationId
    || runtime.environmentName !== scope.environmentName || !/^[a-f0-9]{40}$/.test(runtime.sourceSha)
    || !Array.isArray(runtime.projectDeletion.generationIds)
    || JSON.stringify([...runtime.projectDeletion.generationIds].sort()) !== JSON.stringify([...scope.generationIds].sort())
    || !Array.isArray(ownership.receipts) || !ownership.receipts.length || ownership.receipts.length > 1000
    || ownership.receipts.some((row) => !keys(row, ["operationId", "sha256"]) || !UUID.test(row.operationId) || !/^[a-f0-9]{64}$/.test(row.sha256))
    || new Set(ownership.receipts.map((row) => row.operationId)).size !== ownership.receipts.length) fail();
  const state = `projects/${scope.projectId}/${scope.environmentName}/runtime/terraform.tfstate`;
  const states = ownership.manifest.resources.filter((row) => row.type === "s3_state_object");
  if (states.length !== 2 || ![state, `${state}.tflock`].every((id) => states.some((row) => row.id === id))
    || states[0].parent !== states[1].parent || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(states[0].parent)) fail();
  const repository = new RegExp(`^deployguard-(${scope.projectId}|${scope.projectId.replaceAll("-", "").slice(0, 12)}-[a-f0-9]{8})$`);
  const runtimeSecret = `arn:aws:secretsmanager:${scope.region}:${scope.accountId}:secret:deployguard/${scope.projectId}/${scope.environmentName}/`;
  for (const row of ownership.manifest.resources) {
    if (row.type === "aws_ecr_repository" && !repository.test(row.id)) fail();
    if (row.type === "aws_secretsmanager_secret" && !row.id.startsWith(runtimeSecret)) fail();
  }
  return structuredClone(ownership);
}

/** Reject late/uncovered Terraform resources BEFORE invoking destroy. Empty
 * state on retry is allowed, but never replaces the frozen observation set.
 */
export function validateRetainedTerraformState(runtime, state) {
  const ownership = retainedDestroyOwnership(runtime);
  if (state?.format_version === "1.0" && !state.values && Object.keys(state).every((key) => ["format_version", "terraform_version"].includes(key))) return ownership;
  const current = captureDeletionManifest(state, ownership.manifest.scope);
  const frozen = new Set(ownership.manifest.resources.map(identity));
  if (current.resources.some((row) => !frozen.has(identity(row)))) fail();
  return ownership;
}

/** Terraform remains topology/data cleanup authority. Only the existing
 * out-of-Terraform families are additionally cleaned, from exact retained IDs.
 * A present lock, unknown residue, or pending DB-secret recovery blocks proof;
 * this never force-unlocks state or shortens database recovery protection.
 */
export async function cleanupRetainedRuntime(runtime, run, options = {}) {
  const ownership = retainedDestroyOwnership(runtime);
  const sourceSha = runtime.sourceSha;
  const manifest = ownership.manifest;
  const secretMetadata = new Map();
  const preliminary = await observeDeletion(manifest, async (args) => {
    const response = await run(args);
    if (args[0] === "secretsmanager" && args[1] === "describe-secret" && response.status === 0) {
      try { secretMetadata.set(args[args.indexOf("--secret-id") + 1], JSON.parse(response.stdout)); }
      catch { fail(); }
    }
    return response;
  }, { attempts: 1, delayMs: 0 });
  if (preliminary.status === "UNVERIFIED") fail();
  const runtimeSecretPattern = new RegExp(`^arn:aws:secretsmanager:${manifest.scope.region}:${manifest.scope.accountId}:secret:deployguard/${manifest.scope.projectId}/${manifest.scope.environmentName}/(services/[0-9a-f-]{36}/runtime|application/runtime)-[A-Za-z0-9]{6}$`);
  const runtimeSecret = (id) => runtimeSecretPattern.test(id);
  // Retained provenance strengthens, rather than replaces, the existing exact
  // namespace and runtime-secret tag checks. Validate all candidates pre-write.
  for (const row of preliminary.observations.filter((row) => row.type === "aws_secretsmanager_secret" && row.status !== "PASS" && runtimeSecret(row.id))) {
    const metadata = secretMetadata.get(row.id);
    if (!Array.isArray(metadata?.Tags)) fail();
    const name = row.id.split(":").slice(6).join(":").slice(0, -7);
    const service = name.match(/\/services\/([0-9a-f-]{36})\/runtime$/)?.[1];
    const tag = (key) => {
      const values = metadata?.Tags?.filter((tag) => tag.Key === key);
      return values?.length === 1 ? values[0].Value : null;
    };
    if (metadata?.ARN !== row.id || metadata.Name !== name || tag("ManagedBy") !== "DeployGuard"
      || tag("DeployGuardProjectId") !== manifest.scope.projectId || tag("Environment") !== manifest.scope.environmentName
      || tag("SecretPurpose") !== "application_runtime"
      || (service ? tag("DeployGuardScope") !== "service" || tag("DeployGuardServiceId") !== service : tag("DeployGuardScope") !== "project")) fail();
  }
  for (const observation of preliminary.observations) {
    if (observation.status === "PASS") continue;
    let args;
    if (observation.type === "aws_ecs_task_definition") args = ["ecs", "deregister-task-definition", "--task-definition", observation.id];
    else if (observation.type === "aws_ecr_repository") args = ["ecr", "delete-repository", "--repository-name", observation.id, "--force"];
    else if (observation.type === "aws_secretsmanager_secret" && runtimeSecret(observation.id))
      args = ["secretsmanager", "delete-secret", "--secret-id", observation.id, "--force-delete-without-recovery"];
    else if (observation.type === "s3_state_object" && !observation.id.endsWith(".tflock")) args = ["s3api", "delete-object", "--bucket", observation.parent, "--key", observation.id];
    // Unsupported/persistent residue is not adopted as a new deletion policy.
    if (!args) continue;
    const result = await run([...args, "--region", manifest.scope.region, "--output", "json", "--no-cli-pager"]);
    if (result.status !== 0) fail();
  }
  const observation = await observeDeletion(manifest, run, options);
  if (observation.status !== "PASS") fail();
  return { action: "destroy", contractVersion: "deployguard.release-result/v5", sourceSha,
    operationId: manifest.scope.operationId, destroyed: true,
    destroyVerification: { contractVersion: "deployguard.destroy-result/v3", deploymentOperationId: manifest.scope.operationId,
      projectId: manifest.scope.projectId, environmentName: manifest.scope.environmentName, generationIds: [...manifest.scope.generationIds].sort(),
      status: "project_delete_ready", generationResourcesRemoved: true, projectResourcesRemoved: true,
      terraformStateArtifactsRemoved: true, sharedPlatformUntouched: true, verifiedAt: observation.verifiedAt,
      ownershipSha256: hash(ownership), observation } };
}

async function main() {
  try {
    const [, , action, runtimePath, statePath] = process.argv;
    const runtime = readOwnershipInput(runtimePath);
    const ownership = retainedDestroyOwnership(runtime);
    if (runtime.projectId !== process.env.PROJECT_ID || runtime.operationId !== process.env.OPERATION_ID
      || runtime.sourceSha !== process.env.SOURCE_SHA || runtime.environmentName !== process.env.ENVIRONMENT_NAME
      || ownership.manifest.scope.region !== process.env.AWS_REGION || ownership.manifest.scope.accountId !== process.env.AWS_ACCOUNT_ID
      || ownership.manifest.resources.some((row) => row.type === "s3_state_object" && row.parent !== process.env.TERRAFORM_STATE_BUCKET)) fail();
    if (action === "--validate-state" && process.argv.length === 5) validateRetainedTerraformState(runtime, readOwnershipInput(statePath, 16 * 1024 * 1024));
    else if (action === "--cleanup-and-verify" && process.argv.length === 4) {
      process.stdout.write(`${JSON.stringify(await cleanupRetainedRuntime(runtime, awsCliRunner(), { attempts: 10, delayMs: 5000 }))}\n`);
    } else fail();
  } catch { process.stderr.write("DG_FAILURE code=DG_DESTROY_OWNERSHIP_INCOMPLETE stage=terraform_materialization\n"); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
