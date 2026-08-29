import { MigrationInterface, QueryRunner } from "typeorm";
import { CreateProjectCostTables1760000002000 } from "./1760000002000-CreateProjectCostTables";
import { CreateProjectInfrastructureTables1760000003000 } from "./1760000003000-CreateProjectInfrastructureTables";
import { CreateProjectTerraformStateTables1760000004000 } from "./1760000004000-CreateProjectTerraformStateTables";
import { CreateProjectStorageTables1760000005000 } from "./1760000005000-CreateProjectStorageTables";
import { CreateProjectOrchestrationTables1760000006000 } from "./1760000006000-CreateProjectOrchestrationTables";
import { CreateProjectObservabilityTables1760000007000 } from "./1760000007000-CreateProjectObservabilityTables";

/**
 * Repairs installations where history records the active read-model migrations
 * although their table families are physically absent. Each historical `up`
 * implementation is called only when its anchor table is absent; those
 * migrations use CREATE/ADD IF NOT EXISTS and do not alter existing data.
 */
export class RepairActiveProductReadModelSchemaDrift1787356809000 implements MigrationInterface {
  name = "RepairActiveProductReadModelSchemaDrift1787356809000";

  async up(queryRunner: QueryRunner): Promise<void> {
    const missing = async (table: string) => {
      const rows = await queryRunner.query(`SELECT to_regclass($1) AS table_name`, [`public.${table}`]);
      return rows[0]?.table_name === null;
    };
    if (await missing("project_cost_estimates")) await new CreateProjectCostTables1760000002000().up(queryRunner);
    if (await missing("project_infrastructure_environments")) await new CreateProjectInfrastructureTables1760000003000().up(queryRunner);
    if (await missing("project_terraform_states")) await new CreateProjectTerraformStateTables1760000004000().up(queryRunner);
    if (await missing("project_persistent_storage")) await new CreateProjectStorageTables1760000005000().up(queryRunner);
    if (await missing("project_deployments")) await new CreateProjectOrchestrationTables1760000006000().up(queryRunner);
    if (await missing("project_stage_metrics")) await new CreateProjectObservabilityTables1760000007000().up(queryRunner);
  }

  async down(): Promise<void> {
    // The repair must never drop recovered control-plane records.
  }
}
