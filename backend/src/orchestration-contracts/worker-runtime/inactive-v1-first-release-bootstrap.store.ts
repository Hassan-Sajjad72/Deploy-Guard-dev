import { DataSource, EntityManager } from "typeorm";
import { canonicalSha256 } from "../contracts/canonical-json";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { ReleaseImageProvenance } from "../entities/release-image-provenance.entity";
import { ReleaseManifest } from "../entities/release-manifest.entity";
import {
  V1FirstReleaseBootstrapError,
  V1FirstReleaseBootstrapIdentity,
  V1FirstReleaseBootstrapStore,
  V1FirstReleaseFence,
  V1FirstReleaseImageEvidence,
  V1FirstReleaseHealthEvidence,
  V1FirstReleaseInfrastructureIdentity,
  V1FirstReleaseManifest,
} from "./inactive-v1-first-release-bootstrap.types";
import { V1EcsAppliedInfrastructureRevision } from "./inactive-v1-ecs-release-mutation.types";
import { validateReleaseManifestCreate } from "../contracts/manifest.validator";
import { InactiveV1StableReleaseProjectionStore } from "./inactive-v1-stable-release-projection.store";

/** Database implementation is intentionally unregistered; a future handler must opt in. */
export class InactiveV1FirstReleaseBootstrapStore
implements V1FirstReleaseBootstrapStore {
  constructor(private readonly dataSource: DataSource) {}

  async loadAppliedInfrastructure(identity: V1FirstReleaseInfrastructureIdentity): Promise<V1EcsAppliedInfrastructureRevision | null> {
    const manifest = await this.dataSource.getRepository(InfrastructureManifest).findOne({ where: { id: identity.infrastructureManifestId, projectId: identity.projectId, environmentName: identity.environmentName, revision: identity.infrastructureRevision, status: "applied" } });
    if (!manifest || !manifest.terraformOutputs || !manifest.terraformOutputsHash) return null;
    if (canonicalSha256(manifest.terraformOutputs) !== manifest.terraformOutputsHash) throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_INFRASTRUCTURE_OUTPUT_HASH_INVALID");
    return { ...manifest, schemaVersion: 1, status: "applied", terraformOutputs: manifest.terraformOutputs, terraformOutputsHash: manifest.terraformOutputsHash };
  }

  async loadImageProvenance(identity: Pick<V1FirstReleaseBootstrapIdentity, "intentId" | "buildPushOperationId">): Promise<V1FirstReleaseImageEvidence | null> {
    const row = await this.dataSource.getRepository(ReleaseImageProvenance).findOne({
      where: { intentId: identity.intentId, operationId: identity.buildPushOperationId },
    });
    return row ? this.evidence(row) : null;
  }

  async loadReleaseManifest(identity: Pick<V1FirstReleaseBootstrapIdentity, "intentId" | "projectId" | "environmentName" | "infrastructureManifestId">): Promise<V1FirstReleaseManifest | null> {
    const row = await this.dataSource.getRepository(ReleaseManifest).findOne({
      where: { createdByIntentId: identity.intentId, projectId: identity.projectId, environmentName: identity.environmentName, infrastructureManifestId: identity.infrastructureManifestId },
      order: { createdAt: "ASC" },
    });
    return row ? this.release(row) : null;
  }

  async recordImageProvenance(input: { identity: V1FirstReleaseBootstrapIdentity; evidence: V1FirstReleaseImageEvidence; evidenceFingerprint: string; fence: V1FirstReleaseFence }): Promise<V1FirstReleaseImageEvidence> {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      await this.assertFence(manager, input.identity, input.fence);
      const repo = manager.getRepository(ReleaseImageProvenance);
      const existing = await repo.findOne({ where: { intentId: input.identity.intentId, operationId: input.identity.buildPushOperationId } });
      if (existing) {
        if (existing.idempotencyKey !== this.effectKey(input.identity.idempotencyKey, "push_image", input.identity.buildPushOperationId) || existing.imageUri !== input.evidence.imageUri || existing.imageDigest !== input.evidence.imageDigest || existing.evidenceFingerprint !== input.evidenceFingerprint) throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_IMAGE_PROVENANCE_CONFLICT");
        return this.evidence(existing);
      }
      const row = await repo.save(repo.create({
        intentId: input.identity.intentId, operationId: input.identity.buildPushOperationId,
        idempotencyKey: this.effectKey(input.identity.idempotencyKey, "push_image", input.identity.buildPushOperationId), projectId: input.identity.projectId,
        environmentName: input.identity.environmentName, infrastructureManifestId: input.identity.infrastructureManifestId,
        infrastructureRevision: input.identity.infrastructureRevision, commitSha: input.evidence.commitSha,
        buildFingerprint: input.evidence.buildFingerprint, imageUri: input.evidence.imageUri, imageDigest: input.evidence.imageDigest,
        evidenceFingerprint: input.evidenceFingerprint,
      }));
      return this.evidence(row);
    });
  }

  async createOrReuseReleaseManifest(input: { identity: V1FirstReleaseBootstrapIdentity; release: import("../contracts/release-manifest.types").CreateReleaseManifestInputV1; evidence: V1FirstReleaseImageEvidence; fence: V1FirstReleaseFence }): Promise<V1FirstReleaseManifest> {
    validateReleaseManifestCreate(input.release);
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      await this.assertFence(manager, input.identity, input.fence);
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`deployguard:first-release:${input.identity.projectId}:${input.identity.environmentName}`]);
      const provenance = await manager.getRepository(ReleaseImageProvenance).findOne({ where: { intentId: input.identity.intentId, operationId: input.identity.buildPushOperationId } });
      if (!provenance || provenance.imageUri !== input.evidence.imageUri || provenance.imageDigest !== input.evidence.imageDigest || provenance.infrastructureManifestId !== input.identity.infrastructureManifestId || provenance.infrastructureRevision !== input.identity.infrastructureRevision) throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_IMAGE_PROVENANCE_REQUIRED");
      const repo = manager.getRepository(ReleaseManifest);
      const existing = await repo.findOne({ where: { createdByIntentId: input.identity.intentId, infrastructureManifestId: input.identity.infrastructureManifestId }, order: { createdAt: "ASC" } });
      if (existing) {
        // Normal first-release planning intentionally creates a desired,
        // image-less candidate.  It is hydrated only after durable immutable
        // provenance exists, under the same fence as the provenance write.
        const frozenSpec = {
          ...input.release.releaseSpec,
          runtime: {
            ...input.release.releaseSpec.runtime,
            imageUri: null,
            imageDigest: null,
          },
        };
        const frozenIdentityMatches =
          existing.specHash === canonicalSha256(frozenSpec)
          && existing.repositoryFullName === input.release.repositoryFullName
          && existing.branch === input.release.branch
          && existing.commitSha === input.release.commitSha
          && existing.deploymentContractHash === input.release.deploymentContractHash
          && existing.configurationFingerprint === input.release.configurationFingerprint
          && existing.buildFingerprint === input.release.buildFingerprint
          && existing.runtimeFingerprint === input.release.runtimeFingerprint;
        if ((!existing.imageUri && !frozenIdentityMatches)
          || (existing.imageUri !== null && existing.imageUri !== input.evidence.imageUri)
          || (existing.imageDigest !== null && existing.imageDigest !== input.evidence.imageDigest)) {
          throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_MANIFEST_CONFLICT");
        }
        if (
          !existing.imageUri
          || !existing.imageDigest
          || (
            frozenIdentityMatches
            && existing.specHash !== input.release.specHash
          )
        ) {
          existing.imageUri = input.evidence.imageUri;
          existing.imageDigest = input.evidence.imageDigest;
          existing.releaseSpec = input.release.releaseSpec;
          existing.specHash = input.release.specHash;
          existing.status = "building";
          existing.builtAt = new Date();
          await repo.save(existing);
        } else if (existing.specHash !== input.release.specHash) {
          throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_MANIFEST_CONFLICT");
        }
        await this.linkIntentRelease(manager, input.identity.intentId, existing.id);
        return this.release(existing);
      }
      const row = await manager.query(`SELECT COALESCE(MAX(revision), 0)::bigint + 1 AS revision FROM release_manifests WHERE project_id = $1 AND environment_name = $2`, [input.identity.projectId, input.identity.environmentName]);
      const revision = String(this.rows(row)[0]?.revision ?? "1");
      const created = await repo.save(repo.create({
        ...input.release, revision, createdByIntentId: input.identity.intentId, pipelineRunId: null,
        parentManifestId: null, previousStableManifestId: null, status: "building", imageUri: input.evidence.imageUri,
        imageDigest: input.evidence.imageDigest, taskDefinitionInputHash: null, taskDefinitionArn: null,
        initialServiceInputHash: null, initialServiceArn: null, healthEvidence: null, failureCode: null, failureMessage: null,
        buildStartedAt: null, builtAt: new Date(), deploymentStartedAt: null, healthVerifiedAt: null, promotedAt: null,
        supersededAt: null, rollbackStartedAt: null, rolledBackAt: null,
      }));
      await this.linkIntentRelease(manager, input.identity.intentId, created.id);
      return this.release(created);
    });
  }

  async recordTaskDefinition(input: { releaseManifestId: string; taskDefinitionInputHash: string; taskDefinitionArn: string; fence: V1FirstReleaseFence }): Promise<V1FirstReleaseManifest> {
    return this.recordReference(input.releaseManifestId, input.fence, { taskDefinitionInputHash: input.taskDefinitionInputHash, taskDefinitionArn: input.taskDefinitionArn }, "FIRST_RELEASE_TASK_REFERENCE_CONFLICT");
  }

  async recordInitialService(input: { releaseManifestId: string; serviceInputHash: string; serviceArn: string; fence: V1FirstReleaseFence }): Promise<V1FirstReleaseManifest> {
    return this.recordReference(input.releaseManifestId, input.fence, { initialServiceInputHash: input.serviceInputHash, initialServiceArn: input.serviceArn }, "FIRST_RELEASE_SERVICE_REFERENCE_CONFLICT");
  }

  async recordHealthyRelease(input: { releaseManifestId: string; evidence: V1FirstReleaseHealthEvidence; fence: V1FirstReleaseFence }): Promise<V1FirstReleaseManifest> {
    if (input.evidence.safeCode !== "FIRST_RELEASE_HEALTHY"
      || !/^[0-9a-f]{64}$/.test(input.evidence.evidenceHash)
      || !/^http:\/\/[A-Za-z0-9.-]{1,253}\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)$/.test(input.evidence.applicationUrl)) {
      throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_HEALTH_EVIDENCE_INVALID");
    }
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const repo = manager.getRepository(ReleaseManifest);
      const manifest = await repo.findOne({ where: { id: input.releaseManifestId } });
      if (!manifest || !manifest.taskDefinitionArn || !manifest.initialServiceArn) {
        throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_HEALTH_EVIDENCE_INVALID");
      }
      await this.assertFence(manager, {
        projectId: manifest.projectId,
        environmentName: manifest.environmentName,
        intentId: input.fence.intentId,
      }, input.fence);
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`deployguard:first-release:${manifest.projectId}:${manifest.environmentName}`]);
      const healthEvidence = {
        schemaVersion: 1,
        safeCode: input.evidence.safeCode,
        evidenceHash: input.evidence.evidenceHash,
        applicationUrl: input.evidence.applicationUrl,
      };
      if (manifest.status === "stable") {
        if (canonicalSha256(manifest.healthEvidence) !== canonicalSha256(healthEvidence)) {
          throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_HEALTH_EVIDENCE_CONFLICT");
        }
      } else {
        const now = new Date();
        Object.assign(manifest, {
          status: "stable",
          healthEvidence,
          healthVerifiedAt: now,
          promotedAt: now,
          failureCode: null,
          failureMessage: null,
        });
        await repo.save(manifest);
      }
      await new InactiveV1StableReleaseProjectionStore(this.dataSource)
        .syncWithinTransaction(manager, manifest.id);
      return this.release(manifest);
    });
  }

  private async recordReference(id: string, fence: V1FirstReleaseFence, values: Partial<ReleaseManifest>, code: string): Promise<V1FirstReleaseManifest> {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const manifest = await manager.getRepository(ReleaseManifest).findOne({ where: { id } });
      if (!manifest) throw new V1FirstReleaseBootstrapError(code);
      await this.assertFence(manager, {
        projectId: manifest.projectId,
        environmentName: manifest.environmentName,
        intentId: fence.intentId,
      }, fence);
      for (const [key, value] of Object.entries(values)) {
        const existing = manifest[key as keyof ReleaseManifest];
        if (existing !== null && existing !== value) throw new V1FirstReleaseBootstrapError(code);
      }
      Object.assign(manifest, values, { status: "deploying" });
      return this.release(await manager.getRepository(ReleaseManifest).save(manifest));
    });
  }

  private async assertFence(manager: EntityManager, identity: Pick<V1FirstReleaseBootstrapIdentity, "projectId" | "environmentName" | "intentId">, fence: V1FirstReleaseFence) {
    if (identity.intentId !== fence.intentId) throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_FENCE_MISMATCH");
    const rows = this.rows(await manager.query(`SELECT 1 FROM project_operation_leases lease INNER JOIN deployment_intents intent ON intent.id = lease.intent_id WHERE lease.id = $1 AND lease.intent_id = $2 AND lease.project_id = $3 AND lease.environment_name = $4 AND lease.owner_worker_id = $5 AND lease.fencing_token = $6::bigint AND lease.status IN ('acquired','heartbeat_active') AND lease.expires_at > clock_timestamp() AND intent.status = 'running'`, [fence.leaseId, fence.intentId, identity.projectId, identity.environmentName, fence.workerId, fence.fencingToken]));
    if (rows.length !== 1) throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_OWNERSHIP_LOST");
  }

  private async linkIntentRelease(manager: EntityManager, intentId: string, releaseManifestId: string) {
    const rows = this.rows(await manager.query(
      `UPDATE deployment_intents
       SET release_manifest_id = $2, updated_at = clock_timestamp()
       WHERE id = $1 AND (release_manifest_id IS NULL OR release_manifest_id = $2)
       RETURNING id`,
      [intentId, releaseManifestId],
    ));
    if (rows.length !== 1) throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_MANIFEST_CONFLICT");
  }

  private effectKey(root: string, effect: string, operationId: string) { return canonicalSha256({ schemaVersion: 1, root, effect, operationId }); }
  private evidence(row: ReleaseImageProvenance): V1FirstReleaseImageEvidence { return { imageUri: row.imageUri, imageDigest: row.imageDigest, commitSha: row.commitSha, buildFingerprint: row.buildFingerprint }; }
  private release(row: ReleaseManifest): V1FirstReleaseManifest { return { id: row.id, revision: row.revision, projectId: row.projectId, environmentName: row.environmentName, infrastructureManifestId: row.infrastructureManifestId, imageUri: row.imageUri!, imageDigest: row.imageDigest!, releaseSpec: row.releaseSpec, taskDefinitionInputHash: row.taskDefinitionInputHash, taskDefinitionArn: row.taskDefinitionArn, initialServiceInputHash: row.initialServiceInputHash, initialServiceArn: row.initialServiceArn }; }
  private rows(result: unknown): any[] { return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : Array.isArray(result) ? result : []; }
}
