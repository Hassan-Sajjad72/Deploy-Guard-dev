import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { BillingSubscription } from "../billing/billing-subscription.entity";
import { getBillingConfig } from "../billing/billing.config";
import { User } from "../users/user.entity";
import { ProjectEnvironmentRoute } from "./project-environment-route.entity";
import { Project } from "./project.entity";
import { RailpackDeploymentService } from "./railpack-deployment.service";
import { DESTROY_CONFIRMATION_PHRASE } from "./destroy-confirmation";

/** Reuses the existing verified destroy lifecycle when the one Free LIVE trial expires. */
@Injectable()
export class FreeTrialRuntimeEnforcerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  constructor(private readonly dataSource: DataSource, private readonly config: ConfigService, private readonly deployments: RailpackDeploymentService) {}

  onApplicationBootstrap() {
    if (!getBillingConfig(this.config).enabled) return;
    this.timer = setInterval(() => void this.enforce(), 10 * 60 * 1000);
    this.timer.unref();
    setTimeout(() => void this.enforce(), 15_000).unref();
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async enforce(now = new Date()) {
    const billing = getBillingConfig(this.config);
    if (!billing.enabled || (billing.testPlan && billing.testPlan !== "free")) return;
    const expired = await this.dataSource.getRepository(BillingSubscription).createQueryBuilder("subscription")
      .where("subscription.plan = :plan", { plan: "free" })
      .andWhere("subscription.trialEndsAt IS NOT NULL AND subscription.trialEndsAt <= :now", { now })
      .getMany();
    for (const subscription of expired) {
      const routes = await this.dataSource.getRepository(ProjectEnvironmentRoute).createQueryBuilder("route")
        .innerJoin(Project, "project", "project.id = route.projectId AND project.ownerUserId = :userId", { userId: subscription.userId })
        .where("route.liveGenerationId IS NOT NULL").getMany();
      const owner = await this.dataSource.getRepository(User).findOne({ where: { id: subscription.userId } });
      if (!owner) continue;
      for (const route of routes) await this.deployments.destroy(owner, route.projectId, DESTROY_CONFIRMATION_PHRASE).catch(() => undefined);
    }
  }
}
