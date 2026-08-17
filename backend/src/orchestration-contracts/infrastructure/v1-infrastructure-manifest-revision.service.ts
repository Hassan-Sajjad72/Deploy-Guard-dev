import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { canonicalSha256 } from "../contracts/canonical-json";
import { validateInfrastructureManifestCreate } from "../contracts/manifest.validator";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type V1InfrastructureManifestRevisionResult = Readonly<{
  manifestId: string;
  revision: string;
  replayed: boolean;
  stateKey: string;
}>;

/**
 * Explicit internal creator for a new immutable v1 infrastructure revision.
 * It creates no deployment intent, outbox event, job, or cloud side effect.
 */
@Injectable()
export class V1InfrastructureManifestRevisionService {
  constructor(private readonly dataSource: DataSource) {}

  async createRetryAfterFailedRemotePlan(input: { projectId: string; environmentName: "dev"; parentManifestId: string }): Promise<V1InfrastructureManifestRevisionResult> {
    if (!UUID.test(input.projectId) || !UUID.test(input.parentManifestId) || input.environmentName !== "dev") {
      throw new Error("CANARY_MANIFEST_REVISION_INPUT_INVALID");
    }
    return this.withSerializableRetry(() => this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`deployguard:v1-infrastructure-manifest:${input.projectId}:${input.environmentName}`]);
      const project = await manager.query(`SELECT id FROM projects WHERE id = $1 FOR KEY SHARE`, [input.projectId]) as Array<{ id: string }>;
      if (project.length !== 1) throw new Error("CANARY_PROJECT_NOT_FOUND");
      const manifests = manager.getRepository(InfrastructureManifest);
      const parent = await manifests.findOne({ where: { id: input.parentManifestId, projectId: input.projectId, environmentName: input.environmentName } });
      if (!parent || parent.status !== "failed" || parent.stateBackend !== "s3") throw new Error("CANARY_PARENT_MANIFEST_NOT_ELIGIBLE");
      const rows = await manager.query(
        `SELECT id, revision FROM infrastructure_manifests WHERE project_id = $1 AND environment_name = $2 ORDER BY revision::bigint DESC FOR UPDATE`,
        [input.projectId, input.environmentName],
      ) as Array<{ id: string; revision: string }>;
      const expectedRevision = (BigInt(rows[0]?.revision || "0") + 1n).toString();
      const existing = rows.find((row) => row.revision === expectedRevision);
      const expectedKey = `projects/${input.projectId}/dev/v1/${expectedRevision}.tfstate`;
      if (existing) {
        const manifest = await manifests.findOneByOrFail({ id: existing.id });
        if (manifest.parentManifestId !== parent.id || manifest.stateKey !== expectedKey || manifest.stateBackend !== "s3") {
          throw new Error("CANARY_MANIFEST_REVISION_CONFLICT");
        }
        return { manifestId: manifest.id, revision: manifest.revision, replayed: true, stateKey: manifest.stateKey };
      }
      const desiredSpec = structuredClone(parent.desiredSpec);
      const specHash = canonicalSha256(desiredSpec);
      const create = {
        schemaVersion: 1 as const,
        projectId: input.projectId,
        environmentName: input.environmentName,
        parentManifestId: parent.id,
        createdByUserId: parent.createdByUserId,
        origin: "planner" as const,
        terraformTemplateVersion: parent.terraformTemplateVersion,
        stateBackend: "s3" as const,
        stateKey: expectedKey,
        desiredSpec,
        changeSet: {
          fromManifestId: parent.id,
          changedPaths: [],
          categories: [],
          destructivePaths: [],
          requiresApproval: true,
          reasonCodes: ["RETRY_AFTER_FAILED_REMOTE_PLAN", "REMOTE_PROVIDER_MODE_CORRECTED"],
        },
        requiresTerraform: true,
        specHash,
      };
      validateInfrastructureManifestCreate(create);
      const manifest = await manifests.save(manifests.create({
        ...create,
        revision: expectedRevision,
        createdByIntentId: null,
        status: "desired",
        stateVersionId: null,
        planArtifactReference: null,
        planArtifactSha256: null,
        planInputFingerprint: null,
        planConfigurationFingerprint: null,
        terraformOutputs: null,
        terraformOutputsHash: null,
        resourceCount: null,
        failureCode: null,
        failureMessage: null,
        plannedAt: null,
        approvedAt: null,
        applyStartedAt: null,
        appliedAt: null,
        supersededAt: null,
        destroyedAt: null,
      }));
      return { manifestId: manifest.id, revision: manifest.revision, replayed: false, stateKey: manifest.stateKey };
    }));
  }

  private async withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try { return await operation(); }
      catch (error) {
        const code = (error as { driverError?: { code?: string }; code?: string }).driverError?.code || (error as { code?: string }).code;
        if (code !== "40001" || attempt >= 2) throw error;
      }
    }
  }
}
