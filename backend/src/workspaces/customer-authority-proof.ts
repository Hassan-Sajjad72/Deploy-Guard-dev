import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ecsTaskBoundaryArn, planFingerprint } from "../planning/deployment-plan";
import { AwsAccountBinding } from "./aws-account-binding.entity";
import { customerControlPlanePrincipal } from "./customer-control-plane-principal";
export const CUSTOMER_AUTHORITY_CHECKS = ["external_id_trust", "temporary_credentials", "resource_ownership", "iam_permissions", "rollback_cleanup", "no_platform_account_mutation"] as const;
export type CustomerAuthorityProof = {
  contractVersion: "deployguard.customer-authority-proof/v1";
  organizationId: string; bindingId: string; bindingVersion: number; accountId: string; roleArn: string; regions: string[]; projectIds: string[];
  workflowBrokerRoles: Record<string, string>; executionRoleBoundaryArns: Record<string, string>;
  verifiedAt: string; expiresAt: string; checks: Array<{ check: typeof CUSTOMER_AUTHORITY_CHECKS[number]; status: "verified"; artifactSha256: string }>;
  finalApproval: { approvalId: string; actorId: string; approvedAt: string };
};
export type CustomerAuthorityEnvelope = { proof: CustomerAuthorityProof; signature: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateCustomerAuthorityProof(config: ConfigService, envelope: unknown, binding: AwsAccountBinding, projectId?: string): CustomerAuthorityProof | null {
  try {
    const { proof, signature } = envelope as CustomerAuthorityEnvelope;
    const key = config.get<string>("DEPLOYGUARD_FINAL_PROVIDER_PROOF_SIGNING_KEY", "");
    if (key.length < 32 || JSON.stringify(envelope).length > 32768 || !proof || proof.contractVersion !== "deployguard.customer-authority-proof/v1" || !UUID.test(proof.organizationId) || !UUID.test(proof.bindingId) || proof.organizationId !== binding.organizationId || proof.bindingId !== binding.id || proof.bindingVersion !== binding.verificationVersion || proof.accountId !== binding.accountId || proof.roleArn !== binding.roleArn || binding.verificationStatus !== "verified" || !binding.verifiedAt) return null;
    if (!Array.isArray(proof.regions) || !proof.regions.length || proof.regions.length > 30 || new Set(proof.regions).size !== proof.regions.length || planFingerprint([...proof.regions].sort()) !== planFingerprint([...binding.regions].sort()) || !Array.isArray(proof.projectIds) || !proof.projectIds.length || proof.projectIds.length > 100 || !proof.projectIds.every((id) => UUID.test(id)) || new Set(proof.projectIds).size !== proof.projectIds.length || projectId && !proof.projectIds.includes(projectId)) return null;
    const control = customerControlPlanePrincipal(config), platformAccount = control.split(":")[4];
    if (!/^\d{12}$/.test(platformAccount) || !proof.workflowBrokerRoles || Object.keys(proof.workflowBrokerRoles).length !== proof.projectIds.length || !proof.projectIds.every((id) => proof.workflowBrokerRoles[id] === `arn:aws:iam::${platformAccount}:role/dg-customer-broker-${id.replaceAll("-", "").slice(0, 12)}` || proof.workflowBrokerRoles[id]?.startsWith(`arn:aws:iam::${platformAccount}:role/deployguard/customer-brokers/${id}/`))) return null;
    if (!proof.executionRoleBoundaryArns || Object.keys(proof.executionRoleBoundaryArns).length !== proof.projectIds.length || !proof.projectIds.every((id) => proof.executionRoleBoundaryArns[id] === ecsTaskBoundaryArn(binding.accountId, id))) return null;
    if (Object.values(proof.workflowBrokerRoles).some((role) => role === control || role === config.get<string>("DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN", ""))) return null;
    const dates = [proof.verifiedAt, proof.expiresAt, proof.finalApproval?.approvedAt].map(Date.parse);
    if (dates.some((date) => !Number.isFinite(date)) || dates[0] < new Date(binding.verifiedAt).getTime() || dates[0] > Date.now() || dates[1] <= Date.now() || dates[1] - dates[0] > 30 * 86400000 || dates[2] < dates[0] || dates[2] > Date.now() || proof.finalApproval?.approvalId !== config.get<string>("DEPLOYGUARD_FINAL_PROVIDER_APPROVAL_ID", "") || !proof.finalApproval?.actorId?.trim()) return null;
    if (!Array.isArray(proof.checks) || proof.checks.length !== CUSTOMER_AUTHORITY_CHECKS.length || new Set(proof.checks.map((entry) => entry.check)).size !== CUSTOMER_AUTHORITY_CHECKS.length || !CUSTOMER_AUTHORITY_CHECKS.every((check) => proof.checks.some((entry) => entry.check === check && entry.status === "verified" && /^[0-9a-f]{64}$/.test(entry.artifactSha256)))) return null;
    const expected = createHmac("sha256", key).update(planFingerprint(proof)).digest();
    if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature) || !timingSafeEqual(expected, Buffer.from(signature, "hex"))) return null;
    return proof;
  } catch { return null; }
}
export function customerMutationAuthorized(config: ConfigService, binding: AwsAccountBinding, projectId: string) {
  return binding.verificationEvidence?.mutationAuthority === "verified" && validateCustomerAuthorityProof(config, binding.verificationEvidence?.authorityProof, binding, projectId) !== null;
}
