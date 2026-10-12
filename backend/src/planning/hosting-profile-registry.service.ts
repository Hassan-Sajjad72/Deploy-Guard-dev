import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { CUSTOMER_CONTROL_PLANE_EXECUTABLE_SHA256 } from "../projects/github-actions-workflow-contract";
import { HostingProfile, hostingCatalog, planFingerprint } from "./deployment-plan";

export const PROVIDER_CHECKS = ["deploy", "retry", "rollback", "ownership", "cleanup", "aws_runtime", "budget"] as const;
export type FinalProviderProof = {
  contractVersion: "deployguard.final-provider-proof/v1"; profile: HostingProfile; region: string;
  adapterVersion: string; executableFingerprint: string; accountId: string; verifiedAt: string; expiresAt: string;
  checks: Array<{ check: typeof PROVIDER_CHECKS[number]; status: "verified"; artifactSha256: string }>;
  finalApproval: { approvalId: string; actorId: string; approvedAt: string };
};
// Availability requires both implemented executable contracts and separately supplied final provider proof.
export const IMPLEMENTED_PROVIDER_CONTRACTS: Partial<Record<HostingProfile, { version: string; fingerprint: string }>> = {
  ecs_fargate: { version: "deployguard.customer-workflow/v1", fingerprint: planFingerprint(CUSTOMER_CONTROL_PLANE_EXECUTABLE_SHA256) },
};

export function verifiedProfileProof(config: ConfigService, profile: HostingProfile, region: string): FinalProviderProof | null {
  const key = config.get<string>("DEPLOYGUARD_FINAL_PROVIDER_PROOF_SIGNING_KEY", "");
  const approvalId = config.get<string>("DEPLOYGUARD_FINAL_PROVIDER_APPROVAL_ID", "");
  const adapter = IMPLEMENTED_PROVIDER_CONTRACTS[profile];
  if (!adapter || key.length < 32 || !approvalId) return null;
  try {
    const encoded = config.get<string>("DEPLOYGUARD_FINAL_PROVIDER_PROOFS", "[]");
    if (encoded.length > 65536) return null;
    const entries = JSON.parse(encoded);
    if (!Array.isArray(entries) || entries.length > 100) return null;
    for (const envelope of entries) {
      const proof: FinalProviderProof = envelope?.proof;
      if (!proof || proof.profile !== profile || proof.region !== region || proof.contractVersion !== "deployguard.final-provider-proof/v1" || proof.adapterVersion !== adapter.version || proof.executableFingerprint !== adapter.fingerprint || !/^\d{12}$/.test(proof.accountId) || !Array.isArray(proof.checks)) continue;
      const dates = [proof.verifiedAt, proof.expiresAt, proof.finalApproval?.approvedAt].map(Date.parse);
      if (dates.some((date) => !Number.isFinite(date)) || dates[0] > Date.now() || dates[1] <= Date.now() || dates[1] - dates[0] > 90 * 86400000 || dates[2] < dates[0] || dates[2] > Date.now() || proof.finalApproval?.approvalId !== approvalId || !proof.finalApproval?.actorId?.trim()) continue;
      if (proof.checks.length !== PROVIDER_CHECKS.length || new Set(proof.checks.map((entry) => entry.check)).size !== PROVIDER_CHECKS.length || !PROVIDER_CHECKS.every((check) => proof.checks.some((entry) => entry.check === check && entry.status === "verified" && /^[0-9a-f]{64}$/.test(entry.artifactSha256)))) continue;
      const signature = createHmac("sha256", key).update(planFingerprint(proof)).digest();
      if (typeof envelope.signature !== "string" || !/^[0-9a-f]{64}$/.test(envelope.signature) || !timingSafeEqual(signature, Buffer.from(envelope.signature, "hex"))) continue;
      return proof;
    }
  } catch { /* Malformed or unsigned operator evidence fails closed. */ }
  return null;
}

@Injectable()
export class HostingProfileRegistryService {
  constructor(private readonly config: ConfigService) {}
  available(profile: HostingProfile, region: string) { return verifiedProfileProof(this.config, profile, region) !== null; }
  catalog(region = "") {
    return hostingCatalog.map((profile) => {
      const proof = verifiedProfileProof(this.config, profile.id, region);
      return { ...profile, available: Boolean(proof), implementation: IMPLEMENTED_PROVIDER_CONTRACTS[profile.id] ? "customer_execution_contract" : profile.implementation,
        reason: proof ? "Final provider evidence verified for this region and executable version." : "Final provider evidence is unavailable for this region and executable version.",
        verification: proof ? { status: "verified", fingerprint: planFingerprint(proof), region, adapterVersion: proof.adapterVersion, executableFingerprint: proof.executableFingerprint, verifiedAt: proof.verifiedAt, expiresAt: proof.expiresAt, approvalId: proof.finalApproval.approvalId } : { status: "unverified", region } };
    });
  }
}
