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
import { DescribeTargetHealthCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { ProjectReleaseLaneOwnership } from "../src/orchestration-contracts/entities/release-lane-ownership.entity";
import { ReleaseManifest } from "../src/orchestration-contracts/entities/release-manifest.entity";
import { InactiveReleaseLaneOwnershipService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.service";
import { InactiveV1StableReleaseProjectionStore } from "../src/orchestration-contracts/worker-runtime/inactive-v1-stable-release-projection.store";

const PROJECT_ID = "5a294142-f12c-4ffc-ab9a-c4b096ebd659";
const CANDIDATE_ID = "86161431-d7ac-4841-98ee-e07a623c2af3";
const INTENT_ID = "9a9db9fb-18d0-4a85-a928-42d8e9f3e13b";
const INFRASTRUCTURE_ID = "a157c854-c9bb-42a0-a3b3-bbb5f7d376e0";
const SOURCE_TASK = "arn:aws:ecs:us-east-1:563149050793:task-definition/deployguard-5a294142:2";
const CORRECTED_TASK = "arn:aws:ecs:us-east-1:563149050793:task-definition/deployguard-5a294142:3";
const IMAGE_DIGEST = "sha256:2634ae69d9ba6454dcd505c39064740d493134847e9c845ecdaf6dbdb78aeca6";
const SAFE_BLOCKER = "FIRST_RELEASE_DATABASE_BINDING_INVALID";
const SAFE_READY = "FIRST_RELEASE_HEALTHY";
let phase = "startup";

type Scope = {
  candidate: ReleaseManifest;
  infrastructure: InfrastructureManifest;
  clusterArn: string;
  databaseServiceArn: string;
  serviceArn: string;
  targetGroupArn: string;
  albDnsName: string;
  containerPort: number;
};
type Fence = { leaseId: string; actorId: string; ownership: { leaseId: string; fencingToken: string }; operationLeaseId: string; workerId: string; token: string };
type Binding = { host: string; port: string; database: string; user: string; passwordSecretArn: string; jwtSecretArn: string };

function id(value: string) {
  const chars = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  chars[12] = "4"; chars[16] = ((parseInt(chars[16], 16) & 3) | 8).toString(16);
  return `${chars.slice(0, 8).join("")}-${chars.slice(8, 12).join("")}-${chars.slice(12, 16).join("")}-${chars.slice(16, 20).join("")}-${chars.slice(20).join("")}`;
}
function rows<T>(value: unknown): T[] { return Array.isArray(value) && Array.isArray(value[0]) ? value[0] as T[] : Array.isArray(value) ? value as T[] : []; }
function safe(state: string, codes: string[], detail: Record<string, unknown> = {}) { process.stdout.write(`${JSON.stringify({ state, safeCodes: [...new Set(codes)], ...detail })}\n`); }
function assertEnabled() {
  if (process.env.SMART_RETAIL_DATABASE_BINDING_CORRECTION_ENABLED !== "true"
    || process.env.TWO_LANE_CANARY_PROJECT_ID !== PROJECT_ID
    || process.env.TWO_LANE_CANARY_ENVIRONMENT !== "dev"
    || process.env.TWO_LANE_FIRST_RELEASE_DATABASE_BINDING_CORRECTION !== "db_runtime_v1") {
    throw new Error("SMART_RETAIL_DATABASE_BINDING_CORRECTION_CONFIGURATION_INVALID");
  }
}
function text(value: unknown, pattern: RegExp, code: string) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(code);
  return value;
}
function envMap(container: any) {
  const values = new Map<string, string>();
  for (const item of container?.environment || []) {
    if (!item || typeof item.name !== "string" || typeof item.value !== "string" || values.has(item.name)) throw new Error("SMART_RETAIL_DATABASE_BINDING_ENVIRONMENT_INVALID");
    values.set(item.name, item.value);
  }
  return values;
}
function secretMap(container: any) {
  const values = new Map<string, string>();
  for (const item of container?.secrets || []) {
    if (!item || typeof item.name !== "string" || typeof item.valueFrom !== "string" || values.has(item.name)) throw new Error("SMART_RETAIL_DATABASE_BINDING_SECRET_INVALID");
    values.set(item.name, item.valueFrom);
  }
  return values;
}
function normalized(definition: any) {
  const copy = JSON.parse(JSON.stringify(definition));
  for (const key of ["taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities", "registeredAt", "registeredBy", "deregisteredAt"]) delete copy[key];
  for (const container of copy.containerDefinitions || []) { delete container.environment; delete container.secrets; }
  return copy;
}
function exactNames(map: Map<string, string>, names: string[], code: string) {
  if (map.size !== names.length || names.some((name) => !map.has(name))) throw new Error(code);
}

async function loadScope(dataSource: DataSource): Promise<Scope> {
  const candidate = await dataSource.getRepository(ReleaseManifest).findOneByOrFail({ id: CANDIDATE_ID });
  const infrastructure = await dataSource.getRepository(InfrastructureManifest).findOneByOrFail({ id: INFRASTRUCTURE_ID });
  const outputs = infrastructure.terraformOutputs || {};
  const clusterArn = outputs.ecs_cluster_arn;
  const databaseServiceArn = outputs.database_service_arn;
  const targetGroupArn = outputs.alb_target_group_arn;
  const albDnsName = outputs.alb_dns_name;
  if (candidate.projectId !== PROJECT_ID || candidate.environmentName !== "dev" || candidate.revision !== "1"
    || !((candidate.status === "failed" && candidate.failureCode === SAFE_BLOCKER) || candidate.status === "deploying") || candidate.imageDigest !== IMAGE_DIGEST
    || candidate.taskDefinitionArn !== SOURCE_TASK || !candidate.initialServiceArn || infrastructure.status !== "applied"
    || !infrastructure.terraformOutputsHash || typeof clusterArn !== "string" || typeof databaseServiceArn !== "string"
    || typeof targetGroupArn !== "string" || typeof albDnsName !== "string" || typeof candidate.releaseSpec?.runtime?.containerPort !== "number") {
    throw new Error("SMART_RETAIL_DATABASE_BINDING_SCOPE_INVALID");
  }
  return { candidate, infrastructure, clusterArn, databaseServiceArn, serviceArn: candidate.initialServiceArn, targetGroupArn, albDnsName, containerPort: candidate.releaseSpec.runtime.containerPort };
}

async function acquire(dataSource: DataSource, ownership: InactiveReleaseLaneOwnershipService): Promise<Fence> {
  const leaseId = id(`smart-retail-db-binding-owner:${CANDIDATE_ID}:${IMAGE_DIGEST}`);
  const actorId = `smart-retail-db-binding:${CANDIDATE_ID}`;
  const acquired = await ownership.acquire({ projectId: PROJECT_ID, environmentName: "dev", lane: "v1", leaseId, actorId,
    idempotencyKey: canonicalSha256({ operation: "smart_retail_database_binding_correction", candidateId: CANDIDATE_ID, sourceTask: SOURCE_TASK, correctedTask: CORRECTED_TASK }),
    requestFingerprint: canonicalSha256({ sourceTask: SOURCE_TASK, binding: "DB_HOST_DB_PORT_DB_NAME_DB_USER_DB_PASSWORD" }), leaseTtlMs: 5 * 60_000, ownV1IntentId: INTENT_ID });
  if (acquired.disposition !== "acquired" && acquired.disposition !== "already_owned") throw new Error("SMART_RETAIL_DATABASE_BINDING_OWNERSHIP_BLOCKED");
  const created = await dataSource.transaction("SERIALIZABLE", async (manager) => {
    const intent = rows<{ id: string }>(await manager.query(`SELECT id FROM deployment_intents WHERE id=$1 AND project_id=$2 AND environment_name='dev' AND kind='deploy' AND classification='release_only' AND ((status='failed' AND failure_code=$3) OR (status='running' AND EXISTS (SELECT 1 FROM deployment_side_effects effect WHERE effect.intent_id=deployment_intents.id AND effect.effect_type='ecs.register_task_definition_database_binding_correction' AND effect.status='started'))) FOR UPDATE`, [INTENT_ID, PROJECT_ID, SAFE_BLOCKER]));
    if (intent.length !== 1) throw new Error("SMART_RETAIL_DATABASE_BINDING_INTENT_INVALID");
    const [fence] = rows<{ token: string }>(await manager.query(`SELECT (COALESCE(MAX(fencing_token),0)+1)::text AS token FROM project_operation_leases WHERE project_id=$1 AND environment_name='dev'`, [PROJECT_ID]));
    if (!fence?.token) throw new Error("SMART_RETAIL_DATABASE_BINDING_FENCE_INVALID");
    const operationLeaseId = id(`smart-retail-db-binding-lease:${CANDIDATE_ID}:${fence.token}`);
    const workerId = `smart-retail-db-binding:${CANDIDATE_ID}`;
    await manager.query(`INSERT INTO project_operation_leases (id,project_id,environment_name,lane,scope,intent_id,owner_worker_id,fencing_token,status,acquired_at,heartbeat_at,expires_at,metadata,created_at,updated_at)
      VALUES ($1,$2,'dev','release','execute',$3,$4,$5::bigint,'acquired',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '30 minutes',$6::jsonb,clock_timestamp(),clock_timestamp())`,
    [operationLeaseId, PROJECT_ID, INTENT_ID, workerId, fence.token, JSON.stringify({ operation: "database_binding_correction", candidateId: CANDIDATE_ID, sourceTask: SOURCE_TASK, correctedTask: CORRECTED_TASK })]);
    await manager.query(`UPDATE deployment_intents SET status='running',failure_code=NULL,failure_message=NULL,completed_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='failed' AND failure_code=$2`, [INTENT_ID, SAFE_BLOCKER]);
    await manager.query(`UPDATE release_manifests SET status='deploying',failure_code=NULL,failure_message=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='failed' AND failure_code=$2`, [CANDIDATE_ID, SAFE_BLOCKER]);
    return { operationLeaseId, workerId, token: fence.token };
  });
  return { leaseId, actorId, ownership: acquired.ownership, ...created };
}

async function ensureEffect(dataSource: DataSource, fence: Fence, operationId: string, effect: string, fingerprint: string) {
  const existing = rows<{ status: string; requestFingerprint: string }>(await dataSource.query(`SELECT status AS "status",request_fingerprint AS "requestFingerprint" FROM deployment_side_effects WHERE intent_id=$1 AND operation_id=$2`, [INTENT_ID, operationId]));
  if (existing.length === 1) {
    if (existing[0].requestFingerprint !== fingerprint || !["started", "succeeded"].includes(existing[0].status)) throw new Error("SMART_RETAIL_DATABASE_BINDING_JOURNAL_CONFLICT");
    return existing[0].status;
  }
  await dataSource.query(`INSERT INTO deployment_side_effects (id,intent_id,project_id,environment_name,operation_id,effect_type,idempotency_key,request_fingerprint,lease_id,owner_worker_id,fencing_token,status,reconciliation_required,attempt_started_at,deadline_at,created_at,updated_at)
    VALUES ($1,$2,$3,'dev',$1,$4,$5,$6,$7,$8,$9::bigint,'started',false,clock_timestamp(),clock_timestamp()+interval '30 minutes',clock_timestamp(),clock_timestamp())`,
  [operationId, INTENT_ID, PROJECT_ID, effect, canonicalSha256({ effect, candidateId: CANDIDATE_ID, fingerprint }), fingerprint, fence.operationLeaseId, fence.workerId, fence.token]);
  return "started";
}
async function completeEffect(dataSource: DataSource, operationId: string, code: string, result: string) {
  const raw = await dataSource.query(`UPDATE deployment_side_effects SET status='succeeded',safe_result_code=$2::varchar,result_fingerprint=$3::char(64),failure_code=NULL,reconciliation_required=false,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND status='started' RETURNING id`, [operationId, code, result]);
  const count = Array.isArray(raw) && Array.isArray(raw[0]) ? Number(raw[1]) : Array.isArray(raw) ? raw.length : 0;
  if (count !== 1) {
    const found = rows<{ status: string }>(await dataSource.query(`SELECT status FROM deployment_side_effects WHERE id=$1`, [operationId]));
    if (found[0]?.status !== "succeeded") throw new Error("SMART_RETAIL_DATABASE_BINDING_JOURNAL_CONFLICT");
  }
}

function registration(source: any, binding: Binding) {
  const definition = source.taskDefinition; const app = definition?.containerDefinitions?.find((item: any) => item.name === "app");
  if (!definition || !app || definition.taskDefinitionArn !== SOURCE_TASK || app.image?.split("@")[1] !== IMAGE_DIGEST || JSON.stringify(app.command) !== JSON.stringify(["sh", "-c", "npm run start"])) throw new Error("SMART_RETAIL_DATABASE_BINDING_SOURCE_INVALID");
  const environment = envMap(app); const secrets = secretMap(app);
  exactNames(environment, ["DATABASE_HOST", "DATABASE_PORT", "PORT"], "SMART_RETAIL_DATABASE_BINDING_SOURCE_ENVIRONMENT_INVALID");
  exactNames(secrets, ["DATABASE_URL", "DATABASE_PASSWORD", "JWT_SECRET"], "SMART_RETAIL_DATABASE_BINDING_SOURCE_SECRETS_INVALID");
  if (environment.get("DATABASE_HOST") !== binding.host || environment.get("DATABASE_PORT") !== binding.port || secrets.get("DATABASE_PASSWORD") !== binding.passwordSecretArn || secrets.get("JWT_SECRET") !== binding.jwtSecretArn) throw new Error("SMART_RETAIL_DATABASE_BINDING_SOURCE_IDENTITY_INVALID");
  const correctedEnvironment = [{ name: "DB_HOST", value: binding.host }, { name: "DB_NAME", value: binding.database }, { name: "DB_PORT", value: binding.port }, { name: "DB_USER", value: binding.user }, { name: "PORT", value: environment.get("PORT")! }];
  const correctedSecrets = [{ name: "DB_PASSWORD", valueFrom: binding.passwordSecretArn }, { name: "JWT_SECRET", valueFrom: binding.jwtSecretArn }];
  return {
    input: { family: definition.family, taskRoleArn: definition.taskRoleArn, executionRoleArn: definition.executionRoleArn, networkMode: definition.networkMode,
      containerDefinitions: definition.containerDefinitions.map((item: any) => item.name === "app" ? { ...item, environment: correctedEnvironment, secrets: correctedSecrets } : { ...item }), volumes: definition.volumes, placementConstraints: definition.placementConstraints, requiresCompatibilities: definition.requiresCompatibilities, cpu: definition.cpu, memory: definition.memory, pidMode: definition.pidMode, ipcMode: definition.ipcMode, proxyConfiguration: definition.proxyConfiguration, inferenceAccelerators: definition.inferenceAccelerators, ephemeralStorage: definition.ephemeralStorage, runtimePlatform: definition.runtimePlatform, enableFaultInjection: definition.enableFaultInjection, tags: source.tags },
    sourceComparable: normalized(definition), correctedEnvironment, correctedSecrets,
  };
}
function assertCorrected(sourceComparable: any, detail: any, expected: ReturnType<typeof registration>) {
  const app = detail?.taskDefinition?.containerDefinitions?.find((item: any) => item.name === "app");
  const expectedEnvironment = new Map(expected.correctedEnvironment.map((item) => [item.name, item.value]));
  const expectedSecrets = new Map(expected.correctedSecrets.map((item) => [item.name, item.valueFrom]));
  const sameMap = (actual: Map<string, string>, target: Map<string, string>) => actual.size === target.size && [...target].every(([key, value]) => actual.get(key) === value);
  if (!app || JSON.stringify(normalized(detail.taskDefinition)) !== JSON.stringify(sourceComparable) || !sameMap(envMap(app), expectedEnvironment) || !sameMap(secretMap(app), expectedSecrets) || JSON.stringify(app.command) !== JSON.stringify(["sh", "-c", "npm run start"])) throw new Error("SMART_RETAIL_DATABASE_BINDING_TASK_DEFINITION_INVALID");
}

async function main() {
  assertEnabled();
  const dataSource = new DataSource({ ...(AppDataSource.options as DataSourceOptions), entities: [InfrastructureManifest, ReleaseManifest, ProjectReleaseLaneOwnership], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
  await dataSource.initialize();
  const ecs = new ECSClient({ region: new ConfigService(process.env).get<string>("AWS_REGION", "") }); const elbv2 = new ElasticLoadBalancingV2Client({ region: new ConfigService(process.env).get<string>("AWS_REGION", "") });
  const ownership = new InactiveReleaseLaneOwnershipService(dataSource); let fence: Fence | null = null; let trusted = true; let heartbeat: NodeJS.Timeout | null = null;
  try {
    phase = "scope"; const scope = await loadScope(dataSource); const outputs = scope.infrastructure.terraformOutputs || {};
    const host = text(outputs.database_internal_host, /^db\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/, "SMART_RETAIL_DATABASE_BINDING_HOST_INVALID");
    const port = outputs.database_port === 5432 ? "5432" : (() => { throw new Error("SMART_RETAIL_DATABASE_BINDING_PORT_INVALID"); })();
    const passwordSecretArn = text(outputs.database_password_secret_arn, /^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[^\s]+$/, "SMART_RETAIL_DATABASE_BINDING_PASSWORD_REFERENCE_INVALID");
    const jwtSecretArn = text(outputs.application_jwt_secret_arn, /^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[^\s]+$/, "SMART_RETAIL_DATABASE_BINDING_JWT_REFERENCE_INVALID");
    const databaseServiceSegments = scope.databaseServiceArn.split(":")[5]?.split("/") || [];
    const databaseCluster = databaseServiceSegments.length === 3 && databaseServiceSegments[0] === "service"
      ? databaseServiceSegments[1] : "";
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(databaseCluster)) throw new Error("SMART_RETAIL_DATABASE_SERVICE_IDENTITY_INVALID");
    phase = "database_service_identity"; const dbService = await ecs.send(new DescribeServicesCommand({ cluster: databaseCluster, services: [scope.databaseServiceArn] }));
    const dbTaskArn = dbService.services?.[0]?.taskDefinition; if (!dbTaskArn || dbService.services?.[0]?.runningCount !== 1) throw new Error("SMART_RETAIL_DATABASE_SERVICE_IDENTITY_INVALID");
    const dbTask = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: dbTaskArn }));
    const dbEnvironment = new Map<string, string>(); for (const container of dbTask.taskDefinition?.containerDefinitions || []) for (const item of container.environment || []) if (item.name && item.value && !dbEnvironment.has(item.name)) dbEnvironment.set(item.name, item.value);
    const database = dbEnvironment.get("POSTGRES_DB") || dbEnvironment.get("DB_NAME"); const user = dbEnvironment.get("POSTGRES_USER") || dbEnvironment.get("DB_USER");
    const binding: Binding = { host, port, database: text(database, /^[A-Za-z][A-Za-z0-9_]{0,62}$/, "SMART_RETAIL_DATABASE_BINDING_NAME_INVALID"), user: text(user, /^[A-Za-z][A-Za-z0-9_]{0,62}$/, "SMART_RETAIL_DATABASE_BINDING_USER_INVALID"), passwordSecretArn, jwtSecretArn };
    phase = "source_task_identity"; const source = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: SOURCE_TASK, include: ["TAGS"] })); const expected = registration(source, binding); const taskHash = canonicalSha256({ sourceTask: SOURCE_TASK, correctedTask: CORRECTED_TASK, sourceComparable: expected.sourceComparable, environment: expected.correctedEnvironment, secrets: expected.correctedSecrets, infrastructureHash: scope.infrastructure.terraformOutputsHash, imageDigest: IMAGE_DIGEST });
    const serviceBefore = await ecs.send(new DescribeServicesCommand({ cluster: scope.clusterArn, services: [scope.serviceArn] })); if (serviceBefore.services?.[0]?.taskDefinition !== SOURCE_TASK || serviceBefore.services?.[0]?.status !== "ACTIVE") throw new Error("SMART_RETAIL_DATABASE_BINDING_SERVICE_INVALID");
    phase = "fenced_recovery"; fence = await acquire(dataSource, ownership);
    heartbeat = setInterval(() => { if (!fence || !trusted) return; void ownership.renew({ projectId: PROJECT_ID, environmentName: "dev", lane: "v1", leaseId: fence.ownership.leaseId, actorId: fence.actorId, fencingToken: fence.ownership.fencingToken, leaseTtlMs: 5 * 60_000 }).then((result) => { trusted = result.disposition === "acquired" || result.disposition === "already_owned"; }).catch(() => { trusted = false; }); }, 60_000); heartbeat.unref();
    phase = "task_definition_registration"; const registerId = id(`smart-retail-db-binding-register:${CANDIDATE_ID}:${taskHash}`); let detail = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: CORRECTED_TASK, include: ["TAGS"] })).catch(() => null); let taskArn = detail?.taskDefinition?.taskDefinitionArn;
    if (!taskArn) { await ensureEffect(dataSource, fence, registerId, "ecs.register_task_definition_database_binding_correction", taskHash); const created = await ecs.send(new RegisterTaskDefinitionCommand(expected.input)); taskArn = created.taskDefinition?.taskDefinitionArn; detail = taskArn ? await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskArn, include: ["TAGS"] })) : null; }
    if (!taskArn || taskArn !== CORRECTED_TASK || !detail) throw new Error("SMART_RETAIL_DATABASE_BINDING_REGISTRATION_INVALID"); assertCorrected(expected.sourceComparable, detail, expected); await completeEffect(dataSource, registerId, "ECS_DATABASE_BINDINGS_CORRECTED", canonicalSha256({ taskArn, taskHash }));
    phase = "service_update"; const updateHash = canonicalSha256({ serviceArn: scope.serviceArn, taskArn }); const updateId = id(`smart-retail-db-binding-update:${CANDIDATE_ID}:${updateHash}`); const service = await ecs.send(new DescribeServicesCommand({ cluster: scope.clusterArn, services: [scope.serviceArn] }));
    if (service.services?.[0]?.taskDefinition !== taskArn) { await ensureEffect(dataSource, fence, updateId, "ecs.update_existing_service_database_binding_correction", updateHash); const updated = await ecs.send(new UpdateServiceCommand({ cluster: scope.clusterArn, service: scope.serviceArn, taskDefinition: taskArn })); if (updated.service?.serviceArn !== scope.serviceArn || updated.service.taskDefinition !== taskArn) throw new Error("SMART_RETAIL_DATABASE_BINDING_SERVICE_UPDATE_INVALID"); }
    await completeEffect(dataSource, updateId, "ECS_SERVICE_DATABASE_BINDINGS_UPDATED", canonicalSha256({ serviceArn: scope.serviceArn, taskArn, updateHash }));
    phase = "rollout_health"; const url = `http://${scope.albDnsName}`; const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) { if (!trusted) throw new Error("SMART_RETAIL_DATABASE_BINDING_OWNERSHIP_LOST"); const [serviceNow, targets, root] = await Promise.all([ecs.send(new DescribeServicesCommand({ cluster: scope.clusterArn, services: [scope.serviceArn] })), elbv2.send(new DescribeTargetHealthCommand({ TargetGroupArn: scope.targetGroupArn })), fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null)]); const current = serviceNow.services?.[0]; const primary = current?.deployments?.find((item) => item.status === "PRIMARY"); const healthy = targets.TargetHealthDescriptions?.some((target) => target.TargetHealth?.State === "healthy") === true; if (current?.taskDefinition === taskArn && primary?.rolloutState === "COMPLETED" && current.desiredCount === 1 && current.runningCount === 1 && (current.pendingCount ?? 0) === 0 && healthy && root?.status === 200) break; await new Promise((resolve) => setTimeout(resolve, 10_000)); }
    const health = await ecs.send(new DescribeServicesCommand({ cluster: scope.clusterArn, services: [scope.serviceArn] })); const primary = health.services?.[0]?.deployments?.find((item) => item.status === "PRIMARY"); const targets = await elbv2.send(new DescribeTargetHealthCommand({ TargetGroupArn: scope.targetGroupArn })); if (health.services?.[0]?.taskDefinition !== taskArn || primary?.rolloutState !== "COMPLETED" || health.services?.[0]?.desiredCount !== 1 || health.services?.[0]?.runningCount !== 1 || (health.services?.[0]?.pendingCount ?? 0) !== 0 || !targets.TargetHealthDescriptions?.some((target) => target.TargetHealth?.State === "healthy") || (await fetch(url, { signal: AbortSignal.timeout(10_000) })).status !== 200) throw new Error("SMART_RETAIL_DATABASE_BINDING_HEALTH_BLOCKED");
    phase = "database_persistence"; const databaseEffect = id(`smart-retail-db-binding-database-evidence:${CANDIDATE_ID}:${taskHash}`); const effectStatus = await ensureEffect(dataSource, fence, databaseEffect, "application.database_create_read_persistence", canonicalSha256({ candidateId: CANDIDATE_ID, taskArn, operation: "register_login_restart" })); const email = `verification-${taskHash.slice(0, 20)}@example.invalid`; const password = `Dg-${taskHash.slice(0, 24)}!`;
    let login = await fetch(`${url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(10_000) });
    if (login.status === 401 && effectStatus === "started") { const registered = await fetch(`${url}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "DeployGuard Verification", email, password }), signal: AbortSignal.timeout(10_000) }); if (![201, 409].includes(registered.status)) throw new Error("SMART_RETAIL_DATABASE_CREATE_BLOCKED"); login = await fetch(`${url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(10_000) }); }
    if (login.status !== 200) throw new Error("SMART_RETAIL_DATABASE_READ_BLOCKED");
    const restartId = id(`smart-retail-db-binding-restart:${CANDIDATE_ID}:${taskHash}`); const restartStatus = await ensureEffect(dataSource, fence, restartId, "ecs.restart_task_database_persistence_check", canonicalSha256({ serviceArn: scope.serviceArn, taskArn }));
    if (restartStatus === "started") { const tasks = await ecs.send(new ListTasksCommand({ cluster: scope.clusterArn, serviceName: health.services?.[0]?.serviceName, desiredStatus: "RUNNING" })); if (tasks.taskArns?.length !== 1) throw new Error("SMART_RETAIL_DATABASE_RESTART_EVIDENCE_BLOCKED"); await ecs.send(new StopTaskCommand({ cluster: scope.clusterArn, task: tasks.taskArns[0], reason: "DeployGuard verified database persistence" })); }
    const restartDeadline = Date.now() + 10 * 60_000; while (Date.now() < restartDeadline) { const current = await ecs.send(new DescribeServicesCommand({ cluster: scope.clusterArn, services: [scope.serviceArn] })); const primaryNow = current.services?.[0]?.deployments?.find((item) => item.status === "PRIMARY"); if (current.services?.[0]?.taskDefinition === taskArn && primaryNow?.rolloutState === "COMPLETED" && current.services?.[0]?.runningCount === 1 && (current.services?.[0]?.pendingCount ?? 0) === 0) break; await new Promise((resolve) => setTimeout(resolve, 10_000)); }
    const persisted = await fetch(`${url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(10_000) }); if (persisted.status !== 200) throw new Error("SMART_RETAIL_DATABASE_PERSISTENCE_BLOCKED"); await completeEffect(dataSource, restartId, "ECS_TASK_RESTART_DATABASE_PERSISTENCE_VERIFIED", canonicalSha256({ taskArn, emailHash: canonicalSha256(email) })); await completeEffect(dataSource, databaseEffect, "APPLICATION_DATABASE_CREATE_READ_PERSISTENCE_VERIFIED", canonicalSha256({ taskArn, emailHash: canonicalSha256(email) }));
    phase = "promotion"; const evidenceHash = canonicalSha256({ taskArn, serviceArn: scope.serviceArn, url, databaseOperation: "create_read_restart_verified", bindingNames: ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"] });
    await dataSource.transaction("SERIALIZABLE", async (manager) => { await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`deployguard:smart-retail-db-binding-promote:${PROJECT_ID}:dev`]); const candidate = await manager.getRepository(ReleaseManifest).findOneByOrFail({ id: CANDIDATE_ID }); if (candidate.status !== "deploying") throw new Error("SMART_RETAIL_DATABASE_BINDING_PROMOTION_CONFLICT"); candidate.status = "stable"; candidate.taskDefinitionArn = taskArn; candidate.taskDefinitionInputHash = taskHash; candidate.healthVerifiedAt = new Date(); candidate.promotedAt = new Date(); candidate.failureCode = null; candidate.failureMessage = null; candidate.healthEvidence = { schemaVersion: 1, safeCode: SAFE_READY, evidenceHash, applicationUrl: url, databasePersistence: "verified" }; await manager.getRepository(ReleaseManifest).save(candidate); const finished = await manager.query(`UPDATE deployment_intents SET status='completed',completed_at=clock_timestamp(),failure_code=NULL,failure_message=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='running' RETURNING id`, [INTENT_ID]); if ((finished?.[1] ?? finished?.length) !== 1) throw new Error("SMART_RETAIL_DATABASE_BINDING_INTENT_COMPLETION_CONFLICT"); await new InactiveV1StableReleaseProjectionStore(dataSource).syncWithinTransaction(manager, CANDIDATE_ID); });
    safe("completed", ["SMART_RETAIL_FIRST_RELEASE_RECONCILED"], { taskDefinitionRevision: 3, serviceStatus: "stable", databasePersistence: "verified" });
  } finally { if (heartbeat) clearInterval(heartbeat); if (fence) { await dataSource.query(`UPDATE project_operation_leases SET status='released',released_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND owner_worker_id=$2 AND fencing_token=$3::bigint AND status IN ('acquired','heartbeat_active')`, [fence.operationLeaseId, fence.workerId, fence.token]).catch(() => undefined); await ownership.release({ projectId: PROJECT_ID, environmentName: "dev", lane: "v1", leaseId: fence.ownership.leaseId, actorId: fence.actorId, fencingToken: fence.ownership.fencingToken }).catch(() => undefined); } await dataSource.destroy().catch(() => undefined); }
}
void main().catch((error) => { const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "SMART_RETAIL_DATABASE_BINDING_RECONCILIATION_FAILED"; safe("blocked", [code], { phase }); process.exitCode = 2; });
