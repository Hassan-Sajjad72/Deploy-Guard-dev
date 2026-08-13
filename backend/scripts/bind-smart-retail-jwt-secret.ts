import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import dataSource from "../src/data-source";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { InactiveReleaseLaneOwnershipService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.service";

const PROJECT_ID = "5a294142-f12c-4ffc-ab9a-c4b096ebd659";
const MANIFEST_ID = "010b670a-9263-4b18-ae6f-26192e10cadd";
const DRAFT_ID = "187a46ac-1b6c-4712-bcce-fa3d291f4bb7";
const ENVIRONMENT = "dev";
const REGION = "us-east-1";
const ACCOUNT_ID = "563149050793";
const EXECUTION_ROLE_ARN = "arn:aws:iam::563149050793:role/dg-5a294142f12c4ffcab9a-dev-exec";
const SECRET_NAME = `deployguard/${PROJECT_ID}/${ENVIRONMENT}/JWT_SECRET`;
const ARN = /^arn:aws:secretsmanager:us-east-1:563149050793:secret:deployguard\/[A-Za-z0-9/_+=.@-]+$/;

type SecretDescription = {
  ARN?: string;
  Name?: string;
  KmsKeyId?: string;
  DeletedDate?: string;
  Tags?: Array<{ Key?: string; Value?: string }>;
};

function safe(state: string, codes: readonly string[]) {
  process.stdout.write(`${JSON.stringify({ state, safeCodes: [...new Set(codes)].sort() })}\n`);
}

function rows<T>(value: unknown): T[] {
  return Array.isArray(value) && Array.isArray(value[0])
    ? value[0] as T[]
    : Array.isArray(value) ? value as T[] : [];
}

function enabled() {
  return process.env.SMART_RETAIL_JWT_REMEDIATION_ENABLED === "true"
    && process.env.TWO_LANE_RELEASE_PROJECT_ALLOWLIST === PROJECT_ID
    && process.env.TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST === ENVIRONMENT
    && process.env.AWS_REGION === REGION;
}

function aws(args: string[], stdin?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("aws", [...args, "--region", REGION, "--output", "json", "--no-cli-pager"], {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, AWS_PAGER: "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.includes("ResourceNotFoundException") ? "AWS_NOT_FOUND" : "AWS_COMMAND_FAILED"));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : {}); } catch { reject(new Error("AWS_RESPONSE_INVALID")); }
    });
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}

function expectedTags() {
  return {
    ManagedBy: "DeployGuard",
    "deployguard:project-id": PROJECT_ID,
    "deployguard:environment": ENVIRONMENT,
    "deployguard:purpose": "application-jwt",
    "deployguard:infrastructure-manifest-id": MANIFEST_ID,
  };
}

function deterministicUuid(value: string) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const raw = hex.join("");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function tagsMatch(secret: SecretDescription) {
  const tags = new Map((secret.Tags || []).map((tag) => [tag.Key, tag.Value]));
  return secret.Name === SECRET_NAME
    && !secret.DeletedDate
    && Object.entries(expectedTags()).every(([key, value]) => tags.get(key) === value);
}

function secretPolicy(secretArn: string) {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Sid: "DeployGuardApplicationTaskReadJwt",
      Effect: "Allow",
      Principal: { AWS: EXECUTION_ROLE_ARN },
      Action: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      Resource: secretArn,
    }],
  });
}

async function describeSecret(): Promise<SecretDescription | null> {
  try {
    return await aws(["secretsmanager", "describe-secret", "--secret-id", SECRET_NAME]) as SecretDescription;
  } catch (error) {
    if (error instanceof Error && error.message === "AWS_NOT_FOUND") return null;
    throw error;
  }
}

async function ensureSecret() {
  let secret = await describeSecret();
  let created = false;
  if (!secret) {
    const generated = randomBytes(48).toString("base64url");
    try {
      await aws([
        "secretsmanager", "create-secret",
        "--name", SECRET_NAME,
        "--description", "DeployGuard generated application JWT reference",
        "--kms-key-id", "alias/aws/secretsmanager",
        "--secret-string", "file:///dev/stdin",
        "--tags",
        ...Object.entries(expectedTags()).map(([Key, Value]) => `Key=${Key},Value=${Value}`),
      ], generated);
      created = true;
    } finally {
      // Never print, log, write, or retain the generated plaintext outside this call.
      // The string becomes unreachable after this bounded creation attempt.
    }
    secret = await describeSecret();
  }
  if (!secret || !tagsMatch(secret) || typeof secret.ARN !== "string" || !ARN.test(secret.ARN)) {
    throw new Error("JWT_SECRET_OWNERSHIP_INVALID");
  }
  await aws([
    "secretsmanager", "put-resource-policy",
    "--secret-id", secret.ARN,
    "--block-public-policy",
    "--resource-policy", secretPolicy(secret.ARN),
  ]);
  const policy = await aws(["secretsmanager", "get-resource-policy", "--secret-id", secret.ARN]);
  if (typeof policy.ResourcePolicy !== "string" || !policy.ResourcePolicy.includes(EXECUTION_ROLE_ARN)) {
    throw new Error("JWT_SECRET_ACCESS_POLICY_INVALID");
  }
  return { arn: secret.ARN, created };
}

async function bind(secretArn: string, ownership: { leaseId: string; fencingToken: string; idempotencyKey: string; requestFingerprint: string }) {
  return dataSource.transaction("SERIALIZABLE", async (manager) => {
    await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `deployguard:smart-retail-jwt-reference:${PROJECT_ID}:${ENVIRONMENT}`,
    ]);
    const ownershipRows = await manager.query(
      `SELECT 1 FROM project_release_lane_ownerships
       WHERE project_id = $1 AND environment_name = $2 AND owner_lane = 'v1'
         AND lease_id = $3::uuid AND actor_id = 'smart-retail-jwt-remediation:v1'
         AND fencing_token = $4::bigint AND idempotency_key = $5
         AND request_fingerprint = $6 AND status IN ('acquired','heartbeat_active')
         AND expires_at > clock_timestamp() FOR UPDATE`,
      [PROJECT_ID, ENVIRONMENT, ownership.leaseId, ownership.fencingToken, ownership.idempotencyKey, ownership.requestFingerprint],
    );
    if (ownershipRows.length !== 1) throw new Error("JWT_SECRET_OWNERSHIP_LOST");
    const manifests = await manager.query(
      `SELECT id, revision::text AS revision, status, terraform_outputs AS outputs,
              terraform_outputs_hash AS "outputsHash"
       FROM infrastructure_manifests
       WHERE id = $1::uuid AND project_id = $2::uuid AND environment_name = $3
       FOR UPDATE`,
      [MANIFEST_ID, PROJECT_ID, ENVIRONMENT],
    );
    const manifest = manifests[0];
    if (!manifest || manifest.status !== "applied" || !manifest.outputs || typeof manifest.outputs !== "object"
      || canonicalSha256(manifest.outputs) !== manifest.outputsHash) {
      throw new Error("JWT_SECRET_FOUNDATION_INVALID");
    }
    const drafts = await manager.query(
      `SELECT draft_hash AS "draftHash", release_draft AS "releaseDraft"
       FROM initial_release_drafts
       WHERE id = $1::uuid AND project_id = $2::uuid AND environment_name = $3
         AND infrastructure_manifest_id = $4::uuid FOR UPDATE`,
      [DRAFT_ID, PROJECT_ID, ENVIRONMENT, MANIFEST_ID],
    );
    if (drafts.length !== 1 || canonicalSha256(drafts[0].releaseDraft) !== drafts[0].draftHash) {
      throw new Error("JWT_SECRET_DRAFT_INVALID");
    }
    const conflicts = await manager.query(
      `SELECT 1
       FROM deployment_intents
       WHERE project_id = $1::uuid AND environment_name = $2
         AND status IN ('received','planned','enqueued','running') LIMIT 1`,
      [PROJECT_ID, ENVIRONMENT],
    );
    const releaseEvidence = await manager.query(
      `SELECT EXISTS(SELECT 1 FROM release_manifests WHERE project_id = $1::uuid AND environment_name = $2) AS release,
              EXISTS(SELECT 1 FROM release_image_provenances WHERE project_id = $1::uuid AND environment_name = $2) AS provenance`,
      [PROJECT_ID, ENVIRONMENT],
    );
    if (conflicts.length || releaseEvidence[0]?.release || releaseEvidence[0]?.provenance) {
      throw new Error("JWT_SECRET_RELEASE_EVIDENCE_CONFLICT");
    }
    const outputs = manifest.outputs as Record<string, unknown>;
    const existing = outputs.application_jwt_secret_arn;
    if (existing !== undefined && existing !== secretArn) throw new Error("JWT_SECRET_OUTPUT_CONFLICT");
    const nextOutputs = { ...outputs, application_jwt_secret_arn: secretArn };
    const nextHash = canonicalSha256(nextOutputs);
    if (existing === secretArn) return { outputsHash: manifest.outputsHash as string, replayed: true };
    const updated = rows<{ outputsHash: string }>(await manager.query(
      `UPDATE infrastructure_manifests
       SET terraform_outputs = $2::jsonb, terraform_outputs_hash = $3,
           updated_at = clock_timestamp()
       WHERE id = $1::uuid AND status = 'applied'
       RETURNING terraform_outputs_hash AS "outputsHash"`,
      [MANIFEST_ID, JSON.stringify(nextOutputs), nextHash],
    ));
    if (updated.length !== 1 || updated[0].outputsHash !== nextHash) throw new Error("JWT_SECRET_BINDING_CONFLICT");
    await manager.query(
      `INSERT INTO audit_logs (action, category, resource_type, resource_id, status, metadata)
       VALUES ('foundation.bind_application_jwt_secret_reference', 'infrastructure', 'infrastructure_manifest', $1, 'completed', $2::jsonb)`,
      [MANIFEST_ID, JSON.stringify({ projectId: PROJECT_ID, environment: ENVIRONMENT, outputKey: "application_jwt_secret_arn", secretArn, priorOutputsHash: manifest.outputsHash, outputsHash: nextHash, evidenceHash: canonicalSha256({ secretArn, tags: expectedTags(), role: EXECUTION_ROLE_ARN }) })],
    );
    return { outputsHash: nextHash, replayed: false };
  });
}

async function main() {
  if (!enabled()) { safe("disabled", ["SMART_RETAIL_JWT_REMEDIATION_DISABLED"]); return; }
  const account = await aws(["sts", "get-caller-identity"]);
  if (account.Account !== ACCOUNT_ID) { safe("blocked", ["SMART_RETAIL_JWT_ACCOUNT_INVALID"]); return; }
  await dataSource.initialize();
  const ownershipService = new InactiveReleaseLaneOwnershipService(dataSource);
  const idempotencyKey = createHash("sha256").update(`${PROJECT_ID}:${ENVIRONMENT}:${MANIFEST_ID}:${DRAFT_ID}:application-jwt:v2`).digest("hex");
  const requestFingerprint = canonicalSha256({ projectId: PROJECT_ID, environment: ENVIRONMENT, manifestId: MANIFEST_ID, draftId: DRAFT_ID, purpose: "application-jwt", accountId: ACCOUNT_ID, region: REGION, executionRoleArn: EXECUTION_ROLE_ARN });
  const leaseId = deterministicUuid(`smart-retail-jwt-remediation:${idempotencyKey}`);
  let claim: Awaited<ReturnType<InactiveReleaseLaneOwnershipService["acquire"]>> | null = null;
  try {
    claim = await ownershipService.acquire({ projectId: PROJECT_ID, environmentName: ENVIRONMENT, lane: "v1", leaseId, actorId: "smart-retail-jwt-remediation:v1", idempotencyKey, requestFingerprint, leaseTtlMs: 180_000 });
    if (claim.disposition !== "acquired" || !claim.ownership) { safe("blocked", ["SMART_RETAIL_JWT_OWNERSHIP_UNAVAILABLE"]); return; }
    const secret = await ensureSecret();
    const result = await bind(secret.arn, { leaseId, fencingToken: claim.ownership.fencingToken, idempotencyKey, requestFingerprint });
    safe("completed", [secret.created ? "SMART_RETAIL_JWT_SECRET_CREATED" : "SMART_RETAIL_JWT_SECRET_ADOPTED", result.replayed ? "SMART_RETAIL_JWT_REFERENCE_REPLAYED" : "SMART_RETAIL_JWT_REFERENCE_BOUND"]);
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message) ? error.message : "SMART_RETAIL_JWT_REMEDIATION_FAILED";
    safe("blocked", [code]);
    process.exitCode = 2;
  } finally {
    if (claim?.disposition === "acquired" && claim.ownership) {
      await ownershipService.release({ projectId: PROJECT_ID, environmentName: ENVIRONMENT, lane: "v1", leaseId, actorId: "smart-retail-jwt-remediation:v1", fencingToken: claim.ownership.fencingToken }).catch(() => undefined);
    }
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

main();
