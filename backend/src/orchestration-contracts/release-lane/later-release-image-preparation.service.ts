import { createHash } from "node:crypto";
import { DataSource } from "typeorm";
import { canonicalSha256 } from "../contracts/canonical-json";
import { V1FirstReleaseBootstrapClient, V1FirstReleaseImageEvidence } from "../worker-runtime/inactive-v1-first-release-bootstrap.types";
import { V1FencedPlaceholderHandlerContext } from "../worker-runtime/v1-fenced-invocation.types";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Fenced, reusable preparation for a later release.  It deliberately has no
 * Nest lifecycle registration: a caller must already hold both v1 execution
 * fences before it can build or inspect an image.
 */
export class LaterReleaseImagePreparationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly client: V1FirstReleaseBootstrapClient,
  ) {}

  async prepare(context: V1FencedPlaceholderHandlerContext) {
    const release = context.releaseManifest;
    if (!release || !context.infrastructureManifest || context.intent.releaseManifestId !== release.id) {
      throw new Error("LATER_RELEASE_CONTEXT_INVALID");
    }
    // Initial releases own image preparation inside the first-release
    // bootstrap. Running the later-release hook as well creates two operation
    // identities for one immutable push and makes crash recovery ambiguous.
    if (
      release.previousStableManifestId === null
      && release.parentManifestId === null
    ) {
      return;
    }
    const infrastructure = this.rows<{ outputs: Record<string, unknown>; desiredSpec: { region?: unknown } }>(
      await this.dataSource.query(
        `SELECT terraform_outputs AS outputs, desired_spec AS "desiredSpec"
         FROM infrastructure_manifests WHERE id = $1 AND revision = $2::bigint
           AND project_id = $3 AND environment_name = 'dev' AND status = 'applied'`,
        [context.infrastructureManifest.id, context.infrastructureManifest.revision, context.intent.projectId],
      ),
    )[0];
    const repositoryUrl = infrastructure?.outputs?.ecr_repository_url;
    const region = infrastructure?.desiredSpec?.region;
    if (typeof repositoryUrl !== "string" || typeof region !== "string") {
      throw new Error("LATER_RELEASE_INFRASTRUCTURE_OUTPUT_INVALID");
    }
    const operationId = this.deterministicId(context.intent.id, "build-push");
    let pushed: V1FirstReleaseImageEvidence | null = null;
    const request = {
      region,
      repositoryUrl,
      commitSha: release.commitSha,
      buildFingerprint: release.buildFingerprint,
      projectId: release.projectId,
      repositoryFullName: release.repositoryFullName,
      branch: release.branch,
      appRoot: release.appRoot,
      dockerStrategy: release.releaseSpec.build.dockerStrategy,
      deploymentContractHash: release.deploymentContractHash,
    } as const;
    const effect = await context.sideEffects.execute({
      operationId,
      idempotencyKey: canonicalSha256({ schemaVersion: 1, intentId: context.intent.id, effect: "later_release_push" }),
      effectType: "ecr.build_push_immutable_image",
      inputFingerprint: canonicalSha256({ repositoryUrl, commitSha: release.commitSha, buildFingerprint: release.buildFingerprint }),
      timeoutMs: 15 * 60_000,
      perform: async (ownership) => {
        let evidence: V1FirstReleaseImageEvidence;
        try {
          evidence = await this.client.buildAndPushImmutableImage(request, ownership);
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          // These occur before any registry mutation. Preserve their durable,
          // truthful failure code rather than making a later recovery guess.
          if ([
            "FIRST_RELEASE_BUILD_CONTRACT_INVALID",
            "FIRST_RELEASE_DOCKERFILE_CONTEXT_UNAVAILABLE",
            "FIRST_RELEASE_DOCKERFILE_UNAVAILABLE",
            "FIRST_RELEASE_SOURCE_PIN_MISMATCH",
            "FIRST_RELEASE_APP_ROOT_INVALID",
            "FIRST_RELEASE_DOCKER_BUILD_FAILED",
            "FIRST_RELEASE_ECR_LOGIN_FAILED",
            "FIRST_RELEASE_DOCKER_TAG_FAILED",
          ].includes(code)) {
            return { outcome: "failed" as const, safeFailureCode: code };
          }
          throw error;
        }
        pushed = evidence;
        return {
          outcome: "succeeded" as const,
          safeResultCode: "ECR_IMMUTABLE_IMAGE_PUSHED",
          resultFingerprint: canonicalSha256(evidence),
          externalReferenceHash: canonicalSha256({ imageUri: evidence.imageUri, imageDigest: evidence.imageDigest }),
        };
      },
    });
    if ((effect.disposition !== "executed" && effect.disposition !== "replayed") || effect.effect.status !== "succeeded") {
      throw new Error("LATER_RELEASE_IMAGE_RECONCILIATION_REQUIRED");
    }
    const evidence = pushed ?? await this.client.resolveImmutableImageEvidence(request, {
      signal: context.execution.signal,
      deadlineAt: new Date(Date.now() + 60_000),
      isLeaseTrusted: context.execution.isLeaseTrusted,
      intentId: context.intent.id,
      projectId: context.intent.projectId,
      environmentName: "dev",
      operationId,
      idempotencyKey: context.intent.canonicalIdempotencyKey,
      effectType: "ecr.inspect_immutable_image",
      inputFingerprint: release.buildFingerprint,
      leaseId: context.leaseId,
      workerId: context.workerId,
      fencingToken: context.fencingToken,
    });
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
