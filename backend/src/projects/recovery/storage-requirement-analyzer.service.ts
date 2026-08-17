import { Injectable } from "@nestjs/common";
import { ProjectPersistentStorage } from "../../storage/project-persistent-storage.entity";
import { ProjectDeploymentContract } from "../project-deployment-contract.entity";

export type StorageRecoverySignal = { code: string; message: string };

@Injectable()
export class StorageRequirementAnalyzer {
  analyze(contract: ProjectDeploymentContract | null, storage: ProjectPersistentStorage | null, evidence: string): StorageRecoverySignal | null {
    if (/persistent data[^\n]*(?:delete|deletion)[^\n]*confirm|confirm[^\n]*(?:delete|deletion)[^\n]*persistent data/i.test(evidence)) {
      return { code: "persistent_data_delete_confirmation_required", message: this.line(evidence, /persistent data|confirm/i) };
    }
    if (contract?.persistentStorageRequired && (!storage || !storage.enabled)) {
      return { code: "file_storage_required_but_not_configured", message: "Persistent application file storage is required." };
    }
    if (storage?.status === "failed" || /EFS|mount[^\n]*failed|permission denied[^\n]*mount|access point|wrong upload path/i.test(evidence)) {
      const problem = storage?.errorMessage || evidence;
      const code = /permission denied/i.test(problem)
        ? "efs_permission_denied"
        : /kms|access point/i.test(problem)
          ? "efs_kms_or_access_point_error"
          : /upload path/i.test(problem)
            ? "wrong_upload_path"
            : "efs_mount_failed";
      return { code, message: storage?.errorMessage || this.line(evidence, /EFS|mount|access point|upload path/i) };
    }
    return null;
  }

  private line(value: string, pattern: RegExp) {
    return value.split(/\r?\n/).find((line) => pattern.test(line))?.trim().slice(0, 320) || "A persistent storage requirement needs attention.";
  }
}
