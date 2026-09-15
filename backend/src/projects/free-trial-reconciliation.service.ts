import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { EntitlementService } from "../billing/entitlement.service";
import { getBillingConfig } from "../billing/billing.config";

/** Backfills the one persisted Free trial from authoritative LIVE state without changing infrastructure. */
@Injectable()
export class FreeTrialReconciliationService implements OnApplicationBootstrap {
  constructor(private readonly dataSource: DataSource, private readonly config: ConfigService, private readonly entitlements: EntitlementService) {}

  async onApplicationBootstrap() {
    if (!getBillingConfig(this.config).enabled) return;
    const rows = await this.dataSource.query(`
      SELECT DISTINCT project.owner_user_id AS "userId"
      FROM projects project
      INNER JOIN project_environment_routes route ON route.project_id = project.id AND route.live_generation_id IS NOT NULL
      INNER JOIN project_deployment_generations generation ON generation.id = route.live_generation_id AND generation.status = 'live'
      WHERE project.archived_at IS NULL AND project.status <> 'archived'
    `) as Array<{ userId: number | string }>;
    for (const row of rows) await this.entitlements.reconcileFreeTrial(Number(row.userId));
  }
}
