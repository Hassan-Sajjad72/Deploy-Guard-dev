export type DeploymentMode = "FRESH" | "UPDATE" | "RETRY" | "RESTORE" | "RESET_FRESH";
export type PersistentDeploymentState = "NONE" | "PERSISTENT";
export type DeploymentRecoveryState = "NOT_REQUIRED" | "AVAILABLE" | "REQUIRED" | "BLOCKED";

export type DeploymentRecoveryDecision = {
  schemaVersion: 1;
  deploymentMode: DeploymentMode;
  persistentState: PersistentDeploymentState;
  recoveryState: DeploymentRecoveryState;
  recoveryRequired: boolean;
  recoveryEvidenceAvailable: boolean;
  persistentPreviouslyEstablished: boolean;
  deploymentAllowed: boolean;
  reason: string;
};

export type DeploymentRecoveryDecisionInput = {
  requestedMode: "DEPLOY" | "RETRY" | "RESET_FRESH" | "RESTORE";
  persistentPreviouslyEstablished: boolean;
  currentPersistentResourcePresent: boolean;
  recoveryEvidenceAvailable: boolean;
  resetSupersedesPersistentGeneration: boolean;
};

/**
 * The workflow accepts only an immutable context that the backend has already
 * resolved as deployable. AWS and Terraform may verify that context, but they
 * must not derive persistence from secrets, bindings, state fragments or
 * failed attempts independently.
 */
export function isDispatchableDeploymentRecoveryDecision(
  value: unknown,
): value is DeploymentRecoveryDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  const mode = String(context.deploymentMode || "");
  const persistentState = String(context.persistentState || "");
  const recoveryState = String(context.recoveryState || "");
  const previouslyEstablished = context.persistentPreviouslyEstablished;
  const common = context.schemaVersion === 1
    && ["FRESH", "UPDATE", "RETRY", "RESTORE", "RESET_FRESH"].includes(mode)
    && ["NONE", "PERSISTENT"].includes(persistentState)
    && ["NOT_REQUIRED", "AVAILABLE"].includes(recoveryState)
    && context.recoveryRequired === false
    && typeof context.recoveryEvidenceAvailable === "boolean"
    && typeof previouslyEstablished === "boolean"
    && context.deploymentAllowed === true
    && typeof context.reason === "string"
    && context.reason.length > 0
    && context.reason.length <= 512;
  if (!common) return false;

  if (persistentState === "PERSISTENT") {
    return previouslyEstablished === true
      && ["UPDATE", "RETRY", "RESTORE"].includes(mode);
  }

  if (mode === "RESET_FRESH") return true;
  return previouslyEstablished === false && ["FRESH", "RETRY"].includes(mode);
}

export function decideDeploymentRecovery(input: DeploymentRecoveryDecisionInput): DeploymentRecoveryDecision {
  if (input.resetSupersedesPersistentGeneration) {
    return result("RESET_FRESH", "NONE", "NOT_REQUIRED", false, input, true,
      "The previous deployment generation was explicitly reset. Recovery protection is not required for the new generation.");
  }

  if (!input.persistentPreviouslyEstablished) {
    return result(input.requestedMode === "RETRY" ? "RETRY" : "FRESH", "NONE", "NOT_REQUIRED", false, input, true,
      "No previous persistent deployment detected. Recovery protection is not required. Starting fresh infrastructure deployment.");
  }

  if (!input.currentPersistentResourcePresent) {
    if (input.recoveryEvidenceAvailable) {
      return result("RESTORE", "PERSISTENT", "AVAILABLE", true, input, false,
        "Persistent application data is missing, but a verified recovery source is available. Restore it before deploying.");
    }
    return result(input.requestedMode === "RETRY" ? "RETRY" : "UPDATE", "PERSISTENT", "BLOCKED", true, input, false,
      "A previous persistent deployment existed, but its data is unavailable and no verified recovery source exists. Explicitly start a fresh deployment generation to continue.");
  }

  return result(
    input.requestedMode === "RETRY" ? "RETRY" : input.requestedMode === "RESTORE" ? "RESTORE" : "UPDATE",
    "PERSISTENT",
    input.recoveryEvidenceAvailable ? "AVAILABLE" : "NOT_REQUIRED",
    false,
    input,
    true,
    "Existing persistent infrastructure is present. Terraform plan changes will determine whether recovery protection is required.",
  );
}

function result(
  deploymentMode: DeploymentMode,
  persistentState: PersistentDeploymentState,
  recoveryState: DeploymentRecoveryState,
  recoveryRequired: boolean,
  input: DeploymentRecoveryDecisionInput,
  deploymentAllowed: boolean,
  reason: string,
): DeploymentRecoveryDecision {
  return {
    schemaVersion: 1,
    deploymentMode,
    persistentState,
    recoveryState,
    recoveryRequired,
    recoveryEvidenceAvailable: input.recoveryEvidenceAvailable,
    persistentPreviouslyEstablished: input.persistentPreviouslyEstablished,
    deploymentAllowed,
    reason,
  };
}
