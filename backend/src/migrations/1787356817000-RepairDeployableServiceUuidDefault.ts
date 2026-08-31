import { MigrationInterface, QueryRunner } from "typeorm";

/** Aligns the migrated service table with @PrimaryGeneratedColumn("uuid"). */
export class RepairDeployableServiceUuidDefault1787356817000 implements MigrationInterface {
  name = "RepairDeployableServiceUuidDefault1787356817000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_deployable_services" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4()`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_deployable_services" ALTER COLUMN "id" DROP DEFAULT`);
  }
}
