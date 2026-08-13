import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { DescribeRepositoriesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { DescribeServicesCommand, ECSClient } from "@aws-sdk/client-ecs";
import { AppModule } from "../src/app.module";
import { validateWorkerEnvelopeV1, workerEnvelopeJobId } from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import { FrozenProtocolQueue } from "../src/orchestration-contracts/outbox/frozen-bullmq-job.adapter";
import { NormalReleaseLaneExecutionService } from "../src/orchestration-contracts/release-lane/normal-release-lane-execution.service";
import { InactiveV1ReleaseLaneCompositionService } from "../src/orchestration-contracts/release-lane/inactive-v1-release-lane-composition";
import { createRedisConnection } from "../src/projects/pipeline/redis.config";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40}$/i;

type Readiness = {
  intentId: string;
  projectId: string;
  actorId: number;
  commitSha: string;
  candidateId: string;
  infrastructureId: string;
  stableServiceArn: string;
  stableTaskDefinitionArn: string;
  candidateTaskDefinitionArn: string | null;
  clusterArn: string;
  ecrRepositoryName: string;
  region: string;
  mode: "planned" | "outcome_reconciliation";
  publishedJobId: string | null;
};

function result(state: string, safeCodes: readonly string[]) {
  process.stdout.write(`${JSON.stringify({ state, safeCodes: [...new Set(safeCodes)].sort() })}\n`);
}

function rows<T>(value: unknown): T[] {
  return Array.isArray(value) && Array.isArray(value[0])
    ? value[0] as T[]
    : Array.isArray(value) ? value as T[] : [];
}

async function loadReadiness(dataSource: DataSource): Promise<Readiness | null> {
  const projectId = process.env.TWO_LANE_RELEASE_PROJECT_ALLOWLIST;
  const commit = process.env.TWO_LANE_NORMAL_RELEASE_EXECUTION_COMMIT_SHA;
  if (!UUID.test(projectId ?? "") || !COMMIT.test(commit ?? "")) return null;
  const outcomeReconciliation =
    process.env.TWO_LANE_NORMAL_RELEASE_OUTCOME_RECONCILE_APPROVED === "true";
  const values = rows<Readiness>(await dataSource.query(
    `SELECT intent.id AS "intentId", intent.project_id AS "projectId",
            project.owner_user_id AS "actorId", candidate.commit_sha AS "commitSha",
            candidate.id AS "candidateId", infrastructure.id AS "infrastructureId",
            stable.initial_service_arn AS "stableServiceArn",
            stable.task_definition_arn AS "stableTaskDefinitionArn",
            candidate.task_definition_arn AS "candidateTaskDefinitionArn",
            infrastructure.terraform_outputs->>'ecs_cluster_arn' AS "clusterArn",
            infrastructure.terraform_outputs->>'ecr_repository_name' AS "ecrRepositoryName",
            infrastructure.desired_spec->>'region' AS region,
            CASE WHEN intent.status = 'planned'
              THEN 'planned' ELSE 'outcome_reconciliation'
            END AS mode,
            outbox.published_job_id AS "publishedJobId"
     FROM deployment_intents intent
     JOIN projects project ON project.id = intent.project_id
     JOIN release_manifests candidate ON candidate.id = intent.release_manifest_id
     JOIN infrastructure_manifests infrastructure ON infrastructure.id = intent.infrastructure_manifest_id
     JOIN release_manifests stable ON stable.id = candidate.previous_stable_manifest_id
     JOIN orchestration_outbox outbox ON outbox.intent_id = intent.id
     WHERE intent.project_id = $1 AND intent.environment_name = 'dev'
       AND intent.kind = 'deploy' AND intent.classification = 'release_only'
       AND candidate.commit_sha = $2 AND infrastructure.status = 'applied'
       AND stable.status = 'stable'
       AND (
         (
           $3::boolean = false
           AND intent.status = 'planned' AND candidate.status = 'desired'
           AND outbox.status = 'pending' AND outbox.attempt_count = 0
           AND outbox.published_at IS NULL AND outbox.published_job_id IS NULL
           AND outbox.claimed_by IS NULL AND outbox.claim_expires_at IS NULL
         )
         OR (
           $3::boolean = true
           AND intent.status IN ('failed','enqueued')
           AND (
             intent.status = 'enqueued'
             OR intent.failure_code = 'RELEASE_EVIDENCE_AMBIGUOUS'
           )
           AND candidate.status = 'deploying'
           AND candidate.image_digest IS NOT NULL
           AND candidate.task_definition_arn IS NOT NULL
           AND outbox.status = 'published' AND outbox.attempt_count = 1
           AND outbox.published_at IS NOT NULL
           AND outbox.published_job_id IS NOT NULL
           AND outbox.claimed_by IS NULL AND outbox.claim_expires_at IS NULL
           AND EXISTS (
             SELECT 1 FROM release_image_provenances provenance
             WHERE provenance.intent_id = intent.id
               AND provenance.project_id = intent.project_id
               AND provenance.environment_name = intent.environment_name
               AND provenance.infrastructure_manifest_id = infrastructure.id
               AND provenance.commit_sha = candidate.commit_sha
               AND provenance.build_fingerprint = candidate.build_fingerprint
           )
           AND 3 = (
             SELECT count(*) FROM deployment_side_effects effect
             WHERE effect.intent_id = intent.id AND effect.status = 'succeeded'
               AND effect.effect_type IN (
                 'ecr.build_push_immutable_image',
                 'ecs.register_task_definition_revision',
                 'ecs.update_existing_service'
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM deployment_side_effects effect
             WHERE effect.intent_id = intent.id
               AND (
                 effect.status <> 'succeeded'
                 OR effect.effect_type NOT IN (
                   'ecr.build_push_immutable_image',
                   'ecs.register_task_definition_revision',
                   'ecs.update_existing_service'
                 )
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM project_operation_leases lease
             WHERE lease.intent_id = intent.id
               AND lease.status IN ('acquired','heartbeat_active')
               AND lease.expires_at > clock_timestamp()
           )
         )
       )
     ORDER BY intent.received_at DESC
     LIMIT 2`,
    [projectId, commit.toLowerCase(), outcomeReconciliation],
  ));
  return values.length === 1 ? values[0] : null;
}

async function prepareOutcomeReconciliation(
  dataSource: DataSource,
  readiness: Readiness,
) {
  if (
    readiness.mode !== "outcome_reconciliation"
    || !readiness.publishedJobId
  ) return false;
  return dataSource.transaction("SERIALIZABLE", async (manager) => {
    await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `deployguard:normal-release-outcome-reconciliation:${readiness.projectId}:dev`,
    ]);
    const values = rows<{ status: string; failureCode: string | null }>(
      await manager.query(
        `SELECT status, failure_code AS "failureCode"
         FROM deployment_intents
         WHERE id = $1 AND project_id = $2 AND environment_name = 'dev'
         FOR UPDATE`,
        [readiness.intentId, readiness.projectId],
      ),
    );
    const intent = values[0];
    if (!intent) return false;
    if (intent.status === "enqueued") return true;
    if (
      intent.status !== "failed"
      || intent.failureCode !== "RELEASE_EVIDENCE_AMBIGUOUS"
    ) return false;
    const updated = rows(await manager.query(
      `UPDATE deployment_intents
       SET status = 'enqueued', completed_at = NULL, failure_code = NULL,
           failure_message = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'failed'
         AND failure_code = 'RELEASE_EVIDENCE_AMBIGUOUS'
         AND NOT EXISTS (
           SELECT 1 FROM project_operation_leases lease
           WHERE lease.intent_id = deployment_intents.id
             AND lease.status IN ('acquired','heartbeat_active')
             AND lease.expires_at > clock_timestamp()
         )
       RETURNING id`,
      [readiness.intentId],
    ));
    if (updated.length !== 1) return false;
    await manager.query(
      `INSERT INTO audit_logs (
         actor_user_id, action, category, resource_type, resource_id,
         status, metadata
       )
       SELECT $1, 'normal_release.resume_for_outcome_reconciliation',
              'release', 'deployment_intent', $2::text, 'resumed',
              jsonb_build_object(
                'projectId', $3::uuid,
                'environment', 'dev',
                'reason', 'verified_succeeded_mutations_pending_outcome_reconciliation'
              )
       WHERE NOT EXISTS (
         SELECT 1 FROM audit_logs
         WHERE action = 'normal_release.resume_for_outcome_reconciliation'
           AND resource_type = 'deployment_intent'
           AND resource_id = $2::text
       )`,
      [readiness.actorId, readiness.intentId, readiness.projectId],
    );
    return true;
  });
}

async function preflight(readiness: Readiness) {
  if (!Number.isInteger(readiness.actorId)
    || !UUID.test(readiness.intentId)
    || !UUID.test(readiness.projectId)
    || !UUID.test(readiness.candidateId)
    || !UUID.test(readiness.infrastructureId)
    || !COMMIT.test(readiness.commitSha)
    || !readiness.stableServiceArn
    || !readiness.stableTaskDefinitionArn
    || (
      readiness.mode === "outcome_reconciliation"
      && !readiness.candidateTaskDefinitionArn
    )
    || !readiness.clusterArn
    || !readiness.ecrRepositoryName
    || !readiness.region) return false;
  try {
    const ecr = new ECRClient({ region: readiness.region });
    const ecs = new ECSClient({ region: readiness.region });
    const [repository, service] = await Promise.all([
      ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [readiness.ecrRepositoryName] })),
      ecs.send(new DescribeServicesCommand({ cluster: readiness.clusterArn, services: [readiness.stableServiceArn] })),
    ]);
    const exactService = service.services?.length === 1 ? service.services[0] : null;
    return repository.repositories?.length === 1
      && exactService?.status === "ACTIVE"
      && exactService.clusterArn === readiness.clusterArn
      && exactService.serviceArn === readiness.stableServiceArn
      && exactService.taskDefinition === (
        readiness.mode === "outcome_reconciliation"
          ? readiness.candidateTaskDefinitionArn
          : readiness.stableTaskDefinitionArn
      );
  } catch {
    return false;
  }
}

async function waitForTerminal(dataSource: DataSource, intentId: string) {
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    const values = rows<{ status: string }>(await dataSource.query(
      `SELECT status FROM deployment_intents WHERE id = $1`, [intentId],
    ));
    const status = values[0]?.status;
    if (["completed", "failed", "cancelled", "no_op", "rejected"].includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return null;
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  let session: { stop(): Promise<void> } | null = null;
  try {
    const dataSource = app.get(DataSource);
    const readiness = await loadReadiness(dataSource);
    if (!readiness) return result("blocked", ["NORMAL_RELEASE_EXECUTION_EVIDENCE_INVALID"]);
    if (!(await preflight(readiness))) return result("blocked", ["NORMAL_RELEASE_PRODUCTION_IDENTITY_PREFLIGHT_FAILED"]);
    if (process.env.TWO_LANE_NORMAL_RELEASE_EXECUTE_APPROVED !== "true") {
      return result("ready", ["NORMAL_RELEASE_PRODUCTION_IDENTITY_PREFLIGHT_READY"]);
    }
    const composition = app.get(InactiveV1ReleaseLaneCompositionService).getInactiveComposition();
    if (!composition?.laterReleaseImageClient || !composition.allows(readiness.projectId, "dev")) {
      return result("blocked", ["NORMAL_RELEASE_COMPOSITION_NOT_READY"]);
    }
    const config = app.get(ConfigService);
    session = await composition.consumer.start({
      capability: {
        workerId: composition.configuration.workerId,
        role: "release",
        supportedMessageTypes: ["intent.release.execute"],
        serviceVersion: "normal-release-canary",
        gitSha: "local",
        heartbeatTtlMs: 60_000,
        metadata: {},
      },
      connection: createRedisConnection(config),
      prefix: config.get<string>("OUTBOX_BULLMQ_PREFIX", "bull"),
      concurrency: 1,
      leaseTtlMs: 60_000,
      leaseHeartbeatIntervalMs: 15_000,
      retryDelayMs: 1_000,
      heartbeatIntervalMs: 15_000,
    });
    if (readiness.mode === "planned") {
      const dispatched = await app.get(NormalReleaseLaneExecutionService).dispatch(
        { id: readiness.actorId, role: "developer" } as any,
        readiness.projectId,
      );
      if (dispatched.state !== "dispatched") {
        return result("blocked", dispatched.safeCodes);
      }
    } else {
      const queue = new FrozenProtocolQueue("deployguard-release-v1", {
        connection: createRedisConnection(config),
        prefix: config.get<string>("OUTBOX_BULLMQ_PREFIX", "bull"),
      });
      try {
        const job = await queue.getJob(readiness.publishedJobId!);
        const envelope = job ? validateWorkerEnvelopeV1(job.data) : null;
        if (
          !job
          || !envelope
          || workerEnvelopeJobId(envelope) !== readiness.publishedJobId
          || envelope.identity.intentId !== readiness.intentId
          || envelope.identity.projectId !== readiness.projectId
          || envelope.identity.releaseManifestId !== readiness.candidateId
          || await job.getState() !== "failed"
          || job.failedReason !== "RELEASE_EVIDENCE_AMBIGUOUS"
        ) {
          return result("blocked", ["NORMAL_RELEASE_OUTCOME_JOB_EVIDENCE_INVALID"]);
        }
        if (!(await prepareOutcomeReconciliation(dataSource, readiness))) {
          return result("blocked", ["NORMAL_RELEASE_OUTCOME_RECONCILIATION_NOT_ELIGIBLE"]);
        }
        await job.retry("failed");
      } finally {
        await queue.close();
      }
    }
    const terminal = await waitForTerminal(dataSource, readiness.intentId);
    if (terminal === "completed") return result("completed", ["NORMAL_RELEASE_EXECUTION_COMPLETED"]);
    if (terminal) return result("terminal", ["NORMAL_RELEASE_EXECUTION_TERMINAL_NOT_COMPLETED"]);
    return result("uncertain", ["NORMAL_RELEASE_EXECUTION_TIMEOUT_REQUIRES_RECONCILIATION"]);
  } finally {
    await session?.stop().catch(() => undefined);
    await app.close();
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)
    ? error.message
    : "NORMAL_RELEASE_EXECUTION_FAILED";
  result("blocked", [code]);
  process.exitCode = 2;
});
