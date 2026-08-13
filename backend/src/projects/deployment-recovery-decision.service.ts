import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectStableRelease } from "../orchestration/project-stable-release.entity";
import { ProjectDatabaseTier } from "./project-database-tier.entity";
import {
  decideDeploymentRecovery,
  DeploymentRecoveryDecision,
} from "./deployment-recovery-decision";
import { ManagedDatabaseReconciliationReport } from "./managed-database-reconciliation.service";

@Injectable()
export class DeploymentRecoveryDecisionService {
  constructor(
    @InjectRepository(ProjectStableRelease) private readonly releases: Repository<ProjectStableRelease>,
    @InjectRepository(ProjectDatabaseTier) private readonly tiers: Repository<ProjectDatabaseTier>,
  ) {}

  async decide(
    projectId: string,
    report: ManagedDatabaseReconciliationReport,
    requestedMode: "DEPLOY" | "RETRY" | "RESET_FRESH" | "RESTORE",
  ): Promise<DeploymentRecoveryDecision> {
    const [latestPersistentRelease, tier] = await Promise.all([
      this.releases.createQueryBuilder("release")
        .where("release.projectId = :projectId", { projectId })
        .andWhere("release.generationId = :generationId", { generationId: report.identity.generationId })
        .andWhere("release.metadata ? 'managedDatabaseBinding'")
        .andWhere("release.metadata -> 'managedDatabaseBinding' != 'null'::jsonb")
        .orderBy("release.deployedAt", "DESC")
        .getOne(),
      this.tiers.findOne({ where: { projectId } }),
    ]);
    const resetAt = this.resetAt(tier?.restoreMetadata);
    const currentPersistentResourcePresent = Boolean(
      report.evidence.currentFileSystem?.available && report.evidence.currentFileSystem.owned,
    );
    const verifiedBindingIdentity = Boolean(
      report.evidence.bindingFileSystemId
      && ["ready", "applied", "verified"].includes(String(report.evidence.bindingStatus || "")),
    );
    const stateContainsPersistentStorage = report.evidence.terraformDatabaseAddresses.some((address) =>
      /aws_efs_(?:file_system|access_point)/.test(address),
    );
    const releaseEstablished = Boolean(latestPersistentRelease);
    const persistentPreviouslyEstablished = currentPersistentResourcePresent
      || verifiedBindingIdentity
      || stateContainsPersistentStorage
      || releaseEstablished;
    const lastEstablishedAt = latestPersistentRelease?.deployedAt?.getTime() || 0;
    const resetSupersedesPersistentGeneration = Boolean(
      resetAt && resetAt.getTime() > lastEstablishedAt && !currentPersistentResourcePresent,
    );
    return decideDeploymentRecovery({
      requestedMode,
      persistentPreviouslyEstablished,
      currentPersistentResourcePresent,
      recoveryEvidenceAvailable: Boolean(report.backup.recoverableRecoveryPointArn),
      resetSupersedesPersistentGeneration,
    });
  }

  private resetAt(metadata: Record<string, unknown> | null | undefined) {
    if (metadata?.kind !== "data_lost_reset" || typeof metadata.resetAt !== "string") return null;
    const value = new Date(metadata.resetAt);
    return Number.isFinite(value.getTime()) ? value : null;
  }
}
