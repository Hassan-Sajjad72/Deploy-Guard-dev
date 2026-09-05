import type { ManagedDatabaseReconciliationState } from "./managed-database-reconciliation";
import type { ManagedDatabaseReconciliationReport } from "./managed-database-reconciliation.service";

export const MANAGED_DATABASE_RECONCILIATION_FAILURE = "DG_MANAGED_DATABASE_RECONCILIATION_FAILED";

/**
 * The managed-database reconciler already has a deterministic admission
 * result. Keep it typed until the single terminal-failure intake persists it;
 * an HTTP exception message is not an authority boundary.
 */
export class ManagedDatabaseReconciliationAdmissionError extends Error {
  readonly code = MANAGED_DATABASE_RECONCILIATION_FAILURE;
  readonly stage = "managed_database_reconciliation";

  constructor(readonly report: ManagedDatabaseReconciliationReport) {
    super(report.message);
    this.name = "ManagedDatabaseReconciliationAdmissionError";
  }

  safeEvidence() {
    const evidence = this.report.evidence;
    return {
      reconciliationState: this.report.state as ManagedDatabaseReconciliationState,
      deploymentAllowed: this.report.deploymentAllowed,
      resetAllowed: this.report.resetAllowed,
      recoveryAvailable: this.report.recoveryAvailable,
      engine: this.report.engine,
      attachedServiceId: this.report.attachedServiceId,
      environment: this.report.identity.environment,
      persistentPreviouslyEstablished: Boolean(
        evidence.expectedStorageIdentity
        || evidence.currentFileSystem?.owned
        || evidence.terraformDatabaseAddresses.length,
      ),
      currentPersistentStoragePresent: Boolean(evidence.currentFileSystem?.available && evidence.currentFileSystem.owned),
      verifiedRecoveryEvidence: Boolean(evidence.usableRecoveryPointArn),
      evidence: {
        managed: evidence.managed,
        persistenceEnabled: evidence.persistenceEnabled,
        expectedStorageIdentity: evidence.expectedStorageIdentity,
        bindingStatus: evidence.bindingStatus,
        currentFileSystemPresent: Boolean(evidence.currentFileSystem?.available && evidence.currentFileSystem.owned),
        accessPointPresent: Boolean(evidence.accessPoint?.available && evidence.accessPoint.owned),
        passwordSecretPresent: evidence.passwordSecretPresent,
        urlSecretPresent: evidence.urlSecretPresent,
        terraformDatabaseAddressCount: evidence.terraformDatabaseAddresses.length,
        verifiedRecoveryEvidence: Boolean(evidence.usableRecoveryPointArn),
      },
    };
  }
}

export type ManagedDatabaseReconciliationFailureEvidence = ReturnType<ManagedDatabaseReconciliationAdmissionError["safeEvidence"]>;
