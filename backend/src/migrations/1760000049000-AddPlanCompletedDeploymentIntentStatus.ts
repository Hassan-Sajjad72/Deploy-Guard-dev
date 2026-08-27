import { MigrationInterface, QueryRunner } from "typeorm";

const PRIOR_STATUSES =
  "'received','planned','enqueued','running','completed','failed','cancelled','no_op','rejected'";
const EXPANDED_STATUSES =
  "'received','planned','enqueued','running','plan_completed','completed','failed','cancelled','no_op','rejected'";

/**
 * Additive domain expansion only. No row is rewritten and no runtime path is
 * introduced that can select the new status.
 */
export class AddPlanCompletedDeploymentIntentStatus1760000049000
implements MigrationInterface {
  name = "AddPlanCompletedDeploymentIntentStatus1760000049000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "deployment_intents"
       DROP CONSTRAINT IF EXISTS "CHK_deployment_intent_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "deployment_intents"
       ADD CONSTRAINT "CHK_deployment_intent_status"
       CHECK ("status" IN (${EXPANDED_STATUSES}))`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $migration$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM "deployment_intents"
           WHERE "status" = 'plan_completed'
         ) THEN
           RAISE EXCEPTION
             'Refusing to remove plan_completed while deployment intent history uses it';
         END IF;
       END
       $migration$`,
    );
    await queryRunner.query(
      `ALTER TABLE "deployment_intents"
       DROP CONSTRAINT IF EXISTS "CHK_deployment_intent_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "deployment_intents"
       ADD CONSTRAINT "CHK_deployment_intent_status"
       CHECK ("status" IN (${PRIOR_STATUSES}))`,
    );
  }
}
