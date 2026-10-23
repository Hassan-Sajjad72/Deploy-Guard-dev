import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
import { DataSource, EntityManager } from "typeorm";
import { getFinopsConfig } from "../../finops/finops.config";
import { InfracostService } from "../../finops/infracost.service";
import { TerraformRunnerService } from "../../infrastructure/terraform-runner.service";
import { canonicalSha256 } from "../contracts/canonical-json";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE = /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*@sha256:([0-9a-f]{64})$/;

export type V1BaselineImageProvenance = Readonly<{
  kind: "checkpoint" | "operator_frozen";
  immutableImage: string;
  checkpointId?: string;
  contractId?: string;
  evidenceSha256?: string;
  attestedAt?: string;
}>;

export type V1InfrastructurePlanReview = Readonly<{
  manifestId: string;
  revision: string;
  planHash: string | null;
  resourceSummary: Readonly<{ create: number; update: number; replace: number; delete: number; noOp: number; resourceTypes: string[] }> | null;
  baselineProvenance: "verified" | "unverified";
  costEstimate: Readonly<{ state: "real" | "unavailable" | "stale" | "mismatch"; currency: string | null; monthlyCost: number | null; resourceCount: number | null }>;
  destroyInstruction: Readonly<{ stateKey: string; workspaceRef: string; command: string; sharedStateBucketExcluded: true }> | null;
  approvalReady: boolean;
  safeCodes: string[];
}>;

type StoredReference = Record<string, unknown>;

/** Explicit review-only service. It never plans, applies, publishes, or deploys. */
@Injectable()
export class V1InfrastructurePlanReviewService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly terraform: TerraformRunnerService,
    private readonly infracost: InfracostService,
  ) {}

  async review(manifestId: string, provenance: V1BaselineImageProvenance): Promise<V1InfrastructurePlanReview> {
    if (!UUID.test(manifestId)) throw new Error("Invalid infrastructure manifest identifier.");
    const prepared = await this.dataSource.transaction("SERIALIZABLE", (manager) => this.prepare(manager, manifestId, provenance));
    if (prepared.review) return prepared.review;

    let artifactHash: string;
    try {
      artifactHash = await this.artifactHash(prepared.workspace);
    } catch {
      return this.persistReview(prepared.manifestId, prepared.planHash, prepared.provenance, null, "PLAN_ARTIFACT_UNAVAILABLE");
    }
    if (artifactHash !== prepared.planHash) {
      return this.persistReview(prepared.manifestId, prepared.planHash, prepared.provenance, null, "PLAN_ARTIFACT_HASH_MISMATCH");
    }

    const finops = getFinopsConfig(this.config);
    if (finops.mockMode || !finops.infracostEnabled) {
      return this.persistReview(prepared.manifestId, prepared.planHash, prepared.provenance, null, "REAL_INFRACOST_UNAVAILABLE");
    }

    try {
      const planJson = await this.terraform.runTerraformShowJson(prepared.workspace, {
        AWS_ACCESS_KEY_ID: "offline-plan",
        AWS_SECRET_ACCESS_KEY: "offline-plan",
        AWS_SESSION_TOKEN: "",
      });
      const raw = await this.infracost.runInfracostBreakdown(planJson.stdout, prepared.workspace);
      const resources = this.infracost.normalizeCostBreakdown(this.infracost.parseInfracostResponse(raw));
      const cost = {
        state: "real" as const,
        currency: finops.currency,
        monthlyCost: this.money(resources.reduce((total, resource) => total + resource.monthlyCost, 0)),
        resourceCount: resources.length,
        resourceTypes: [...new Set(resources.map((resource) => resource.resourceType))].sort(),
      };
      return this.persistReview(prepared.manifestId, prepared.planHash, prepared.provenance, cost, null);
    } catch {
      return this.persistReview(prepared.manifestId, prepared.planHash, prepared.provenance, null, "REAL_INFRACOST_UNAVAILABLE");
    }
  }

  private async prepare(manager: EntityManager, manifestId: string, input: V1BaselineImageProvenance) {
    const manifests = manager.getRepository(InfrastructureManifest);
    const rows = await manager.query(`SELECT id FROM infrastructure_manifests WHERE id = $1 FOR UPDATE`, [manifestId]) as Array<{ id: string }>;
    if (!rows.length) throw new Error("Infrastructure manifest not found.");
    const manifest = await manifests.findOneByOrFail({ id: manifestId });
    if (manifest.status !== "planned" || !manifest.planArtifactSha256 || !manifest.planArtifactReference) {
      return { review: this.package(manifest, "unverified", null, ["PLAN_NOT_READY"]) };
    }
    const reference = manifest.planArtifactReference as StoredReference;
    const expectedImageHash = typeof reference.baselineImageReferenceHash === "string" ? reference.baselineImageReferenceHash : null;
    const provenance = await this.verifyProvenance(manager, manifest, expectedImageHash, input);
    if (provenance.safeCode) return { review: this.package(manifest, "unverified", null, [provenance.safeCode]) };
    const workspaceRef = typeof reference.workspaceRef === "string" ? reference.workspaceRef : "";
    const workspace = this.workspacePath(manifest, workspaceRef);
    const previous = reference.review as Record<string, unknown> | undefined;
    if (previous?.cost && previous.planArtifactSha256 !== manifest.planArtifactSha256) {
      return { review: this.package(manifest, "verified", null, ["REAL_INFRACOST_ESTIMATE_STALE"]) };
    }
    const existing = this.storedCost(reference, manifest.planArtifactSha256, provenance.fingerprint);
    if (existing) return { review: this.package(manifest, "verified", existing, []) };
    return { manifestId: manifest.id, planHash: manifest.planArtifactSha256, workspace, provenance };
  }

  private async verifyProvenance(
    manager: EntityManager,
    manifest: InfrastructureManifest,
    expectedImageHash: string | null,
    input: V1BaselineImageProvenance,
  ) {
    if (!IMAGE.test(input.immutableImage) || !expectedImageHash || canonicalSha256({ image: input.immutableImage }) !== expectedImageHash) {
      return { fingerprint: "", safeCode: "BASELINE_IMAGE_PROVENANCE_INVALID" };
    }
    const digest = input.immutableImage.split("@", 2)[1];
    const repository = input.immutableImage.split("@", 1)[0];
    if (input.kind === "checkpoint") {
      if (!input.checkpointId || !UUID.test(input.checkpointId)) return { fingerprint: "", safeCode: "BASELINE_IMAGE_PROVENANCE_INVALID" };
      const [checkpoint] = await manager.query(
        `SELECT id, pipeline_run_id, stage, status, image_digest, artifact_reference
           FROM project_stage_checkpoints WHERE id = $1 AND project_id = $2`,
        [input.checkpointId, manifest.projectId],
      ) as Array<{ id: string; pipeline_run_id: string; stage: string; status: string; image_digest: string | null; artifact_reference: Record<string, unknown> | null }>;
      const checkpointImage = typeof checkpoint?.artifact_reference?.ecrImageUri === "string" ? checkpoint.artifact_reference.ecrImageUri : "";
      const checkpointRepository = checkpointImage.split(/[:@]/, 1)[0];
      if (!checkpoint || !["passed", "reused"].includes(checkpoint.status) || checkpoint.stage !== "ecr_push" || checkpoint.image_digest !== digest || checkpointRepository !== repository) {
        return { fingerprint: "", safeCode: "BASELINE_IMAGE_PROVENANCE_UNVERIFIED" };
      }
      return { fingerprint: canonicalSha256({ kind: input.kind, checkpointId: checkpoint.id, runId: checkpoint.pipeline_run_id, digest }), safeCode: null };
    }
    if (
      !input.contractId || !UUID.test(input.contractId) || !input.evidenceSha256 || !SHA256.test(input.evidenceSha256)
      || !input.attestedAt || Number.isNaN(Date.parse(input.attestedAt))
    ) return { fingerprint: "", safeCode: "BASELINE_IMAGE_PROVENANCE_INVALID" };
    return {
      fingerprint: canonicalSha256({ kind: input.kind, contractId: input.contractId, evidenceSha256: input.evidenceSha256, attestedAt: new Date(input.attestedAt).toISOString(), imageHash: expectedImageHash }),
      safeCode: null,
    };
  }

  private async persistReview(
    manifestId: string,
    planHash: string,
    provenance: { fingerprint: string; safeCode: string | null },
    cost: { state: "real"; currency: string; monthlyCost: number; resourceCount: number; resourceTypes: string[] } | null,
    safeCode: string | null,
  ) {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const manifests = manager.getRepository(InfrastructureManifest);
      const manifest = await manifests.findOneByOrFail({ id: manifestId });
      if (manifest.status !== "planned" || manifest.planArtifactSha256 !== planHash || !manifest.planArtifactReference) {
        return this.package(manifest, "unverified", null, ["PLAN_ESTIMATE_HASH_MISMATCH"]);
      }
      const reference = manifest.planArtifactReference as StoredReference;
      const review = {
        schemaVersion: 1,
        planArtifactSha256: planHash,
        baselineProvenanceFingerprint: provenance.fingerprint,
        baselineProvenance: provenance.safeCode ? "unverified" : "verified",
        cost: cost ? { ...cost, estimateHash: canonicalSha256({ planHash, provenance: provenance.fingerprint, cost }) } : { state: safeCode === "PLAN_ARTIFACT_HASH_MISMATCH" ? "mismatch" : "unavailable", safeCode },
        reviewedAt: new Date().toISOString(),
      };
      manifest.planArtifactReference = { ...reference, review };
      await manifests.save(manifest);
      return this.package(manifest, provenance.safeCode ? "unverified" : "verified", cost, safeCode ? [safeCode] : []);
    });
  }

  private storedCost(reference: StoredReference, planHash: string, provenanceFingerprint: string) {
    const review = reference.review as Record<string, unknown> | undefined;
    const cost = review?.cost as Record<string, unknown> | undefined;
    if (!review || review.planArtifactSha256 !== planHash || review.baselineProvenanceFingerprint !== provenanceFingerprint || cost?.state !== "real") return null;
    if (typeof cost.monthlyCost !== "number" || typeof cost.resourceCount !== "number" || typeof cost.currency !== "string") return null;
    return {
      state: "real" as const,
      currency: cost.currency,
      monthlyCost: cost.monthlyCost,
      resourceCount: cost.resourceCount,
      resourceTypes: Array.isArray(cost.resourceTypes) ? cost.resourceTypes.filter((value): value is string => typeof value === "string") : [],
    };
  }

  private package(
    manifest: InfrastructureManifest,
    provenance: "verified" | "unverified",
    cost: { state: "real"; currency: string; monthlyCost: number; resourceCount: number; resourceTypes: string[] } | null,
    codes: string[],
  ): V1InfrastructurePlanReview {
    const reference = manifest.planArtifactReference as StoredReference | null;
    const summary = reference?.planSummary as V1InfrastructurePlanReview["resourceSummary"] || null;
    const workspaceRef = typeof reference?.workspaceRef === "string" ? reference.workspaceRef : null;
    const approvalReady = manifest.status === "planned" && provenance === "verified" && cost?.state === "real" && !codes.length;
    return {
      manifestId: manifest.id,
      revision: manifest.revision,
      planHash: manifest.planArtifactSha256,
      resourceSummary: summary,
      baselineProvenance: provenance,
      costEstimate: cost ? { state: "real", currency: cost.currency, monthlyCost: cost.monthlyCost, resourceCount: cost.resourceCount } : { state: codes.includes("PLAN_ARTIFACT_HASH_MISMATCH") ? "mismatch" : "unavailable", currency: null, monthlyCost: null, resourceCount: null },
      destroyInstruction: manifest.status === "planned" && workspaceRef ? { stateKey: manifest.stateKey, workspaceRef, command: `terraform -chdir=${workspaceRef} destroy -input=false -var-file=terraform.tfvars.json`, sharedStateBucketExcluded: true } : null,
      approvalReady,
      safeCodes: [...new Set(codes)].sort(),
    };
  }

  private async artifactHash(workspace: string) {
    return createHash("sha256").update(await readFile(join(workspace, "tfplan"))).digest("hex");
  }

  private workspacePath(manifest: InfrastructureManifest, workspaceRef: string) {
    const expected = `v1-plan/${manifest.projectId}/${manifest.id}/terraform`;
    if (workspaceRef !== expected) throw new Error("Plan workspace reference is invalid.");
    const root = resolve(process.cwd(), this.config.get<string>("TERRAFORM_WORKING_BASE_DIR", "./.deployguard/terraform-workspaces"));
    const workspace = resolve(root, workspaceRef);
    const path = relative(root, workspace);
    if (!path || path.startsWith("..") || isAbsolute(path)) throw new Error("Plan workspace escaped the configured root.");
    return workspace;
  }

  private money(value: number) { return Math.round((value + Number.EPSILON) * 100) / 100; }
}
