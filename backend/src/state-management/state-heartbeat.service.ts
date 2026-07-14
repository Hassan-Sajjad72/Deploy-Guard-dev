import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectTerraformLock, TerraformLockStatus } from "./project-terraform-lock.entity";

@Injectable()
export class StateHeartbeatService implements OnModuleDestroy {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    @InjectRepository(ProjectTerraformLock)
    private readonly lockRepository: Repository<ProjectTerraformLock>
  ) {}

  async startHeartbeat(lockId: string, pipelineRunId: string) {
    await this.updateHeartbeat(lockId, pipelineRunId);
    const lock = await this.lockRepository.findOne({ where: { lockId } });
    const intervalSeconds = lock?.heartbeatIntervalSeconds || 30;
    const timer = setInterval(() => {
      this.updateHeartbeat(lockId, pipelineRunId).catch(() => undefined);
    }, intervalSeconds * 1000);

    this.timers.set(lockId, timer);
  }

  async updateHeartbeat(lockId: string, pipelineRunId: string) {
    const lock = await this.lockRepository.findOne({ where: { lockId } });

    if (!lock || lock.pipelineRunId !== pipelineRunId) {
      return null;
    }

    lock.status = TerraformLockStatus.HEARTBEAT_ACTIVE;
    lock.heartbeatAt = new Date();
    return this.lockRepository.save(lock);
  }

  async stopHeartbeat(lockId: string, pipelineRunId: string) {
    const timer = this.timers.get(lockId);

    if (timer) {
      clearInterval(timer);
      this.timers.delete(lockId);
    }

    return this.updateHeartbeat(lockId, pipelineRunId);
  }

  async onModuleDestroy() {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}
