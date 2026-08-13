import "reflect-metadata";
import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { DescribeServicesCommand, ECSClient } from "@aws-sdk/client-ecs";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { ProjectReleaseLaneOwnership } from "../src/orchestration-contracts/entities/release-lane-ownership.entity";
import { ReleaseManifest } from "../src/orchestration-contracts/entities/release-manifest.entity";
import { InactiveReleaseLaneOwnershipService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.service";

const PROJECT_ID = "5a294142-f12c-4ffc-ab9a-c4b096ebd659";
const CANDIDATE_ID = "86161431-d7ac-4841-98ee-e07a623c2af3";
const HEALTH_INTENT_ID = "9a9db9fb-18d0-4a85-a928-42d8e9f3e13b";
const INFRASTRUCTURE_ID = "a157c854-c9bb-42a0-a3b3-bbb5f7d376e0";
const TASK = "arn:aws:ecs:us-east-1:563149050793:task-definition/deployguard-5a294142:2";
const SAFE_CODE = "FIRST_RELEASE_DATABASE_BINDING_INVALID";

function deterministicId(value: string) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4"; hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function enabled() {
  return process.env.SMART_RETAIL_TASK_COMMAND_CORRECTION_ENABLED === "true"
    && process.env.TWO_LANE_CANARY_PROJECT_ID === PROJECT_ID
    && process.env.TWO_LANE_CANARY_ENVIRONMENT === "dev"
    && process.env.TWO_LANE_FIRST_RELEASE_TASK_COMMAND_CORRECTION === "npm_run_start";
}

async function main() {
  if (!enabled()) throw new Error("SMART_RETAIL_TASK_COMMAND_CORRECTION_CONFIGURATION_INVALID");
  const dataSource = new DataSource({ ...(AppDataSource.options as DataSourceOptions), entities: [InfrastructureManifest, ReleaseManifest, ProjectReleaseLaneOwnership], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
  await dataSource.initialize();
  const ownership = new InactiveReleaseLaneOwnershipService(dataSource);
  const leaseId = deterministicId(`smart-retail-database-binding-blocker:${CANDIDATE_ID}`);
  const actorId = `smart-retail-database-binding-blocker:${CANDIDATE_ID}`;
  let acquired: Awaited<ReturnType<typeof ownership.acquire>> | null = null;
  let operationLease: { id: string; workerId: string; token: string } | null = null;
  try {
    const candidate = await dataSource.getRepository(ReleaseManifest).findOneByOrFail({ id: CANDIDATE_ID });
    const infrastructure = await dataSource.getRepository(InfrastructureManifest).findOneByOrFail({ id: INFRASTRUCTURE_ID });
    const clusterArn = infrastructure.terraformOutputs?.ecs_cluster_arn;
    if (candidate.projectId !== PROJECT_ID || candidate.environmentName !== "dev" || candidate.status !== "deploying"
      || candidate.taskDefinitionArn !== TASK || !candidate.initialServiceArn || infrastructure.status !== "applied" || typeof clusterArn !== "string") {
      throw new Error("SMART_RETAIL_DATABASE_BINDING_SCOPE_INVALID");
    }
    const ecs = new ECSClient({ region: new ConfigService(process.env).get<string>("AWS_REGION", "") });
    const service = await ecs.send(new DescribeServicesCommand({ cluster: clusterArn, services: [candidate.initialServiceArn] }));
    const verified = service.services?.[0];
    const primary = verified?.deployments?.find((deployment) => deployment.status === "PRIMARY");
    if (!verified || verified.taskDefinition !== TASK || primary?.rolloutState !== "COMPLETED" || verified.desiredCount !== 1 || verified.runningCount !== 1 || (verified.pendingCount ?? 0) !== 0) {
      throw new Error("SMART_RETAIL_DATABASE_BINDING_SERVICE_EVIDENCE_INVALID");
    }
    const endpoint = `http://${infrastructure.terraformOutputs?.alb_dns_name}`;
    const root = await fetch(endpoint, { signal: AbortSignal.timeout(10_000) });
    const probe = await fetch(`${endpoint}/api/products`, { signal: AbortSignal.timeout(10_000) });
    const body = await probe.text();
    if (root.status !== 200 || probe.status !== 500 || !body.includes("ECONNREFUSED 127.0.0.1:5432")) {
      throw new Error("SMART_RETAIL_DATABASE_BINDING_NOT_CONCLUSIVE");
    }
    acquired = await ownership.acquire({
      projectId: PROJECT_ID, environmentName: "dev", lane: "v1", leaseId, actorId,
      idempotencyKey: createHash("sha256").update(`${CANDIDATE_ID}:${TASK}:${SAFE_CODE}`).digest("hex"),
      requestFingerprint: createHash("sha256").update(`${INFRASTRUCTURE_ID}:${TASK}:root-200:products-500`).digest("hex"),
      leaseTtlMs: 5 * 60_000, ownV1IntentId: HEALTH_INTENT_ID,
    });
    if (acquired.disposition !== "acquired" && acquired.disposition !== "already_owned") throw new Error("SMART_RETAIL_DATABASE_BINDING_OWNERSHIP_BLOCKED");
    operationLease = await dataSource.transaction("SERIALIZABLE", async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`deployguard:smart-retail-database-binding:${PROJECT_ID}:dev`]);
      const [fence] = await manager.query(`SELECT (COALESCE(MAX(fencing_token),0)+1)::text AS token FROM project_operation_leases WHERE project_id=$1 AND environment_name='dev'`, [PROJECT_ID]);
      const token = fence?.token; if (!token) throw new Error("SMART_RETAIL_DATABASE_BINDING_FENCE_INVALID");
      const id = deterministicId(`smart-retail-database-binding-lease:${CANDIDATE_ID}:${token}`);
      const workerId = `smart-retail-database-binding:${CANDIDATE_ID}`;
      await manager.query(`INSERT INTO project_operation_leases (id,project_id,environment_name,lane,scope,intent_id,owner_worker_id,fencing_token,status,acquired_at,heartbeat_at,expires_at,metadata,created_at,updated_at)
        VALUES ($1,$2,'dev','release','execute',$3,$4,$5::bigint,'acquired',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes',$6::jsonb,clock_timestamp(),clock_timestamp())`,
      [id, PROJECT_ID, HEALTH_INTENT_ID, workerId, token, JSON.stringify({ operation: "first_release_database_binding_blocker", candidateId: CANDIDATE_ID, taskDefinitionRevision: 2, safeCode: SAFE_CODE })]);
      const candidateResult = await manager.query(`UPDATE release_manifests SET status='failed',failure_code=$2::varchar,failure_message='Validated runtime database binding does not match the pinned source contract',health_evidence=$3::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND status='deploying' RETURNING id`,
      [CANDIDATE_ID, SAFE_CODE, JSON.stringify({ schemaVersion: 1, safeCode: SAFE_CODE, rootHttpStatus: 200, databaseProbeHttpStatus: 500, taskDefinitionRevision: 2 })]);
      const intentResult = await manager.query(`UPDATE deployment_intents SET status='failed',failure_code=$2::varchar,failure_message='Validated runtime database binding does not match the pinned source contract',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND status='running' RETURNING id`, [HEALTH_INTENT_ID, SAFE_CODE]);
      if ((candidateResult?.[1] ?? candidateResult?.length) !== 1 || (intentResult?.[1] ?? intentResult?.length) !== 1) throw new Error("SMART_RETAIL_DATABASE_BINDING_FINALIZATION_CONFLICT");
      return { id, workerId, token };
    });
    process.stdout.write(`${JSON.stringify({ state: "blocked", safeCodes: [SAFE_CODE], taskDefinitionRevision: 2, rootHttpStatus: 200, databaseProbeHttpStatus: 500 })}\n`);
  } finally {
    if (operationLease) await dataSource.query(`UPDATE project_operation_leases SET status='released',released_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND owner_worker_id=$2 AND fencing_token=$3::bigint AND status IN ('acquired','heartbeat_active')`, [operationLease.id, operationLease.workerId, operationLease.token]).catch(() => undefined);
    const owned = acquired && "ownership" in acquired ? acquired.ownership : null;
    if (owned) await ownership.release({ projectId: PROJECT_ID, environmentName: "dev", lane: "v1", leaseId: owned.leaseId, actorId, fencingToken: owned.fencingToken }).catch(() => undefined);
    await dataSource.destroy().catch(() => undefined);
  }
}

void main().catch((error) => { process.stdout.write(`${JSON.stringify({ state: "blocked", safeCodes: [error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "SMART_RETAIL_DATABASE_BINDING_RECONCILIATION_FAILED"] })}\n`); process.exitCode = 2; });
