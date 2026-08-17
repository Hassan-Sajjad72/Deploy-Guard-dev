import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  NormalReleaseLaneConvergenceService,
} from "../release-lane/normal-release-lane-convergence.service";
import { normalV1IsShared } from "../release-lane/normal-v1-activation-policy";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NormalReleaseLaneAutoConvergenceStatus = Readonly<{
  state: "disabled" | "idle" | "reconciling" | "terminal" | "stopped";
  safeCode: string;
}>;

/**
 * The normal consumer's bounded recovery intake. It owns no queue, lease, or
 * worker; it asks the existing exact convergence boundary to retry the same
 * failed deterministic job only after that boundary has re-proven every fact.
 */
@Injectable()
export class NormalReleaseLaneAutoConvergenceScheduler {
  private projectId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private status: NormalReleaseLaneAutoConvergenceStatus = {
    state: "stopped",
    safeCode: "NORMAL_RELEASE_AUTO_CONVERGENCE_STOPPED",
  };

  constructor(
    private readonly config: ConfigService,
    private readonly convergence: NormalReleaseLaneConvergenceService,
  ) {}

  start(projectId: string | null) {
    if (this.timer || this.ticking) return this.getStatus();
    const policy = this.policy(projectId);
    if (!policy) {
      this.status = {
        state: "disabled",
        safeCode: "NORMAL_RELEASE_AUTO_CONVERGENCE_DISABLED",
      };
      return this.getStatus();
    }
    this.projectId = projectId;
    this.status = {
      state: "idle",
      safeCode: "NORMAL_RELEASE_AUTO_CONVERGENCE_IDLE",
    };
    this.timer = setInterval(() => void this.tick(), policy.intervalMs);
    this.timer.unref();
    void this.tick();
    return this.getStatus();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
    this.projectId = null;
    this.status = {
      state: "stopped",
      safeCode: "NORMAL_RELEASE_AUTO_CONVERGENCE_STOPPED",
    };
    return this.getStatus();
  }

  getStatus() {
    return this.status;
  }

  private async tick() {
    if (this.ticking) return;
    const projectId = this.projectId;
    const policy = this.policy(projectId);
    if (!policy) return;
    this.ticking = this.run(projectId, policy)
      .catch(() => {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.status = {
          state: "terminal",
          safeCode: "NORMAL_RELEASE_AUTO_CONVERGENCE_FAILED",
        };
      })
      .finally(() => {
        this.ticking = null;
      });
    await this.ticking;
  }

  private async run(
    projectId: string | null,
    policy: { intervalMs: number; maxAttempts: number; maxElapsedMs: number },
  ) {
    const candidate = projectId
      ? {
          projectId,
          intentId: await this.convergence.findAutomaticCandidate(projectId),
        }
      : await this.convergence.findAutomaticCandidateAcrossProjects();
    if (!candidate?.intentId) {
      if (this.status.state !== "terminal") {
        this.status = {
          state: "idle",
          safeCode: "NORMAL_RELEASE_AUTO_CONVERGENCE_IDLE",
        };
      }
      return;
    }
    this.status = {
      state: "reconciling",
      safeCode: "NORMAL_RELEASE_CONVERGENCE_RECONCILING",
    };
    const result = await this.convergence.reconcileExact(
      candidate.projectId,
      candidate.intentId,
      {
        maxAttempts: policy.maxAttempts,
        maxElapsedMs: policy.maxElapsedMs,
      },
    );
    if (result.state === "resumed") {
      this.status = {
        state: "idle",
        safeCode: "NORMAL_RELEASE_CONVERGENCE_RESUMED",
      };
      return;
    }
    if (result.state === "exhausted") {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.status = { state: "terminal", safeCode: result.safeCodes[0] };
      return;
    }
    if (result.safeCodes[0] === "NORMAL_RELEASE_CONVERGENCE_NOT_PROVEN") {
      this.status = {
        state: "reconciling",
        safeCode: "NORMAL_RELEASE_CONVERGENCE_RECONCILING",
      };
      return;
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status = { state: "terminal", safeCode: result.safeCodes[0] };
  }

  private policy(projectId: string | null) {
    if (
      this.config.get<unknown>(
        "TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_ENABLED",
      ) !== "true"
      || this.config.get<unknown>(
        "TWO_LANE_NORMAL_RELEASE_OUTCOME_RECONCILE_APPROVED",
      ) !== "true"
      || (!projectId && !normalV1IsShared(this.config))
      || (projectId !== null && !UUID.test(projectId))
      || (projectId !== null
        && this.config.get<unknown>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST")
          !== projectId)
      || this.config.get<unknown>("TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST")
        !== "dev"
    ) return null;
    const intervalMs = this.integer(
      "TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_INTERVAL_MS",
      5_000,
      1_000,
      60_000,
    );
    const maxAttempts = this.integer(
      "TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_MAX_ATTEMPTS",
      2,
      2,
      5,
    );
    const maxElapsedMs = this.integer(
      "TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_MAX_ELAPSED_MS",
      600_000,
      60_000,
      1_800_000,
    );
    return intervalMs && maxAttempts && maxElapsedMs
      ? { intervalMs, maxAttempts, maxElapsedMs }
      : null;
  }

  private integer(key: string, fallback: number, minimum: number, maximum: number) {
    const raw = this.config.get<unknown>(key);
    const value = raw === undefined ? fallback : Number(raw);
    return Number.isInteger(value) && value >= minimum && value <= maximum
      ? value
      : null;
  }
}
