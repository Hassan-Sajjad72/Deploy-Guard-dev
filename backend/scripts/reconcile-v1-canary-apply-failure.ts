import "reflect-metadata";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { InactiveReleaseLaneOwnershipService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.service";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";

const output = (state: string, safeCodes: string[], detail: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ state, safeCodes, ...detail })}\n`);

void (async () => {
  const projectId = process.env.TWO_LANE_CANARY_PROJECT_ID || "";
  const manifestId = process.env.TWO_LANE_CANARY_APPLY_MANIFEST_ID || "";
  const planHash = process.env.TWO_LANE_CANARY_APPLY_PLAN_HASH || "";
  const workspace = process.env.TWO_LANE_CANARY_APPLY_WORKSPACE || "";
  const bucket = process.env.TERRAFORM_STATE_BUCKET || "";
  const region = process.env.TERRAFORM_STATE_REGION || "";
  const stateKey = `projects/${projectId}/dev/v1/3.tfstate`;
  if (process.env.TWO_LANE_CANARY_APPLY_RECONCILE_ENABLED !== "true"
    || !projectId || !manifestId || !/^[0-9a-f]{64}$/.test(planHash)
    || !workspace || !bucket || !region) {
    throw new Error("CANARY_RECONCILIATION_CONFIGURATION_INVALID");
  }

  const show = JSON.parse(String(execFileSync("terraform", [`-chdir=${workspace}`, "show", "-json", "tfplan"], { env: process.env }))) as {
    variables?: Record<string, { value?: unknown }>;
  };
  if (show.variables?.offline_plan_mode?.value !== true) throw new Error("CANARY_RECONCILIATION_EVIDENCE_MISMATCH");
  const state = String(execFileSync("terraform", [`-chdir=${workspace}`, "state", "list"], { env: process.env }));
  const managed = state.split(/\r?\n/).map((value) => value.trim()).filter((value) => value && !value.includes(".data."));
  if (managed.length !== 0) throw new Error("CANARY_RECONCILIATION_MANAGED_RESOURCES_PRESENT");
  const head = JSON.parse(String(execFileSync("aws", ["s3api", "head-object", "--bucket", bucket, "--key", stateKey, "--region", region, "--output", "json"], { env: process.env }))) as { VersionId?: string };
  if (!head.VersionId || head.VersionId === "null") throw new Error("CANARY_RECONCILIATION_STATE_VERSION_UNVERIFIED");
  try {
    execFileSync("aws", ["s3api", "head-object", "--bucket", bucket, "--key", `${stateKey}.tflock`, "--region", region], { env: process.env, stdio: "pipe" });
    throw new Error("CANARY_RECONCILIATION_LOCK_ACTIVE");
  } catch (error) {
    if (error instanceof Error && error.message === "CANARY_RECONCILIATION_LOCK_ACTIVE") throw error;
  }
  const tagged = Number(String(execFileSync("aws", [
    "resourcegroupstaggingapi", "get-resources", "--region", region,
    "--tag-filters", `Key=deployguard:project-id,Values=${projectId}`,
    "Key=deployguard:environment,Values=dev",
    `Key=deployguard:infrastructure-manifest-id,Values=${manifestId}`,
    "--query", "length(ResourceTagMappingList)", "--output", "text",
  ], { env: process.env })).trim());
  if (tagged !== 0) throw new Error("CANARY_RECONCILIATION_TAGGED_RESOURCES_PRESENT");

  const dataSource = new DataSource({
    ...AppDataSource.options,
    entities: [], migrations: [], synchronize: false, logging: false,
  } as DataSourceOptions);
  await dataSource.initialize();
  try {
    const actorId = `canary-foundation-apply:${manifestId}`;
    const identity = canonicalSha256({
      operation: "v1_canary_foundation_apply", projectId,
      environmentName: "dev", manifestId, approvedPlanHash: planHash,
    });
    const hex = createHash("sha256").update(`canary-foundation-apply:${manifestId}:${planHash}`).digest("hex").slice(0, 32).split("");
    hex[12] = "4";
    hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    const leaseId = `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
    const ownership = new InactiveReleaseLaneOwnershipService(dataSource);
    const reacquired = await ownership.acquire({
      projectId, environmentName: "dev", lane: "v1", leaseId, actorId,
      idempotencyKey: identity, requestFingerprint: planHash, leaseTtlMs: 300_000,
    });
    if (reacquired.disposition !== "acquired" && reacquired.disposition !== "already_owned") {
      throw new Error("CANARY_RECONCILIATION_OWNERSHIP_CONFLICT");
    }
    const fence = {
      leaseId: reacquired.ownership.leaseId,
      actorId,
      fencingToken: reacquired.ownership.fencingToken,
    };
    await dataSource.transaction("SERIALIZABLE", async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`deployguard:v1-infrastructure-apply:${manifestId}`]);
      const manifests = await manager.query(
        `SELECT status, project_id AS "projectId", environment_name AS environment,
                revision::text, plan_artifact_sha256 AS "planHash"
         FROM infrastructure_manifests WHERE id=$1 FOR UPDATE`,
        [manifestId],
      );
      const manifest = manifests[0];
      if (!manifest || manifest.projectId !== projectId || manifest.environment !== "dev"
        || manifest.revision !== "3" || manifest.planHash !== planHash
        || manifest.status !== "manual_review") {
        throw new Error("CANARY_RECONCILIATION_MANIFEST_CONFLICT");
      }
      const owners = await manager.query(
        `SELECT lease_id AS "leaseId", actor_id AS "actorId",
                fencing_token::text AS "fencingToken", owner_lane AS lane,
                expires_at > clock_timestamp() AS active
         FROM project_release_lane_ownerships
         WHERE project_id=$1 AND environment_name='dev' FOR UPDATE`,
        [projectId],
      );
      if (!owners[0] || owners[0].lane !== "v1" || !owners[0].active
        || owners[0].leaseId !== fence.leaseId || owners[0].actorId !== fence.actorId
        || owners[0].fencingToken !== fence.fencingToken) {
        throw new Error("CANARY_RECONCILIATION_OWNERSHIP_CONFLICT");
      }
      const updated = await manager.query(
        `UPDATE infrastructure_manifests
         SET status='failed', resource_count=0, state_version_id=$2,
             terraform_outputs=NULL, terraform_outputs_hash=NULL,
             failure_code='TERRAFORM_APPLY_FAILED_OFFLINE_PROVIDER_PLAN',
             failure_message='The approved saved plan used offline provider mode. No managed foundation resource was created.',
             plan_artifact_reference=COALESCE(plan_artifact_reference,'{}'::jsonb) || $3::jsonb,
             updated_at=clock_timestamp()
         WHERE id=$1 AND status='manual_review' RETURNING id`,
        [manifestId, head.VersionId, JSON.stringify({
          phase: "apply_failed", applyOutcome: "failed_no_managed_resources",
          verifiedManagedResourceCount: 0, reconciliationCode: "OFFLINE_PROVIDER_PLAN",
        })],
      );
      const rows = Array.isArray(updated[0]) ? updated[0] : updated;
      if (rows.length !== 1) throw new Error("CANARY_RECONCILIATION_MANIFEST_CONFLICT");
    });
    const released = await ownership.release({
      projectId, environmentName: "dev", lane: "v1", ...fence,
    });
    if (released.disposition !== "already_owned") throw new Error("CANARY_RECONCILIATION_OWNERSHIP_RELEASE_FAILED");
    output("failed", ["TERRAFORM_APPLY_FAILED_OFFLINE_PROVIDER_PLAN"], {
      manifestRevision: "3", managedResourceCount: 0,
      stateStatus: "versioned_failure_evidence", lockStatus: "released",
      ownershipStatus: "released",
    });
  } finally {
    await dataSource.destroy();
  }
})().catch((error) => {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message : "CANARY_RECONCILIATION_FAILED";
  output("blocked", [code]);
  process.exitCode = 1;
});
