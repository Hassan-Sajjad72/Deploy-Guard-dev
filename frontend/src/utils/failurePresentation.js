/**
 * Plain-language wording for the backend's deterministic failure diagnosis.
 * One name per concept, shared by Overview, Deployments and Troubleshoot.
 */
export function failureOwnerLabel(owner, externalProvider) {
  if (owner === "REPOSITORY_APPLICATION") return "The problem is in your repository or app configuration.";
  if (owner === "DEPLOYGUARD_PLATFORM") return "The problem is on DeployGuard's side, not in your code.";
  if (owner === "EXTERNAL_PROVIDER") return `The problem is with an external provider${externalProvider ? ` (${providerName(externalProvider)})` : ""}, not in your code.`;
  if (owner === "UNVERIFIED") return "The cause has not been verified yet.";
  return null;
}

export function failureOwnerShort(owner, externalProvider) {
  if (owner === "REPOSITORY_APPLICATION") return "Your repository";
  if (owner === "DEPLOYGUARD_PLATFORM") return "DeployGuard platform";
  if (owner === "EXTERNAL_PROVIDER") return externalProvider ? providerName(externalProvider) : "External provider";
  return "Not verified";
}

function providerName(provider) {
  const names = { aws: "AWS", github: "GitHub", github_actions: "GitHub Actions", stripe: "Stripe" };
  return names[String(provider).toLowerCase()] || String(provider).replaceAll("_", " ");
}

export function retryGuidance(decision) {
  if (decision === "SAFE_NOW") return { tone: "success", short: "Safe to retry", text: "Retrying is supported by the recorded evidence." };
  if (decision === "SAFE_AFTER_FIX") return { tone: "warning", short: "Fix, then deploy a new commit", text: "Retrying the same commit will fail the same way. Fix the problem, push a commit, then deploy it." };
  if (decision === "NOT_SAFE_YET") return { tone: "warning", short: "Resolve before retrying", text: "Resolve the reported condition before retrying." };
  return { tone: "neutral", short: "Not enough evidence", text: "The recorded evidence is not enough to say whether a retry will succeed." };
}

export function confidenceLabel(confidence) {
  if (confidence === "DETERMINISTIC") return "Confirmed by recorded evidence";
  if (confidence === "HIGH") return "High confidence";
  return "Not verified";
}

export function operationTypeLabel(operation) {
  const action = operation?.deploymentAction || operation?.operationType || operation?.action;
  if (action === "destroy") return "Destroy";
  if (action === "rollback") return "Rollback";
  return "Deploy";
}

export function operationResult(operation) {
  if (operation?.deploymentAction === "destroy" && operation?.destroyVerificationStatus === "pending") return { label: "Verifying deletion", tone: "warning" };
  const value = String(operation?.status || "").toLowerCase();
  if (value === "completed") return operation?.deploymentAction === "destroy" ? { label: "Destroyed", tone: "neutral" } : { label: "Succeeded", tone: "success" };
  if (value === "failed") return { label: "Failed", tone: "danger" };
  if (value === "dispatch_failed") return { label: "Did not start", tone: "danger" };
  if (value === "running") return { label: { destroy: "Destroying", rollback: "Rolling back" }[operation?.deploymentAction] || "Deploying", tone: "info" };
  if (value === "queued") return { label: "Queued", tone: "info" };
  if (value === "cancelled") return { label: "Cancelled", tone: "neutral" };
  return { label: value ? value.replaceAll("_", " ") : "Unknown", tone: "neutral" };
}
