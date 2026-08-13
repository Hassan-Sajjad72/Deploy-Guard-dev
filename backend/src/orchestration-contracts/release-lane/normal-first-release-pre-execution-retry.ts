import { canonicalSha256 } from "../contracts/canonical-json";
import { DeploymentIntent } from "../entities/deployment-intent.entity";
import { DeploymentSideEffect } from "../entities/deployment-side-effect.entity";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { InitialReleaseDraft } from "../entities/initial-release-draft.entity";
import { OrchestrationOutbox } from "../entities/orchestration-outbox.entity";

export const FIRST_RELEASE_PRE_EXECUTION_RETRY_READY =
  "FIRST_RELEASE_PRE_EXECUTION_RETRY_READY";

/**
 * The one infrastructure-planning failure that is conclusively before
 * Terraform initialization or provider execution.  This preserves every
 * historical row while allowing a new immutable retry intent after the exact
 * project-scoped remote-plan gate is corrected.
 */
export function isFirstReleasePreExecutionRetryEligible(input: {
  intent: DeploymentIntent;
  manifest: InfrastructureManifest | null;
  draft: InitialReleaseDraft | null;
  outbox: OrchestrationOutbox | null;
  sideEffects: readonly DeploymentSideEffect[];
}): boolean {
  const { intent, manifest, draft, outbox, sideEffects } = input;
  if (
    intent.kind !== "deploy"
    || intent.classification !== "infrastructure_change"
    || intent.status !== "failed"
    || intent.failureCode !== "REMOTE_CANARY_PLAN_NOT_ALLOWED"
    || intent.releaseManifestId !== null
    || !intent.infrastructureManifestId
    || !manifest
    || manifest.id !== intent.infrastructureManifestId
    || manifest.projectId !== intent.projectId
    || manifest.environmentName !== intent.environmentName
    || manifest.status !== "failed"
    || manifest.failureCode !== "REMOTE_CANARY_PLAN_NOT_ALLOWED"
    || manifest.planArtifactReference !== null
    || manifest.planArtifactSha256 !== null
    || manifest.planInputFingerprint !== null
    || manifest.stateVersionId !== null
    || manifest.terraformOutputs !== null
    || manifest.terraformOutputsHash !== null
    || manifest.resourceCount !== null
    || manifest.plannedAt !== null
    || manifest.applyStartedAt !== null
    || manifest.appliedAt !== null
    || !draft
    || draft.intentId !== intent.id
    || draft.projectId !== intent.projectId
    || draft.environmentName !== intent.environmentName
    || draft.infrastructureManifestId !== manifest.id
    || String(draft.infrastructureRevision) !== String(manifest.revision)
    || draft.draftHash !== canonicalSha256(draft.releaseDraft)
    || !outbox
    || outbox.intentId !== intent.id
    || outbox.eventType !== "intent.infrastructure.plan"
    || outbox.status !== "published"
    || outbox.attemptCount !== 1
    || !outbox.publishedAt
    || !outbox.publishedJobId
    || outbox.claimedBy !== null
    || outbox.claimExpiresAt !== null
    || sideEffects.length !== 1
  ) return false;

  const effect = sideEffects[0];
  return effect.intentId === intent.id
    && effect.projectId === intent.projectId
    && effect.environmentName === intent.environmentName
    && effect.effectType === "infrastructure_terraform_plan"
    && effect.status === "failed"
    && effect.failureCode === "REMOTE_CANARY_PLAN_NOT_ALLOWED"
    && effect.reconciliationRequired === false
    && effect.safeResultCode === null
    && effect.resultFingerprint === null
    && effect.externalReferenceHash === null;
}
