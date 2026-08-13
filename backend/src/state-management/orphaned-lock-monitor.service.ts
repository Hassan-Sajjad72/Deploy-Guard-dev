import { Injectable } from "@nestjs/common";
import { StateLockService } from "./state-lock.service";

@Injectable()
export class OrphanedLockMonitorService {
  constructor(private readonly lockService: StateLockService) {}

  async scanActiveLocks() {
    return this.lockService.activeLocks();
  }

  async detectStaleHeartbeat() {
    const activeLocks = await this.scanActiveLocks();
    return activeLocks.filter((lock) => this.lockService.isStale(lock));
  }

  async verifyNoActiveTerraformProcess() {
    return true;
  }

  async markDeploymentFailedForOrphanedLock() {
    return true;
  }

  async releaseOrphanedLock(lockId: string) {
    await this.lockService.markLockOrphaned(lockId);
    return this.lockService.forceReleaseOrphanedLock(lockId);
  }

  async processNextQueuedDeployment(projectId: string) {
    return this.lockService.processNextQueuedDeployment(projectId);
  }
}
