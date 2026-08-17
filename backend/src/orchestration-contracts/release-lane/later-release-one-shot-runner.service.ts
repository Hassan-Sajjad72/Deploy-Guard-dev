import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DescribeServicesCommand, ECSClient } from "@aws-sdk/client-ecs";
import { DataSource } from "typeorm";
import { canonicalSha256 } from "../contracts/canonical-json";
import { workerEnvelopePayloadForHash } from "../contracts/worker-envelope.validator";
import { CrossLaneOwnershipEnforcementService } from "./cross-lane-ownership-enforcement.service";
import { InactiveV1ReleaseLaneCompositionService } from "./inactive-v1-release-lane-composition";
import { V1FencedPlaceholderHandlerContext } from "../worker-runtime/v1-fenced-invocation.types";
import { V1FirstReleaseBootstrapClient, V1FirstReleaseImageEvidence } from "../worker-runtime/inactive-v1-first-release-bootstrap.types";
import { V1WorkerCapabilityService } from "../worker-runtime/v1-worker-capability.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

type ReadinessRow = {
  intentId: string;
  status: string;
  canonicalKey: string;
  requestFingerprint: string;
  projectId: string;
  environmentName: string;
  infrastructureManifestId: string;
  infrastructureRevision: string;
  releaseManifestId: string;
  releaseCommitSha: string;
  releaseBuildFingerprint: string;
  candidateTaskDefinitionArn: string | null;
  stableManifestId: string;
  stableTaskDefinitionArn: string;
  stableServiceArn: string | null;
  infrastructureServiceArn: string | null;
  clusterArn: string | null;
  region: string;
};

/**
 * A foundation created before the first release deliberately has no ECS
 * service output. In that case the stable release is the authoritative service
 * owner; when infrastructure does own a service, the two exact ARNs must agree.
 */
export function hasCompatibleStableServiceIdentity(
  row: Pick<ReadinessRow, "stableServiceArn" | "infrastructureServiceArn" | "clusterArn">,
) {
  return typeof row.stableServiceArn === "string"
    && row.stableServiceArn.length > 0
    && typeof row.clusterArn === "string"
    && row.clusterArn.length > 0
    && (row.infrastructureServiceArn === null || row.infrastructureServiceArn === row.stableServiceArn);
}

/**
 * Explicitly callable later-release path. It is deliberately separate from the
 * initial-release runner: it updates an already-proven long-lived ECS service.
 */
@Injectable()
export class LaterReleaseOneShotRunnerService {
  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly composition: InactiveV1ReleaseLaneCompositionService,
    private readonly crossLane: CrossLaneOwnershipEnforcementService,
    private readonly capabilities: V1WorkerCapabilityService,
  ) {}

  async readiness(intentId: string) {
    if (!this.enabled() || !UUID.test(intentId)) {
      return { state: "blocked" as const, safeCodes: ["LATER_RELEASE_ONE_SHOT_DISABLED"] };
    }
    const composition = this.composition.getInactiveComposition();
    if (!composition?.laterReleaseImageClient) {
      return { state: "blocked" as const, safeCodes: ["LATER_RELEASE_COMPOSITION_NOT_READY"] };
    }
    const row = await this.load(intentId);
    if (!row) return { state: "blocked" as const, safeCodes: ["LATER_RELEASE_INTENT_NOT_CLAIMABLE"] };
    const expectedCommit = this.config.get<unknown>("TWO_LANE_LATER_RELEASE_COMMIT_SHA");
    if (typeof expectedCommit !== "string" || !COMMIT.test(expectedCommit)
      || row.releaseCommitSha.toLowerCase() !== expectedCommit.toLowerCase()) {
      return { state: "blocked" as const, safeCodes: ["LATER_RELEASE_COMMIT_MISMATCH"] };
    }
    if (!composition.allows(row.projectId, row.environmentName)
      || row.environmentName !== "dev"
      || !hasCompatibleStableServiceIdentity(row)) {
      return { state: "blocked" as const, safeCodes: ["LATER_RELEASE_STABLE_SERVICE_IDENTITY_INVALID"] };
    }
    try {
      const ecs = new ECSClient({ region: row.region });
      const response = await ecs.send(new DescribeServicesCommand({
        cluster: row.clusterArn,
        services: [row.stableServiceArn],
      }));
      const service = response.services?.length === 1 ? response.services[0] : null;
      const expectedTaskDefinition = row.status === "failed"
        && row.candidateTaskDefinitionArn
        ? row.candidateTaskDefinitionArn
        : row.stableTaskDefinitionArn;
      if (!service || service.status !== "ACTIVE" || service.clusterArn !== row.clusterArn
        || service.serviceArn !== row.stableServiceArn
        || service.taskDefinition !== expectedTaskDefinition) {
        return { state: "blocked" as const, safeCodes: ["LATER_RELEASE_STABLE_SERVICE_EVIDENCE_MISMATCH"] };
      }
    } catch {
      return { state: "blocked" as const, safeCodes: ["LATER_RELEASE_READ_ONLY_INSPECTION_FAILED"] };
    }
    return { state: "ready" as const, safeCodes: ["LATER_RELEASE_ONE_SHOT_READY"] };
  }

  async run(intentId: string) {
    if (this.config.get<unknown>("TWO_LANE_LATER_RELEASE_EXECUTE_APPROVED") !== "true") {
      throw new Error("LATER_RELEASE_EXECUTION_NOT_APPROVED");
    }
    const ready = await this.readiness(intentId);
    if (ready.state !== "ready") throw new Error(ready.safeCodes[0] || "LATER_RELEASE_NOT_READY");
    const row = await this.load(intentId);
    if (!row) throw new Error("LATER_RELEASE_INTENT_NOT_CLAIMABLE");
    const workerId = this.config.get<string>("TWO_LANE_RELEASE_WORKER_ID", "");
    if (!workerId) throw new Error("LATER_RELEASE_WORKER_INVALID");
    const claim = await this.crossLane.acquireV1({
      projectId: row.projectId,
      environmentName: "dev",
      intentId: row.intentId,
      actorId: workerId,
      requestFingerprint: row.requestFingerprint,
    });
    if (!claim.enabled) throw new Error("LATER_RELEASE_OWNERSHIP_DISABLED");
    const heartbeat = this.crossLane.startHeartbeat(claim, { leaseTtlMs: 60_000 });
    const capabilityHeartbeat = await this.capabilities.startHeartbeatSession({
      workerId,
      role: "release",
      supportedMessageTypes: ["intent.release.execute"],
      serviceVersion: "later-release-one-shot",
      gitSha: "local",
      heartbeatTtlMs: 60_000,
      metadata: {},
    });
    try {
      await this.enqueueForExecution(row);
      const composition = this.composition.getInactiveComposition();
      if (!composition?.laterReleaseImageClient) throw new Error("LATER_RELEASE_COMPOSITION_NOT_READY");
      const envelope = this.envelope(row);
      const result = await composition.invokeRelease({
        workerId,
        queueName: envelope.routing.queue,
        envelope,
        crossLaneClaim: claim,
        isCrossLaneTrusted: () => heartbeat.isTrusted(),
        beforeHandler: async (context: V1FencedPlaceholderHandlerContext) =>
          this.prepareImage(context, composition.laterReleaseImageClient!),
      });
      if (result.disposition === "completed" || result.disposition === "failed") {
        await this.crossLane.releaseV1(claim, {
          intentId: row.intentId,
          operationLeaseId: result.leaseId,
        });
      }
      return result;
    } finally {
      await heartbeat.stop();
      await capabilityHeartbeat.stop();
    }
  }

  private enabled() {
    return this.config.get<unknown>("TWO_LANE_LATER_RELEASE_ONE_SHOT_ENABLED") === "true"
      && this.config.get<unknown>("TWO_LANE_LATER_RELEASE_LIVE_CLIENT_ENABLED") === "true";
  }

  private async enqueueForExecution(row: ReadinessRow) {
    await this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `deployguard:later-release-resume:${row.intentId}`,
      ]);
      const intents = await manager.query(
        `SELECT status, failure_code AS "failureCode",
                requested_by_user_id AS "requestedByUserId"
         FROM deployment_intents
         WHERE id = $1 AND project_id = $2 AND environment_name = 'dev'
           AND classification = 'release_only' AND release_manifest_id = $3
           AND infrastructure_manifest_id = $4
         FOR UPDATE`,
        [row.intentId, row.projectId, row.releaseManifestId, row.infrastructureManifestId],
      );
      const intent = intents[0];
      if (!intent) throw new Error("LATER_RELEASE_INTENT_NOT_ENQUEUED");
      if (intent.status === "enqueued" || intent.status === "running") return;
      if (intent.status === "failed") {
        const eligiblePreMutation = await manager.query(
          `SELECT 1
           FROM release_manifests release
           WHERE release.id = $1 AND release.project_id = $2
             AND release.environment_name = 'dev'
             AND release.status = 'built'
             AND release.task_definition_arn IS NULL
             AND EXISTS (
               SELECT 1 FROM release_image_provenances provenance
               WHERE provenance.intent_id = $3
                 AND provenance.project_id = release.project_id
                 AND provenance.environment_name = release.environment_name
                 AND provenance.infrastructure_manifest_id = release.infrastructure_manifest_id
                 AND provenance.commit_sha = release.commit_sha
                 AND provenance.build_fingerprint = release.build_fingerprint
             )
             AND EXISTS (
               SELECT 1 FROM deployment_side_effects effect
               WHERE effect.intent_id = $3
                 AND effect.effect_type = 'ecr.build_push_immutable_image'
                 AND effect.status = 'succeeded'
             )
             AND NOT EXISTS (
               SELECT 1 FROM deployment_side_effects effect
               WHERE effect.intent_id = $3
                 AND effect.effect_type <> 'ecr.build_push_immutable_image'
             )
             AND NOT EXISTS (
               SELECT 1 FROM project_operation_leases lease
               WHERE lease.intent_id = $3
                 AND lease.status IN ('acquired','heartbeat_active')
                 AND lease.expires_at > clock_timestamp()
             )`,
          [row.releaseManifestId, row.projectId, row.intentId],
        );
        const eligibleOutcomeReconciliation = await manager.query(
          `SELECT 1
           FROM release_manifests release
           WHERE release.id = $1 AND release.project_id = $2
             AND release.environment_name = 'dev'
             AND release.status IN ('built','deploying')
             AND release.task_definition_arn IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM release_image_provenances provenance
               WHERE provenance.intent_id = $3
                 AND provenance.project_id = release.project_id
                 AND provenance.environment_name = release.environment_name
                 AND provenance.infrastructure_manifest_id = release.infrastructure_manifest_id
                 AND provenance.commit_sha = release.commit_sha
                 AND provenance.build_fingerprint = release.build_fingerprint
             )
             AND 3 = (
               SELECT count(*) FROM deployment_side_effects effect
               WHERE effect.intent_id = $3 AND effect.status = 'succeeded'
                 AND effect.effect_type IN (
                   'ecr.build_push_immutable_image',
                   'ecs.register_task_definition_revision',
                   'ecs.update_existing_service'
                 )
             )
             AND NOT EXISTS (
               SELECT 1 FROM deployment_side_effects effect
               WHERE effect.intent_id = $3
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
               WHERE lease.intent_id = $3
                 AND lease.status IN ('acquired','heartbeat_active')
                 AND lease.expires_at > clock_timestamp()
             )`,
          [row.releaseManifestId, row.projectId, row.intentId],
        );
        const preMutationResume = intent.failureCode === "RELEASE_MUTATION_FAILED"
          && eligiblePreMutation.length === 1;
        const outcomeResume = ["RELEASE_EVIDENCE_AMBIGUOUS", "RELEASE_MUTATION_FAILED"]
          .includes(intent.failureCode)
          && eligibleOutcomeReconciliation.length === 1;
        if (!preMutationResume && !outcomeResume) {
          throw new Error("LATER_RELEASE_FAILED_INTENT_RECONCILIATION_REQUIRED");
        }
        const action = outcomeResume
          ? "later_release.resume_for_outcome_reconciliation"
          : "later_release.resume_after_pre_mutation_failure";
        await manager.query(
          `INSERT INTO audit_logs (
             actor_user_id, action, category, resource_type, resource_id,
             status, metadata
           )
           SELECT $1, $4::text,
                  'release', 'deployment_intent', $2::text, 'resumed', $3::jsonb
           WHERE NOT EXISTS (
             SELECT 1 FROM audit_logs
             WHERE action = $4::text
               AND resource_type = 'deployment_intent' AND resource_id = $2::text
           )`,
          [
            intent.requestedByUserId,
            row.intentId,
            JSON.stringify({
              projectId: row.projectId,
              environment: "dev",
              releaseManifestId: row.releaseManifestId,
              infrastructureManifestId: row.infrastructureManifestId,
              reason: outcomeResume
                ? "verified_succeeded_mutations_pending_outcome_reconciliation"
                : "verified_pre_task_definition_failure",
            }),
            action,
          ],
        );
      } else if (intent.status !== "planned") {
        throw new Error("LATER_RELEASE_INTENT_NOT_ENQUEUED");
      }
      const updated = await manager.query(
        `UPDATE deployment_intents
         SET status = 'enqueued', enqueued_at = COALESCE(enqueued_at, clock_timestamp()),
             completed_at = NULL, failure_code = NULL, failure_message = NULL,
             updated_at = clock_timestamp()
         WHERE id = $1 AND status = $2
         RETURNING id`,
        [row.intentId, intent.status],
      );
      if (this.rows(updated).length !== 1) throw new Error("LATER_RELEASE_INTENT_NOT_ENQUEUED");
    });
  }

  private async load(intentId: string): Promise<ReadinessRow | null> {
    const rows = this.rows<ReadinessRow>(await this.dataSource.query(
      `SELECT intent.id AS "intentId", intent.status,
              intent.canonical_idempotency_key AS "canonicalKey",
              intent.request_fingerprint AS "requestFingerprint",
              intent.project_id AS "projectId", intent.environment_name AS "environmentName",
              intent.infrastructure_manifest_id AS "infrastructureManifestId",
              infrastructure.revision::text AS "infrastructureRevision",
              release.id AS "releaseManifestId", release.commit_sha AS "releaseCommitSha",
              release.build_fingerprint AS "releaseBuildFingerprint",
              release.task_definition_arn AS "candidateTaskDefinitionArn",
              stable.id AS "stableManifestId",
              stable.task_definition_arn AS "stableTaskDefinitionArn",
              COALESCE(stable.initial_service_arn, infrastructure.terraform_outputs->>'ecs_service_arn') AS "stableServiceArn",
              infrastructure.terraform_outputs->>'ecs_service_arn' AS "infrastructureServiceArn",
              infrastructure.terraform_outputs->>'ecs_cluster_arn' AS "clusterArn",
              infrastructure.desired_spec->>'region' AS region
       FROM deployment_intents intent
       INNER JOIN release_manifests release ON release.id = intent.release_manifest_id
       INNER JOIN infrastructure_manifests infrastructure
         ON infrastructure.id = intent.infrastructure_manifest_id AND infrastructure.status = 'applied'
       INNER JOIN release_manifests stable
         ON stable.id = release.previous_stable_manifest_id AND stable.status = 'stable'
       WHERE intent.id = $1 AND intent.classification = 'release_only'
         AND intent.environment_name = 'dev'
         AND (
           intent.status IN ('planned','enqueued','running')
           OR (
             intent.status = 'failed'
             AND intent.failure_code IN ('RELEASE_MUTATION_FAILED','RELEASE_EVIDENCE_AMBIGUOUS')
             AND release.status IN ('built','deploying')
             AND EXISTS (
               SELECT 1 FROM release_image_provenances provenance
               WHERE provenance.intent_id = intent.id
                 AND provenance.project_id = release.project_id
                 AND provenance.environment_name = release.environment_name
                 AND provenance.infrastructure_manifest_id = release.infrastructure_manifest_id
                 AND provenance.commit_sha = release.commit_sha
                 AND provenance.build_fingerprint = release.build_fingerprint
             )
             AND EXISTS (
               SELECT 1 FROM deployment_side_effects effect
               WHERE effect.intent_id = intent.id
                 AND effect.effect_type = 'ecr.build_push_immutable_image'
                 AND effect.status = 'succeeded'
             )
             AND (
               (
                 intent.failure_code = 'RELEASE_MUTATION_FAILED'
                 AND release.status = 'built'
                 AND release.task_definition_arn IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM deployment_side_effects effect
                   WHERE effect.intent_id = intent.id
                     AND effect.effect_type <> 'ecr.build_push_immutable_image'
                 )
               )
               OR (
                 intent.failure_code IN ('RELEASE_EVIDENCE_AMBIGUOUS','RELEASE_MUTATION_FAILED')
                 AND release.status IN ('built','deploying')
                 AND release.task_definition_arn IS NOT NULL
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
               )
             )
           )
         )
         AND release.project_id = intent.project_id
         AND release.environment_name = intent.environment_name
         AND release.infrastructure_manifest_id = infrastructure.id
         AND release.id <> stable.id`,
      [intentId],
    ));
    return rows.length === 1 ? rows[0] : null;
  }

  private envelope(row: ReadinessRow) {
    const envelope: any = {
      protocol: { name: "deployguard.worker", schemaVersion: 1, messageType: "intent.release.execute", minimumWorkerProtocol: 1, maximumWorkerProtocol: 1 },
      producer: { service: "deployguard-api", serviceVersion: "later-release-one-shot", gitSha: "local", producedAt: new Date().toISOString() },
      identity: { intentId: row.intentId, projectId: row.projectId, environmentName: "dev", pipelineRunId: null, destroyOperationId: null, infrastructureManifestId: row.infrastructureManifestId, releaseManifestId: row.releaseManifestId },
      routing: { lane: "release", operation: "execute", queue: "deployguard-release-v1" },
      idempotency: { canonicalKey: row.canonicalKey, payloadSha256: "0".repeat(64), attempt: 1, replayOfJobId: null },
      execution: { mode: "full", resumeFromStage: null, reusableCheckpointIds: [], invalidatedCheckpointIds: [], reasonCodes: ["LATER_RELEASE_ONE_SHOT"], fencingTokenRequired: true },
      trace: { correlationId: row.intentId, causationId: null, actorUserId: null },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    envelope.idempotency.payloadSha256 = canonicalSha256(workerEnvelopePayloadForHash(envelope));
    return envelope;
  }

  private async prepareImage(
    context: V1FencedPlaceholderHandlerContext,
    client: V1FirstReleaseBootstrapClient,
  ) {
    const release = context.releaseManifest;
    if (!release || !context.infrastructureManifest || context.intent.releaseManifestId !== release.id) {
      throw new Error("LATER_RELEASE_CONTEXT_INVALID");
    }
    const infrastructure = await this.dataSource.query(
      `SELECT terraform_outputs AS outputs, desired_spec AS "desiredSpec"
       FROM infrastructure_manifests WHERE id = $1 AND revision = $2::bigint
         AND project_id = $3 AND environment_name = 'dev' AND status = 'applied'`,
      [context.infrastructureManifest.id, context.infrastructureManifest.revision, context.intent.projectId],
    );
    const foundation = this.rows<{ outputs: Record<string, unknown>; desiredSpec: { region?: unknown } }>(infrastructure)[0];
    const repositoryUrl = foundation?.outputs?.ecr_repository_url;
    const region = foundation?.desiredSpec?.region;
    if (typeof repositoryUrl !== "string" || typeof region !== "string") {
      throw new Error("LATER_RELEASE_INFRASTRUCTURE_OUTPUT_INVALID");
    }
    const operationId = this.deterministicId(context.intent.id, "build-push");
    let pushed: V1FirstReleaseImageEvidence | null = null;
    const effect = await context.sideEffects.execute({
      operationId,
      idempotencyKey: canonicalSha256({ schemaVersion: 1, intentId: context.intent.id, effect: "later_release_push" }),
      effectType: "ecr.build_push_immutable_image",
      inputFingerprint: canonicalSha256({ repositoryUrl, commitSha: release.commitSha, buildFingerprint: release.buildFingerprint }),
      timeoutMs: 15 * 60_000,
      perform: async (ownership) => {
        const evidence = await client.buildAndPushImmutableImage({
          region, repositoryUrl, commitSha: release.commitSha, buildFingerprint: release.buildFingerprint,
          projectId: release.projectId, repositoryFullName: release.repositoryFullName,
          branch: release.branch, appRoot: release.appRoot,
          dockerStrategy: release.releaseSpec.build.dockerStrategy,
          deploymentContractHash: release.deploymentContractHash,
        }, ownership);
        pushed = evidence;
        return { outcome: "succeeded" as const, safeResultCode: "ECR_IMMUTABLE_IMAGE_PUSHED", resultFingerprint: canonicalSha256(evidence), externalReferenceHash: canonicalSha256({ imageUri: evidence.imageUri, imageDigest: evidence.imageDigest }) };
      },
    });
    if ((effect.disposition !== "executed" && effect.disposition !== "replayed") || effect.effect.status !== "succeeded") {
      throw new Error("LATER_RELEASE_IMAGE_RECONCILIATION_REQUIRED");
    }
    const evidence = pushed ?? await client.resolveImmutableImageEvidence({
      region, repositoryUrl, commitSha: release.commitSha, buildFingerprint: release.buildFingerprint,
      projectId: release.projectId, repositoryFullName: release.repositoryFullName,
      branch: release.branch, appRoot: release.appRoot,
      dockerStrategy: release.releaseSpec.build.dockerStrategy,
      deploymentContractHash: release.deploymentContractHash,
    }, { signal: context.execution.signal, deadlineAt: new Date(Date.now() + 60_000), isLeaseTrusted: context.execution.isLeaseTrusted, intentId: context.intent.id, projectId: context.intent.projectId, environmentName: "dev", operationId, idempotencyKey: context.intent.canonicalIdempotencyKey, effectType: "ecr.inspect_immutable_image", inputFingerprint: release.buildFingerprint, leaseId: context.leaseId, workerId: context.workerId, fencingToken: context.fencingToken } as never);
    if (!DIGEST.test(evidence.imageDigest) || evidence.commitSha !== release.commitSha || evidence.buildFingerprint !== release.buildFingerprint) {
      throw new Error("LATER_RELEASE_IMAGE_PROVENANCE_INVALID");
    }
    await this.recordImage(context, operationId, evidence);
  }

  private async recordImage(context: V1FencedPlaceholderHandlerContext, operationId: string, evidence: V1FirstReleaseImageEvidence) {
    await this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const fence = this.rows(await manager.query(
        `SELECT 1 FROM project_operation_leases lease JOIN deployment_intents intent ON intent.id = lease.intent_id
         WHERE lease.id = $1 AND lease.intent_id = $2 AND lease.project_id = $3 AND lease.environment_name = 'dev'
           AND lease.owner_worker_id = $4 AND lease.fencing_token = $5::bigint
           AND lease.status IN ('acquired','heartbeat_active') AND lease.expires_at > clock_timestamp()
           AND intent.status = 'running'`,
        [context.leaseId, context.intent.id, context.intent.projectId, context.workerId, context.fencingToken],
      ));
      if (fence.length !== 1) throw new Error("LATER_RELEASE_OWNERSHIP_LOST");
      const key = canonicalSha256({ schemaVersion: 1, intentId: context.intent.id, effect: "later_release_push", operationId });
      const existing = this.rows<{ imageUri: string; imageDigest: string; evidenceFingerprint: string }>(await manager.query(
        `SELECT image_uri AS "imageUri", image_digest AS "imageDigest", evidence_fingerprint AS "evidenceFingerprint"
         FROM release_image_provenances WHERE intent_id = $1 AND operation_id = $2 FOR UPDATE`,
        [context.intent.id, operationId],
      ))[0];
      const evidenceFingerprint = canonicalSha256(evidence);
      if (existing && (existing.imageUri !== evidence.imageUri || existing.imageDigest !== evidence.imageDigest || existing.evidenceFingerprint !== evidenceFingerprint)) {
        throw new Error("LATER_RELEASE_IMAGE_PROVENANCE_CONFLICT");
      }
      if (!existing) {
        await manager.query(
          `INSERT INTO release_image_provenances (intent_id, operation_id, idempotency_key, project_id, environment_name, infrastructure_manifest_id, infrastructure_revision, commit_sha, build_fingerprint, image_uri, image_digest, evidence_fingerprint)
           VALUES ($1,$2,$3,$4,'dev',$5,$6::bigint,$7,$8,$9,$10,$11)`,
          [context.intent.id, operationId, key, context.intent.projectId, context.infrastructureManifest!.id, context.infrastructureManifest!.revision, evidence.commitSha, evidence.buildFingerprint, evidence.imageUri, evidence.imageDigest, evidenceFingerprint],
        );
      }
      const updated = this.rows(await manager.query(
        `UPDATE release_manifests SET image_uri = $2, image_digest = $3, status = 'built',
             built_at = COALESCE(built_at, clock_timestamp()), updated_at = clock_timestamp()
         WHERE id = $1 AND project_id = $4 AND environment_name = 'dev'
           AND (image_uri IS NULL OR image_uri = $2) AND (image_digest IS NULL OR image_digest = $3)
         RETURNING id`,
        [context.releaseManifest!.id, evidence.imageUri, evidence.imageDigest, context.intent.projectId],
      ));
      if (updated.length !== 1) throw new Error("LATER_RELEASE_MANIFEST_IMAGE_CONFLICT");
    });
  }

  private deterministicId(intentId: string, suffix: string) {
    const hash = createHash("sha256").update(`${intentId}:${suffix}`).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  }

  private rows<T>(result: unknown): T[] {
    return Array.isArray(result) && Array.isArray(result[0]) ? result[0] as T[] : Array.isArray(result) ? result as T[] : [];
  }
}
