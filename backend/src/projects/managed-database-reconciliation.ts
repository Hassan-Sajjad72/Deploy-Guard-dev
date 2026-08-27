export enum ManagedDatabaseReconciliationState {
  HEALTHY = "HEALTHY",
  RECOVERABLE = "RECOVERABLE",
  DATA_LOST_RESET_REQUIRED = "DATA_LOST_RESET_REQUIRED",
  STALE_METADATA = "STALE_METADATA",
  IDENTITY_MIGRATION_REQUIRED = "IDENTITY_MIGRATION_REQUIRED",
}

export type ManagedDatabaseResourceEvidence = {
  id: string;
  identity: "current";
  owned: boolean;
  available: boolean;
};

export type ManagedDatabaseReconciliationEvidence = {
  managed: boolean;
  persistenceEnabled: boolean;
  expectedStorageIdentity: boolean;
  bindingStatus: string | null;
  bindingFileSystemId: string | null;
  bindingAccessPointId: string | null;
  currentFileSystem: ManagedDatabaseResourceEvidence | null;
  accessPoint: ManagedDatabaseResourceEvidence | null;
  passwordSecretPresent: boolean;
  urlSecretPresent: boolean;
  terraformDatabaseAddresses: string[];
  usableRecoveryPointArn: string | null;
};

export type ManagedDatabaseReconciliation = {
  state: ManagedDatabaseReconciliationState;
  deploymentAllowed: boolean;
  resetAllowed: boolean;
  recoveryAvailable: boolean;
  title: string;
  message: string;
};

const result = (
  state: ManagedDatabaseReconciliationState,
  title: string,
  message: string,
): ManagedDatabaseReconciliation => ({
  state,
  title,
  message,
  deploymentAllowed: state === ManagedDatabaseReconciliationState.HEALTHY,
  resetAllowed: [
    ManagedDatabaseReconciliationState.DATA_LOST_RESET_REQUIRED,
    ManagedDatabaseReconciliationState.STALE_METADATA,
  ].includes(state),
  recoveryAvailable: state === ManagedDatabaseReconciliationState.RECOVERABLE,
});

export function classifyManagedDatabase(
  evidence: ManagedDatabaseReconciliationEvidence,
): ManagedDatabaseReconciliation {
  const secretsPresent = evidence.passwordSecretPresent || evidence.urlSecretPresent;
  const statePresent = evidence.terraformDatabaseAddresses.length > 0;
  const anyMetadata = evidence.expectedStorageIdentity || Boolean(evidence.bindingStatus) || secretsPresent || statePresent;

  if (!evidence.managed || !evidence.persistenceEnabled) {
    return anyMetadata
      ? result(
          ManagedDatabaseReconciliationState.STALE_METADATA,
          "Stale managed database state",
          "Managed database persistence is disabled, but database metadata or cloud references remain.",
        )
      : result(ManagedDatabaseReconciliationState.HEALTHY, "Database state healthy", "Managed database persistence is disabled.");
  }

  const filesystem = evidence.currentFileSystem;
  if (filesystem?.available && filesystem.owned) {
    const accessPointMatches = Boolean(
      evidence.accessPoint?.available
      && evidence.accessPoint.owned
      && (!evidence.bindingAccessPointId || evidence.bindingAccessPointId === evidence.accessPoint.id),
    );
    const filesystemMatches = !evidence.bindingFileSystemId || evidence.bindingFileSystemId === filesystem.id;
    if (filesystemMatches && accessPointMatches && evidence.passwordSecretPresent && evidence.urlSecretPresent) {
      return result(ManagedDatabaseReconciliationState.HEALTHY, "Database state healthy", "Persistent storage, access point, credentials, and ownership identity match.");
    }
    return result(
      ManagedDatabaseReconciliationState.IDENTITY_MIGRATION_REQUIRED,
      "Managed database identity migration required",
      "Persistent storage exists, but its access point, binding, credentials, or Terraform identity does not match.",
    );
  }

  if (evidence.expectedStorageIdentity) {
    if (evidence.usableRecoveryPointArn) {
      return result(
        ManagedDatabaseReconciliationState.RECOVERABLE,
        "Managed database recovery required",
        "Persistent database storage is missing, but a verified usable recovery point is available.",
      );
    }
    return result(
      ManagedDatabaseReconciliationState.DATA_LOST_RESET_REQUIRED,
      "Managed database recovery required",
      "Managed database data is unavailable and no backup exists. Reset the managed database before deploying a fresh instance.",
    );
  }

  if (secretsPresent || statePresent || evidence.bindingStatus) {
    return result(
      ManagedDatabaseReconciliationState.STALE_METADATA,
      "Stale managed database state",
      "No persistent database was verified, but stale database credentials, binding metadata, or Terraform state remains.",
    );
  }

  return result(ManagedDatabaseReconciliationState.HEALTHY, "Database ready for initial provisioning", "No previous persistent database identity exists.");
}
