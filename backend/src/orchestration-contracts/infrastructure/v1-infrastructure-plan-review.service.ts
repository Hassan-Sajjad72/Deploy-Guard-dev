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

export type V1InfrastructurePlanReview = Readonly<{
  manifestId: string;
  revision: string;
  planHash: string | null;
  resourceSummary: Readonly<{ create: number; update: number; replace: number; delete: number; noOp: number; resourceTypes: string[] }> | null;
  costEstimate: Readonly<{ state: "real" | "deferred" | "unavailable" | "stale" | "mismatch"; currency: string | null; monthlyCost: number | null; resourceCount: number | null }>;
  destroyInstruction: Readonly<{ stateKey: string; workspaceRef: string; command: string; sharedStateBucketExcluded: true }> | null;
  approvalReady: boolean;
  safeCodes: string[];
}>;

type StoredReference = Record<string, unknown>;
type RealCost = { state: "real"; currency: string; monthlyCost: number; resourceCount: number; resourceTypes: string[] };

/** Explicit infrastructure-only review. Image provenance belongs to the release lane. */
@Injectable()
export class V1InfrastructurePlanReviewService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly terraform: TerraformRunnerService,
    private readonly infracost: InfracostService,
  ) {}

  async review(manifestId: string): Promise<V1InfrastructurePlanReview> {
    if (!UUID.test(manifestId)) throw new Error("Invalid infrastructure manifest identifier.");
    const prepared = await this.dataSource.transaction("SERIALIZABLE", (manager) => this.prepare(manager, manifestId));
    if (prepared.review) return prepared.review;

    let artifactHash: string;
    try { artifactHash = await this.artifactHash(prepared.workspace); }
    catch { return this.persistReview(prepared.manifestId, prepared.planHash, null, "PLAN_ARTIFACT_UNAVAILABLE"); }
    if (artifactHash !== prepared.planHash) return this.persistReview(prepared.manifestId, prepared.planHash, null, "PLAN_ARTIFACT_HASH_MISMATCH");

    if (this.costDeferredCanary(prepared.manifest)) {
      return this.persistReview(prepared.manifestId, prepared.planHash, null, "COST_ESTIMATE_DEFERRED");
    }

    const finops = getFinopsConfig(this.config);
    if (finops.mockMode || !finops.infracostEnabled) return this.persistReview(prepared.manifestId, prepared.planHash, null, "REAL_INFRACOST_UNAVAILABLE");
    if (!this.config.get<string>("INFRACOST_API_KEY")?.trim()) {
      return this.persistReview(prepared.manifestId, prepared.planHash, null, "REAL_INFRACOST_AUTH_REQUIRED");
    }
    try {
      const planJson = await this.terraform.runTerraformShowJson(prepared.workspace, { AWS_ACCESS_KEY_ID: "offline-plan", AWS_SECRET_ACCESS_KEY: "offline-plan", AWS_SESSION_TOKEN: "" });
      const raw = await this.infracost.runInfracostBreakdown(planJson.stdout, prepared.workspace);
      const resources = this.infracost.normalizeCostBreakdown(this.infracost.parseInfracostResponse(raw));
      const cost: RealCost = {
        state: "real", currency: finops.currency,
        monthlyCost: this.money(resources.reduce((total, resource) => total + resource.monthlyCost, 0)),
        resourceCount: resources.length,
        resourceTypes: [...new Set(resources.map((resource) => resource.resourceType))].sort(),
      };
      return this.persistReview(prepared.manifestId, prepared.planHash, cost, null);
    } catch { return this.persistReview(prepared.manifestId, prepared.planHash, null, "REAL_INFRACOST_UNAVAILABLE"); }
  }

  private async prepare(manager: EntityManager, manifestId: string) {
    const manifests = manager.getRepository(InfrastructureManifest);
    const rows = await manager.query(`SELECT id FROM infrastructure_manifests WHERE id = $1 FOR UPDATE`, [manifestId]) as Array<{ id: string }>;
    if (!rows.length) throw new Error("Infrastructure manifest not found.");
    const manifest = await manifests.findOneByOrFail({ id: manifestId });
    if (manifest.status !== "planned" || !manifest.planArtifactSha256 || !manifest.planArtifactReference) return { review: this.package(manifest, null, ["PLAN_NOT_READY"]) };
    const reference = manifest.planArtifactReference as StoredReference;
    const workspaceRef = typeof reference.workspaceRef === "string" ? reference.workspaceRef : "";
    const workspace = this.workspacePath(manifest, workspaceRef);
    const previous = reference.review as Record<string, unknown> | undefined;
    if (previous?.cost && previous.planArtifactSha256 !== manifest.planArtifactSha256) return { review: this.package(manifest, null, ["REAL_INFRACOST_ESTIMATE_STALE"]) };
    const existing = this.storedCost(reference, manifest.planArtifactSha256);
    if (existing) return { review: this.package(manifest, existing, []) };
    return { manifest, manifestId: manifest.id, planHash: manifest.planArtifactSha256, workspace };
  }

  private async persistReview(manifestId: string, planHash: string, cost: RealCost | null, safeCode: string | null) {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const manifests = manager.getRepository(InfrastructureManifest);
      const manifest = await manifests.findOneByOrFail({ id: manifestId });
      if (manifest.status !== "planned" || manifest.planArtifactSha256 !== planHash || !manifest.planArtifactReference) return this.package(manifest, null, ["PLAN_ESTIMATE_HASH_MISMATCH"]);
      const reference = manifest.planArtifactReference as StoredReference;
      manifest.planArtifactReference = {
        ...reference,
        review: {
          schemaVersion: 1,
          planArtifactSha256: planHash,
          cost: cost ? { ...cost, estimateHash: canonicalSha256({ planHash, cost }) } : { state: safeCode === "COST_ESTIMATE_DEFERRED" ? "deferred" : safeCode === "PLAN_ARTIFACT_HASH_MISMATCH" ? "mismatch" : "unavailable", safeCode },
          reviewedAt: new Date().toISOString(),
        },
      };
      await manifests.save(manifest);
      return this.package(manifest, cost, safeCode ? [safeCode] : []);
    });
  }

  private storedCost(reference: StoredReference, planHash: string): RealCost | null {
    const review = reference.review as Record<string, unknown> | undefined;
    const cost = review?.cost as Record<string, unknown> | undefined;
    if (!review || review.planArtifactSha256 !== planHash || cost?.state !== "real") return null;
    if (typeof cost.monthlyCost !== "number" || typeof cost.resourceCount !== "number" || typeof cost.currency !== "string") return null;
    return { state: "real", currency: cost.currency, monthlyCost: cost.monthlyCost, resourceCount: cost.resourceCount, resourceTypes: Array.isArray(cost.resourceTypes) ? cost.resourceTypes.filter((value): value is string => typeof value === "string") : [] };
  }

  private package(manifest: InfrastructureManifest, cost: RealCost | null, codes: string[]): V1InfrastructurePlanReview {
    const reference = manifest.planArtifactReference as StoredReference | null;
    const summary = reference?.planSummary as V1InfrastructurePlanReview["resourceSummary"] || null;
    const workspaceRef = typeof reference?.workspaceRef === "string" ? reference.workspaceRef : null;
    return {
      manifestId: manifest.id, revision: manifest.revision, planHash: manifest.planArtifactSha256, resourceSummary: summary,
      costEstimate: cost ? { state: "real", currency: cost.currency, monthlyCost: cost.monthlyCost, resourceCount: cost.resourceCount } : { state: codes.includes("COST_ESTIMATE_DEFERRED") ? "deferred" : codes.includes("PLAN_ARTIFACT_HASH_MISMATCH") ? "mismatch" : "unavailable", currency: null, monthlyCost: null, resourceCount: null },
      destroyInstruction: manifest.status === "planned" && workspaceRef ? { stateKey: manifest.stateKey, workspaceRef, command: `terraform -chdir=${workspaceRef} destroy -input=false -var-file=terraform.tfvars.json`, sharedStateBucketExcluded: true } : null,
      approvalReady: manifest.status === "planned" && (cost?.state === "real" || codes.includes("COST_ESTIMATE_DEFERRED")) && !codes.some((code) => code !== "COST_ESTIMATE_DEFERRED"),
      safeCodes: [...new Set(codes)].sort(),
    };
  }

  private costDeferredCanary(manifest: InfrastructureManifest) {
    return this.config.get<string>("TWO_LANE_CANARY_COST_MODE", "") === "deferred_canary"
      && this.config.get<string>("TWO_LANE_CANARY_COST_DEFERRED_ACKNOWLEDGED", "") === "true"
      && this.config.get<string>("TWO_LANE_CANARY_PROJECT_ID", "") === manifest.projectId
      && this.config.get<string>("TWO_LANE_CANARY_ENVIRONMENT", "") === "dev"
      && manifest.environmentName === "dev";
  }

  private async artifactHash(workspace: string) { return createHash("sha256").update(await readFile(join(workspace, "tfplan"))).digest("hex"); }
  private workspacePath(manifest: InfrastructureManifest, workspaceRef: string) {
    const expected = `${manifest.stateBackend === "s3" ? "v1-remote-plan" : "v1-plan"}/${manifest.projectId}/${manifest.id}/terraform`;
    if (workspaceRef !== expected) throw new Error("Plan workspace reference is invalid.");
    const root = resolve(process.cwd(), this.config.get<string>("TERRAFORM_WORKING_BASE_DIR", "./.deployguard/terraform-workspaces"));
    const workspace = resolve(root, workspaceRef);
    const path = relative(root, workspace);
    if (!path || path.startsWith("..") || isAbsolute(path)) throw new Error("Plan workspace escaped the configured root.");
    return workspace;
  }
  private money(value: number) { return Math.round((value + Number.EPSILON) * 100) / 100; }
}
