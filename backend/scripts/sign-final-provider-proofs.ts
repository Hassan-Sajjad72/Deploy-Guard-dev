// Signs final provider proofs from passing live evidence (scripts/verify-hosting-profiles-live.ts) for the current executable.
// Usage:
//   npm run sign:final-provider-proofs -- --init                       (once: create signing key + approval ID in backend/.env)
//   npm run sign:final-provider-proofs -- --actor <name> <evidence.json>...
// Fails closed: a proof is written only when every PROVIDER_CHECK is backed by observed evidence for this exact executable.
import "reflect-metadata";
import { strict as assert } from "node:assert";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { ConfigService } from "@nestjs/config";
import { InfracostService } from "../src/finops/infracost.service";
import { AwsPublicPricingService } from "../src/planning/aws-public-pricing.service";
import { compareHosting, planFingerprint, WorkloadAssumptions } from "../src/planning/deployment-plan";
import { hostingExecutableFingerprint } from "../src/planning/hosting-profile-inputs";
import { HostingPricingService } from "../src/planning/hosting-pricing.service";
import { FinalProviderProof, HostingProfileRegistryService, IMPLEMENTED_PROVIDER_CONTRACTS, PROVIDER_CHECKS } from "../src/planning/hosting-profile-registry.service";

const envPath = join(__dirname, "..", ".env");
const ADAPTER_VERSION = "deployguard.hosting-provider/v1", PROOF_DAYS = 30, CERTIFICATION_BUDGET_USD = 50;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Evidence = { contractVersion: string; runId: string; profile: "ec2" | "lightsail" | "lambda"; region: string; accountId: string; adapterVersion: string; executableFingerprint: string; executableUnchanged: boolean; completedAt: string; passed: boolean; results: Record<string, string> };

function setEnv(updates: Record<string, string>) {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const [key, value] of Object.entries(updates)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`; else lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
  }
  writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
}

// Each check is certified only by the exact observed results it needs; the artifact hash binds those results to the run.
function checkEvidence(evidence: Evidence) {
  const r = evidence.results, removals = Object.keys(r).filter((key) => key.startsWith("removed_"));
  const need: Record<Exclude<typeof PROVIDER_CHECKS[number], "budget">, string[]> = {
    deploy: ["deploy_1", "deploy_2"], retry: ["retry_rejected", "retry", ...(r.retry_candidate_removed ? ["retry_candidate_removed"] : [])], rollback: ["rollback"], ownership: ["rollback", "cleanup_guard"],
    cleanup: ["cleanup_1", "cleanup_2", ...removals], aws_runtime: ["monitoring_endpoint", "monitoring_metrics"],
  };
  assert(removals.length >= 5 && removals.every((key) => /^confirmed |^none remain/.test(r[key])), `${evidence.runId}: independent removal evidence is incomplete.`);
  assert(/^verified in \d+s; health healthy at https:\/\//.test(r.deploy_1) && /^verified in \d+s; health healthy at https:\/\//.test(r.deploy_2), `${evidence.runId}: both deploys must be verified healthy.`);
  assert(/^unhealthy candidate rejected/.test(r.retry_rejected || "") && /route stayed on generation 1, HTTP 200$/.test(r.retry_rejected) && /^fresh attempt deployed and verified/.test(r.retry || ""), `${evidence.runId}: retry evidence is incomplete.`);
  assert(/^verified; route returned to generation 1 after fresh ownership and health proof$/.test(r.rollback) && r.cleanup_guard === "active generation cleanup refused", `${evidence.runId}: rollback/ownership evidence is incomplete.`);
  assert(/^deleted through inspected destroy plan/.test(r.cleanup_1) && /^deleted through inspected destroy plan/.test(r.cleanup_2), `${evidence.runId}: cleanup evidence is incomplete.`);
  assert(/application healthy, HTTP 200$/.test(r.monitoring_endpoint) && /^read-only metric query succeeded/.test(r.monitoring_metrics), `${evidence.runId}: AWS runtime evidence is incomplete.`);
  return Object.fromEntries(Object.entries(need).map(([check, keys]) => [check, sha({ runId: evidence.runId, profile: evidence.profile, executableFingerprint: evidence.executableFingerprint, check, results: Object.fromEntries(keys.map((key) => [key, r[key]])) })]));
}

// The workload each live run deployed, priced with the production pricing path and judged by the adapter's own comparison.
const WORKLOADS: Record<Evidence["profile"], WorkloadAssumptions> = {
  ec2: { cpu: .5, memoryMiB: 256, replicas: 1, storageGiB: 30, monthlyRequests: 1000, monthlyTransferGiB: 1, monthlyLogGiB: 1, availability: "single_instance", stateful: false, continuousCompute: true, monthlyBudgetUsd: CERTIFICATION_BUDGET_USD },
  lightsail: { cpu: .25, memoryMiB: 512, replicas: 1, storageGiB: 1, monthlyRequests: 1000, monthlyTransferGiB: 1, monthlyLogGiB: 1, availability: "single_instance", stateful: false, continuousCompute: true, monthlyBudgetUsd: CERTIFICATION_BUDGET_USD },
  lambda: { cpu: .25, memoryMiB: 256, replicas: 1, storageGiB: 1, monthlyRequests: 1000, monthlyTransferGiB: 1, monthlyLogGiB: 1, availability: "single_instance", stateful: false, continuousCompute: false, monthlyBudgetUsd: CERTIFICATION_BUDGET_USD },
};
const QUANTITIES = { imageStorageGiB: 1, publicIpv4Count: 1, albNewConnectionsPerSecond: 0, albActiveConnectionsPerMinute: 0, albRuleEvaluationsPerSecond: 0, monthlyIntraRegionGiB: 0, stateStorageGiB: .1, monthlyStateWriteRequests: 100, monthlyStateReadRequests: 100, monthlySecretApiRequests: 0, backupStorageGiB: 0, averageRequestDurationMs: 100 };
async function budgetEvidence(profile: Evidence["profile"], region: string, config: ConfigService) {
  const assumptions = { ...WORKLOADS[profile], pricing: QUANTITIES };
  const costs = await new HostingPricingService(new InfracostService(config), new AwsPublicPricingService()).estimate({ region, assumptions, serviceCount: 1, managedDatabase: false, runtimeSecretCount: 0 });
  const option = compareHosting({ region, assumptions, targets: [{ status: "resolved" } as any], managedDatabase: false, requirements: { status: "READY" } as any, configuration: { references: 0, secrets: 0 }, verifiedBuildKinds: ["lambda_http"] }, costs).options.find((item) => item.id === profile)!;
  assert(option.cost.status === "complete" && option.cost.monthlyUsd !== null && option.cost.monthlyUsd <= assumptions.monthlyBudgetUsd, `${profile}: no complete estimate within the $${assumptions.monthlyBudgetUsd} certification budget.`);
  const cost = costs.find((item) => item.profile === profile)!;
  return { sha: sha({ profile, region, assumptions, cost }), monthlyUsd: option.cost.monthlyUsd, source: cost.source, estimatedAt: cost.estimatedAt };
}

async function main() {
  if (process.argv.includes("--init")) {
    const env = parse(readFileSync(envPath));
    assert(!env.DEPLOYGUARD_FINAL_PROVIDER_PROOF_SIGNING_KEY && !env.DEPLOYGUARD_FINAL_PROVIDER_APPROVAL_ID, "Signing configuration already exists; refusing to replace it.");
    setEnv({ DEPLOYGUARD_FINAL_PROVIDER_PROOF_SIGNING_KEY: randomBytes(32).toString("hex"), DEPLOYGUARD_FINAL_PROVIDER_APPROVAL_ID: randomUUID() });
    console.log("Created DEPLOYGUARD_FINAL_PROVIDER_PROOF_SIGNING_KEY (not shown) and DEPLOYGUARD_FINAL_PROVIDER_APPROVAL_ID in backend/.env.");
    return;
  }
  const actorIndex = process.argv.indexOf("--actor"), actorId = actorIndex > 0 ? process.argv[actorIndex + 1] : "";
  const files = process.argv.slice(2).filter((arg, index, all) => arg !== "--actor" && all[index - 1] !== "--actor");
  assert(actorId?.trim() && files.length, "Pass --actor <approver> and at least one evidence file.");
  const env = parse(readFileSync(envPath)), key = env.DEPLOYGUARD_FINAL_PROVIDER_PROOF_SIGNING_KEY || "", approvalId = env.DEPLOYGUARD_FINAL_PROVIDER_APPROVAL_ID || "";
  assert(key.length >= 32 && approvalId, "Run --init first.");
  const config = new ConfigService(env);
  const fingerprint = planFingerprint(await hostingExecutableFingerprint());
  const existing: Array<{ proof: FinalProviderProof; signature: string }> = JSON.parse(env.DEPLOYGUARD_FINAL_PROVIDER_PROOFS || "[]");
  const signed: typeof existing = [];
  for (const file of files) {
    const evidence: Evidence = JSON.parse(readFileSync(file, "utf8"));
    assert(evidence.contractVersion === "deployguard.live-provider-evidence/v1" && ["ec2", "lightsail", "lambda"].includes(evidence.profile) && /^\d{12}$/.test(evidence.accountId), `${file}: not live provider evidence.`);
    assert(evidence.passed && evidence.executableUnchanged, `${evidence.runId}: the live run did not pass on an unchanged executable.`);
    assert(evidence.adapterVersion === ADAPTER_VERSION && evidence.executableFingerprint === fingerprint, `${evidence.runId}: evidence certifies ${evidence.executableFingerprint.slice(0, 12)}, but the current executable is ${fingerprint.slice(0, 12)}.`);
    const checks = checkEvidence(evidence), budget = await budgetEvidence(evidence.profile, evidence.region, config);
    const verifiedAt = evidence.completedAt, approvedAt = new Date().toISOString();
    const proof: FinalProviderProof = {
      contractVersion: "deployguard.final-provider-proof/v1", profile: evidence.profile, region: evidence.region, adapterVersion: ADAPTER_VERSION, executableFingerprint: fingerprint, accountId: evidence.accountId,
      verifiedAt, expiresAt: new Date(Date.parse(verifiedAt) + PROOF_DAYS * 86400000).toISOString(),
      checks: PROVIDER_CHECKS.map((check) => ({ check, status: "verified" as const, artifactSha256: check === "budget" ? budget.sha : checks[check] })),
      finalApproval: { approvalId, actorId: actorId.trim(), approvedAt },
    };
    signed.push({ proof, signature: createHmac("sha256", key).update(planFingerprint(proof)).digest("hex") });
    console.log(`${evidence.profile}/${evidence.region}: run ${evidence.runId}, budget $${budget.monthlyUsd.toFixed(2)}/month (${budget.source}), expires ${proof.expiresAt}`);
  }
  // Keep proofs for other profile/region pairs; replace only those just certified.
  const proofs = [...existing.filter((entry) => !signed.some((item) => item.proof.profile === entry.proof?.profile && item.proof.region === entry.proof?.region)), ...signed];
  setEnv({ DEPLOYGUARD_FINAL_PROVIDER_PROOFS: JSON.stringify(proofs) });
  // Re-read the saved configuration and confirm the production registry accepts each proof.
  for (const profile of ["ec2", "lightsail", "static", "lambda"] as const) IMPLEMENTED_PROVIDER_CONTRACTS[profile] = { version: ADAPTER_VERSION, fingerprint };
  const registry = new HostingProfileRegistryService(new ConfigService(parse(readFileSync(envPath))));
  for (const { proof } of signed) assert(registry.available(proof.profile, proof.region), `${proof.profile}: the registry rejected the signed proof.`);
  console.log(`FINAL_PROVIDER_PROOFS=SIGNED ${signed.map(({ proof }) => proof.profile).join(",")} executable=${fingerprint.slice(0, 16)}`);
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
