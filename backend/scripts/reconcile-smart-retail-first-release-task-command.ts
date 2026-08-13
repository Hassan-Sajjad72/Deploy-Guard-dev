import "reflect-metadata";
import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  StopTaskCommand,
  UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
import {
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { ProjectReleaseLaneOwnership } from "../src/orchestration-contracts/entities/release-lane-ownership.entity";
import { ReleaseManifest } from "../src/orchestration-contracts/entities/release-manifest.entity";
import { InactiveV1StableReleaseProjectionStore } from "../src/orchestration-contracts/worker-runtime/inactive-v1-stable-release-projection.store";
import { InactiveReleaseLaneOwnershipService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.service";

const PROJECT_ID = "5a294142-f12c-4ffc-ab9a-c4b096ebd659";
const CANDIDATE_ID = "86161431-d7ac-4841-98ee-e07a623c2af3";
const HEALTH_INTENT_ID = "9a9db9fb-18d0-4a85-a928-42d8e9f3e13b";
const INFRASTRUCTURE_ID = "a157c854-c9bb-42a0-a3b3-bbb5f7d376e0";
const SOURCE_TASK = "arn:aws:ecs:us-east-1:563149050793:task-definition/deployguard-5a294142:1";
const IMAGE_DIGEST = "sha256:2634ae69d9ba6454dcd505c39064740d493134847e9c845ecdaf6dbdb78aeca6";
const COMMAND = "npm run start";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Scope = {
  candidate: ReleaseManifest;
  infrastructure: InfrastructureManifest;
  clusterArn: string;
  serviceArn: string;
  targetGroupArn: string;
  albDnsName: string;
  healthPath: string;
  containerPort: number;
};

function id(value: string) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function rows<T>(value: unknown): T[] {
  return Array.isArray(value) && Array.isArray(value[0]) ? value[0] as T[] : Array.isArray(value) ? value as T[] : [];
}

function safe(state: string, safeCodes: readonly string[], details: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ state, safeCodes: [...new Set(safeCodes)], ...details })}\n`);
}

function assertEnabled() {
  if (process.env.SMART_RETAIL_TASK_COMMAND_CORRECTION_ENABLED !== "true"
    || process.env.TWO_LANE_CANARY_PROJECT_ID !== PROJECT_ID
    || process.env.TWO_LANE_CANARY_ENVIRONMENT !== "dev"
    || process.env.TWO_LANE_FIRST_RELEASE_TASK_COMMAND_CORRECTION !== "npm_run_start") {
    throw new Error("SMART_RETAIL_TASK_COMMAND_CORRECTION_CONFIGURATION_INVALID");
  }
}

async function loadScope(dataSource: DataSource): Promise<Scope> {
  const candidate = await dataSource.getRepository(ReleaseManifest).findOneByOrFail({ id: CANDIDATE_ID });
  const infrastructure = await dataSource.getRepository(InfrastructureManifest).findOneByOrFail({ id: INFRASTRUCTURE_ID });
  const outputs = infrastructure.terraformOutputs || {};
  const clusterArn = outputs.ecs_cluster_arn;
  const targetGroupArn = outputs.alb_target_group_arn;
  const albDnsName = outputs.alb_dns_name;
  const serviceArn = candidate.initialServiceArn;
  const healthPath = candidate.releaseSpec?.health?.path;
  const containerPort = candidate.releaseSpec?.runtime?.containerPort;
  if (candidate.projectId !== PROJECT_ID || candidate.environmentName !== "dev"
    || candidate.status !== "deploying" || candidate.imageDigest !== IMAGE_DIGEST
    || candidate.taskDefinitionArn !== SOURCE_TASK || !candidate.initialServiceArn
    || infrastructure.status !== "applied" || !infrastructure.terraformOutputsHash
    || typeof clusterArn !== "string" || typeof targetGroupArn !== "string"
    || typeof albDnsName !== "string" || typeof serviceArn !== "string"
    || typeof healthPath !== "string" || typeof containerPort !== "number") {
    throw new Error("SMART_RETAIL_TASK_COMMAND_CORRECTION_SCOPE_INVALID");
  }
  return { candidate, infrastructure, clusterArn, serviceArn, targetGroupArn, albDnsName, healthPath, containerPort };
}

function registrationInput(source: any) {
  const definition = source.taskDefinition;
  const container = definition?.containerDefinitions?.find((item: any) => item.name === "app");
  if (!definition || !container || definition.taskDefinitionArn !== SOURCE_TASK
    || container.image?.split("@")[1] !== IMAGE_DIGEST
    || JSON.stringify(container.command) !== JSON.stringify(["sh", "-c", "next start -H 0.0.0.0 -p ${PORT:-3000}"])) {
    throw new Error("SMART_RETAIL_TASK_COMMAND_SOURCE_INVALID");
  }
  return {
    family: definition.family,
    taskRoleArn: definition.taskRoleArn,
    executionRoleArn: definition.executionRoleArn,
    networkMode: definition.networkMode,
    containerDefinitions: definition.containerDefinitions.map((item: any) => item.name === "app"
      ? { ...item, command: ["sh", "-c", COMMAND] }
      : { ...item }),
    volumes: definition.volumes,
    placementConstraints: definition.placementConstraints,
    requiresCompatibilities: definition.requiresCompatibilities,
    cpu: definition.cpu,
    memory: definition.memory,
    pidMode: definition.pidMode,
    ipcMode: definition.ipcMode,
    proxyConfiguration: definition.proxyConfiguration,
    inferenceAccelerators: definition.inferenceAccelerators,
    ephemeralStorage: definition.ephemeralStorage,
    runtimePlatform: definition.runtimePlatform,
    enableFaultInjection: definition.enableFaultInjection,
    tags: source.tags,
  };
}

function normalized(definition: any) {
  const copy = JSON.parse(JSON.stringify(definition));
  for (const key of ["taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities", "registeredAt", "registeredBy", "deregisteredAt"]) delete copy[key];
  const container = copy.containerDefinitions?.find((item: any) => item.name === "app");
  if (container) delete container.command;
  return copy;
}

async function acquire(dataSource: DataSource, ownership: InactiveReleaseLaneOwnershipService) {
  const leaseId = id(`smart-retail-task-command-owner:${CANDIDATE_ID}:${IMAGE_DIGEST}`);
  const actorId = `smart-retail-task-command:${CANDIDATE_ID}`;
  const owned = await ownership.acquire({
    projectId: PROJECT_ID, environmentName: "dev", lane: "v1", leaseId, actorId,
    idempotencyKey: canonicalSha256({ operation: "smart_retail_task_command_correction", candidateId: CANDIDATE_ID, imageDigest: IMAGE_DIGEST, command: COMMAND }),
    requestFingerprint: canonicalSha256({ sourceTask: SOURCE_TASK, command: COMMAND }),
    leaseTtlMs: 5 * 60_000, ownV1IntentId: HEALTH_INTENT_ID,
  });
  if (owned.disposition !== "acquired" && owned.disposition !== "already_owned") throw new Error("SMART_RETAIL_TASK_COMMAND_OWNERSHIP_BLOCKED");
  const workerId = `smart-retail-task-command:${CANDIDATE_ID}`;
  const token = await dataSource.transaction("SERIALIZABLE", async (manager) => {
    const active = rows(await manager.query(
      `SELECT id FROM deployment_intents WHERE id = $1 AND project_id = $2
        AND environment_name = 'dev' AND kind = 'deploy' AND classification = 'release_only'
        AND ((status = 'failed' AND failure_code = 'FIRST_RELEASE_HEALTH_VERIFICATION_TIMEOUT')
          OR (status = 'running' AND EXISTS (
            SELECT 1 FROM deployment_side_effects effect
             WHERE effect.intent_id = deployment_intents.id
               AND effect.effect_type = 'ecs.register_task_definition_command_correction'
               AND effect.status = 'started'
          ))) FOR UPDATE`,
      [HEALTH_INTENT_ID, PROJECT_ID],
    ));
    if (active.length !== 1) throw new Error("SMART_RETAIL_TASK_COMMAND_INTENT_INVALID");
    const [fence] = rows<{ token: string }>(await manager.query(
      `SELECT (COALESCE(MAX(fencing_token), 0) + 1)::text AS token
       FROM project_operation_leases WHERE project_id = $1 AND environment_name = 'dev'`, [PROJECT_ID],
    ));
    if (!fence?.token) throw new Error("SMART_RETAIL_TASK_COMMAND_FENCE_INVALID");
    // A completed/failed recovery attempt keeps its lease row as audit evidence.
    // The new fenced attempt therefore needs its own immutable lease identity.
    const operationLeaseId = id(`smart-retail-task-command-operation-resume:${CANDIDATE_ID}:${IMAGE_DIGEST}:${fence.token}`);
    await manager.query(
      `INSERT INTO project_operation_leases (id, project_id, environment_name, lane, scope, intent_id, pipeline_run_id, destroy_operation_id, owner_worker_id, fencing_token, status, acquired_at, heartbeat_at, expires_at, released_at, metadata, created_at, updated_at)
       VALUES ($1,$2,'dev','release','execute',$3,NULL,NULL,$4,$5::bigint,'acquired',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '30 minutes',NULL,$6::jsonb,clock_timestamp(),clock_timestamp())`,
      [operationLeaseId, PROJECT_ID, HEALTH_INTENT_ID, workerId, fence.token, JSON.stringify({ operation: "task_command_correction", candidateId: CANDIDATE_ID, sourceTask: SOURCE_TASK, command: COMMAND })],
    );
    await manager.query(`UPDATE deployment_intents SET status = 'running', failure_code = NULL, failure_message = NULL, completed_at = NULL, updated_at = clock_timestamp() WHERE id = $1`, [HEALTH_INTENT_ID]);
    return { token: fence.token, operationLeaseId };
  });
  return { leaseId, actorId, ownership: owned.ownership, operationLeaseId: token.operationLeaseId, workerId, token: token.token };
}

async function journal(dataSource: DataSource, input: { operationId: string; effect: string; status: "started" | "succeeded" | "uncertain"; leaseId: string; workerId: string; token: string; fingerprint: string; code?: string; result?: string }) {
  await dataSource.transaction("SERIALIZABLE", async (manager) => {
    if (input.status === "started") {
      await manager.query(
        `INSERT INTO deployment_side_effects (id,intent_id,project_id,environment_name,operation_id,effect_type,idempotency_key,request_fingerprint,lease_id,owner_worker_id,fencing_token,status,reconciliation_required,attempt_started_at,deadline_at,created_at,updated_at)
         VALUES ($1,$2,$3,'dev',$1,$4,$5,$6,$7,$8,$9::bigint,'started',false,clock_timestamp(),clock_timestamp()+interval '30 minutes',clock_timestamp(),clock_timestamp())`,
        [input.operationId, HEALTH_INTENT_ID, PROJECT_ID, input.effect, canonicalSha256({ effect: input.effect, candidate: CANDIDATE_ID, fingerprint: input.fingerprint }), input.fingerprint, input.leaseId, input.workerId, input.token],
      );
    } else {
      const raw = await manager.query(
        `UPDATE deployment_side_effects SET status=$2::varchar,safe_result_code=$3::varchar,result_fingerprint=$4::char(64),failure_code=CASE WHEN $2::varchar='uncertain'::varchar THEN $3::varchar ELSE NULL END,reconciliation_required=($2::varchar='uncertain'::varchar),completed_at=CASE WHEN $2::varchar='uncertain'::varchar THEN NULL ELSE clock_timestamp() END,updated_at=clock_timestamp() WHERE id=$1 AND status='started' RETURNING id`,
        [input.operationId, input.status, input.code ?? null, input.result ?? null],
      );
      const affected = Array.isArray(raw) && Array.isArray(raw[0])
        ? Number(raw[1])
        : Array.isArray(raw) ? raw.length : 0;
      if (affected !== 1) throw new Error("SMART_RETAIL_TASK_COMMAND_JOURNAL_CONFLICT");
    }
  });
}

async function main() {
  assertEnabled();
  const options = AppDataSource.options as DataSourceOptions;
  const dataSource = new DataSource({ ...options, entities: [InfrastructureManifest, ReleaseManifest, ProjectReleaseLaneOwnership], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
  await dataSource.initialize();
  const config = new ConfigService(process.env);
  const region = config.get<string>("AWS_REGION", "");
  const ecs = new ECSClient({ region }); const elbv2 = new ElasticLoadBalancingV2Client({ region });
  const ownership = new InactiveReleaseLaneOwnershipService(dataSource);
  let fence: Awaited<ReturnType<typeof acquire>> | null = null;
  let trusted = true;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  try {
    const scope = await loadScope(dataSource);
    const source = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: SOURCE_TASK, include: ["TAGS"] }));
    const registration = registrationInput(source);
    const sourceComparable = normalized(source.taskDefinition);
    const taskInputHash = canonicalSha256({ sourceTask: SOURCE_TASK, sourceComparable, command: COMMAND, infrastructureHash: scope.infrastructure.terraformOutputsHash, imageDigest: IMAGE_DIGEST });
    const current = await ecs.send(new DescribeServicesCommand({ cluster: scope.clusterArn, services: [scope.serviceArn] }));
    if (current.services?.length !== 1 || current.services[0].taskDefinition !== SOURCE_TASK || current.services[0].status !== "ACTIVE") throw new Error("SMART_RETAIL_TASK_COMMAND_SERVICE_INVALID");
    fence = await acquire(dataSource, ownership);
    heartbeat = setInterval(() => {
      if (!fence || !trusted) return;
      void ownership.renew({ projectId: PROJECT_ID, environmentName: "dev", lane: "v1", leaseId: fence.ownership.leaseId, actorId: fence.actorId, fencingToken: fence.ownership.fencingToken, leaseTtlMs: 5 * 60_000 })
        .then((result) => { trusted = result.disposition === "acquired" || result.disposition === "already_owned"; })
        .catch(() => { trusted = false; });
      void dataSource.query(`UPDATE project_operation_leases SET heartbeat_at=clock_timestamp(),expires_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() WHERE id=$1 AND owner_worker_id=$2 AND fencing_token=$3::bigint AND status IN ('acquired','heartbeat_active')`, [fence.operationLeaseId, fence.workerId, fence.token])
        .then((result: any) => { if ((result?.[1] ?? result?.affected ?? 1) !== 1) trusted = false; })
        .catch(() => { trusted = false; });
    }, 60_000);
    heartbeat.unref?.();
    const registerOperationId = id(`smart-retail-task-command-register:${CANDIDATE_ID}:${taskInputHash}`);
    const correctedTask = `${SOURCE_TASK.split(":").slice(0, -1).join(":")}:2`;
    let detail = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: correctedTask, include: ["TAGS"] })).catch(() => null);
    let taskArn = detail?.taskDefinition?.taskDefinitionArn;
    if (!detail || !taskArn) {
      await journal(dataSource, { operationId: registerOperationId, effect: "ecs.register_task_definition_command_correction", status: "started", leaseId: fence.operationLeaseId, workerId: fence.workerId, token: fence.token, fingerprint: taskInputHash });
      let registered: any;
      try {
        registered = await ecs.send(new RegisterTaskDefinitionCommand(registration));
      } catch {
        await journal(dataSource, { operationId: registerOperationId, effect: "ecs.register_task_definition_command_correction", status: "uncertain", leaseId: fence.operationLeaseId, workerId: fence.workerId, token: fence.token, fingerprint: taskInputHash, code: "SMART_RETAIL_TASK_COMMAND_REGISTRATION_UNCERTAIN" });
        throw new Error("SMART_RETAIL_TASK_COMMAND_REGISTRATION_UNCERTAIN");
      }
      taskArn = registered.taskDefinition?.taskDefinitionArn;
      detail = taskArn ? await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskArn, include: ["TAGS"] })) : null;
    }
    if (!taskArn || !detail || JSON.stringify(normalized(detail.taskDefinition)) !== JSON.stringify(sourceComparable)
      || JSON.stringify(detail.taskDefinition?.containerDefinitions?.find((item) => item.name === "app")?.command) !== JSON.stringify(["sh", "-c", COMMAND])) throw new Error("SMART_RETAIL_TASK_COMMAND_REGISTRATION_INVALID");
    await journal(dataSource, { operationId: registerOperationId, effect: "ecs.register_task_definition_command_correction", status: "succeeded", leaseId: fence.operationLeaseId, workerId: fence.workerId, token: fence.token, fingerprint: taskInputHash, code: "ECS_TASK_COMMAND_CORRECTED", result: canonicalSha256({ taskArn, taskInputHash }) });
    const updateInputHash = canonicalSha256({ serviceArn: scope.serviceArn, clusterArn: scope.clusterArn, taskArn });
    const updateOperationId = id(`smart-retail-task-command-update:${CANDIDATE_ID}:${updateInputHash}`);
    await journal(dataSource, { operationId: updateOperationId, effect: "ecs.update_existing_service_command_correction", status: "started", leaseId: fence.operationLeaseId, workerId: fence.workerId, token: fence.token, fingerprint: updateInputHash });
    let updated: any;
    try { updated = await ecs.send(new UpdateServiceCommand({ cluster: scope.clusterArn, service: scope.serviceArn, taskDefinition: taskArn })); }
    catch { await journal(dataSource, { operationId: updateOperationId, effect: "ecs.update_existing_service_command_correction", status: "uncertain", leaseId: fence.operationLeaseId, workerId: fence.workerId, token: fence.token, fingerprint: updateInputHash, code: "SMART_RETAIL_TASK_COMMAND_SERVICE_UPDATE_UNCERTAIN" }); throw new Error("SMART_RETAIL_TASK_COMMAND_SERVICE_UPDATE_UNCERTAIN"); }
    if (updated.service?.serviceArn !== scope.serviceArn || updated.service.taskDefinition !== taskArn) throw new Error("SMART_RETAIL_TASK_COMMAND_SERVICE_UPDATE_INVALID");
    await journal(dataSource, { operationId: updateOperationId, effect: "ecs.update_existing_service_command_correction", status: "succeeded", leaseId: fence.operationLeaseId, workerId: fence.workerId, token: fence.token, fingerprint: updateInputHash, code: "ECS_SERVICE_TASK_COMMAND_UPDATED", result: canonicalSha256({ serviceArn: scope.serviceArn, taskArn, updateInputHash }) });
    await dataSource.transaction("SERIALIZABLE", async (manager) => { await manager.query(`UPDATE release_manifests SET infrastructure_manifest_id=$2, task_definition_input_hash=$3, task_definition_arn=$4, deployment_started_at=clock_timestamp(), updated_at=clock_timestamp() WHERE id=$1 AND status='deploying'`, [CANDIDATE_ID, INFRASTRUCTURE_ID, taskInputHash, taskArn]); });
    const deadline = Date.now() + 15 * 60_000;
    let url = "";
    while (Date.now() < deadline) {
      if (!trusted) throw new Error("SMART_RETAIL_TASK_COMMAND_OWNERSHIP_LOST");
      const [service, targets] = await Promise.all([ecs.send(new DescribeServicesCommand({ cluster: scope.clusterArn, services: [scope.serviceArn] })), elbv2.send(new DescribeTargetHealthCommand({ TargetGroupArn: scope.targetGroupArn }))]);
      const currentService = service.services?.[0]; const primary = currentService?.deployments?.find((item) => item.status === "PRIMARY");
      const healthy = targets.TargetHealthDescriptions?.length === 1 && targets.TargetHealthDescriptions[0].TargetHealth?.State === "healthy";
      url = `http://${scope.albDnsName}${scope.healthPath}`;
      if (currentService?.taskDefinition === taskArn && primary?.rolloutState === "COMPLETED" && currentService.desiredCount === 1 && currentService.runningCount === 1 && (currentService.pendingCount ?? 0) === 0 && healthy) {
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
        if (response?.status === 200) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    const service = await ecs.send(new DescribeServicesCommand({ cluster: scope.clusterArn, services: [scope.serviceArn] }));
    const targets = await elbv2.send(new DescribeTargetHealthCommand({ TargetGroupArn: scope.targetGroupArn }));
    const verified = service.services?.[0]; const primary = verified?.deployments?.find((item) => item.status === "PRIMARY");
    const healthy = targets.TargetHealthDescriptions?.length === 1 && targets.TargetHealthDescriptions[0].TargetHealth?.State === "healthy";
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!verified || verified.taskDefinition !== taskArn || primary?.rolloutState !== "COMPLETED" || verified.desiredCount !== 1 || verified.runningCount !== 1 || (verified.pendingCount ?? 0) !== 0 || !healthy || response?.status !== 200) throw new Error("SMART_RETAIL_TASK_COMMAND_HEALTH_BLOCKED");
    const products = await fetch(`http://${scope.albDnsName}/api/products`, { signal: AbortSignal.timeout(10_000) });
    if (products.status !== 200) throw new Error("SMART_RETAIL_DATABASE_OPERATION_BLOCKED");
    const productsHash = canonicalSha256(await products.json());
    const tasks = await ecs.send(new ListTasksCommand({ cluster: scope.clusterArn, serviceName: verified.serviceName, desiredStatus: "RUNNING" }));
    if (tasks.taskArns?.length !== 1) throw new Error("SMART_RETAIL_TASK_RESTART_EVIDENCE_BLOCKED");
    await ecs.send(new StopTaskCommand({ cluster: scope.clusterArn, task: tasks.taskArns[0], reason: "DeployGuard verified first-release persistence check" }));
    const restartDeadline = Date.now() + 10 * 60_000;
    while (Date.now() < restartDeadline) {
      if (!trusted) throw new Error("SMART_RETAIL_TASK_COMMAND_OWNERSHIP_LOST");
      const next = await ecs.send(new DescribeServicesCommand({ cluster: scope.clusterArn, services: [scope.serviceArn] }));
      const item = next.services?.[0]; const deployment = item?.deployments?.find((entry) => entry.status === "PRIMARY");
      if (item?.taskDefinition === taskArn && deployment?.rolloutState === "COMPLETED" && item.runningCount === 1 && item.pendingCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    const persisted = await fetch(`http://${scope.albDnsName}/api/products`, { signal: AbortSignal.timeout(10_000) });
    if (persisted.status !== 200 || canonicalSha256(await persisted.json()) !== productsHash) throw new Error("SMART_RETAIL_DATABASE_PERSISTENCE_BLOCKED");
    const evidenceHash = canonicalSha256({ taskArn, serviceArn: scope.serviceArn, url, productsHash, taskCommand: COMMAND });
    await dataSource.transaction("SERIALIZABLE", async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`deployguard:smart-retail-task-command:${PROJECT_ID}:dev`]);
      const candidate = await manager.getRepository(ReleaseManifest).findOneByOrFail({ id: CANDIDATE_ID });
      candidate.status = "stable"; candidate.infrastructureManifestId = INFRASTRUCTURE_ID; candidate.taskDefinitionArn = taskArn; candidate.taskDefinitionInputHash = taskInputHash;
      candidate.healthVerifiedAt = new Date(); candidate.promotedAt = new Date(); candidate.failureCode = null; candidate.failureMessage = null;
      candidate.healthEvidence = { schemaVersion: 1, safeCode: "FIRST_RELEASE_HEALTHY", evidenceHash, applicationUrl: url };
      await manager.getRepository(ReleaseManifest).save(candidate);
      await manager.query(`UPDATE deployment_intents SET status='completed', completed_at=clock_timestamp(), failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp() WHERE id=$1 AND status='running'`, [HEALTH_INTENT_ID]);
      await new InactiveV1StableReleaseProjectionStore(dataSource).syncWithinTransaction(manager, CANDIDATE_ID);
    });
    safe("completed", ["SMART_RETAIL_FIRST_RELEASE_RECONCILED"], { taskDefinitionRevision: taskArn.split(":").pop(), serviceStatus: "stable", httpStatus: 200, databasePersistence: "verified" });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (fence) {
      await dataSource.query(`UPDATE project_operation_leases SET status='released',released_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND owner_worker_id=$2 AND fencing_token=$3::bigint AND status IN ('acquired','heartbeat_active')`, [fence.operationLeaseId, fence.workerId, fence.token]).catch(() => undefined);
      await ownership.release({ projectId: PROJECT_ID, environmentName: "dev", lane: "v1", leaseId: fence.ownership.leaseId, actorId: fence.actorId, fencingToken: fence.ownership.fencingToken }).catch(() => undefined);
    }
    await dataSource.destroy().catch(() => undefined);
  }
}

void main().catch((error) => {
  const sqlState = typeof error === "object" && error !== null && "driverError" in error
    ? String((error as { driverError?: { code?: unknown } }).driverError?.code ?? "") : "";
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message
    : /^[0-9A-Z]{5}$/.test(sqlState) ? `SMART_RETAIL_TASK_COMMAND_SQLSTATE_${sqlState}`
      : "SMART_RETAIL_TASK_COMMAND_RECONCILIATION_FAILED";
  safe("blocked", [code]); process.exitCode = 2;
});
