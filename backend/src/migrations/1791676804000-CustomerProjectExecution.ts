import { MigrationInterface, QueryRunner } from "typeorm";

export class CustomerProjectExecution1791676804000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`ALTER TABLE projects ADD COLUMN execution_mode varchar NOT NULL DEFAULT 'legacy_control_plane' CHECK(execution_mode IN ('legacy_control_plane','customer'))`);
    await runner.query(`ALTER TABLE projects ALTER COLUMN execution_mode SET DEFAULT 'customer'`);
    await runner.query(`ALTER TABLE projects ADD COLUMN aws_account_binding_id uuid`);
    await runner.query(`ALTER TABLE aws_account_bindings ADD CONSTRAINT "UQ_binding_workspace" UNIQUE(id, organization_id)`);
    await runner.query(`ALTER TABLE projects ADD CONSTRAINT "FK_project_binding_workspace" FOREIGN KEY(aws_account_binding_id, organization_id) REFERENCES aws_account_bindings(id, organization_id) ON DELETE RESTRICT`);
    await runner.query(`ALTER TABLE projects ADD CONSTRAINT "CHK_project_binding_workspace" CHECK(aws_account_binding_id IS NULL OR organization_id IS NOT NULL)`);
  }
  async down(runner: QueryRunner) {
    const [{ unsafe }] = await runner.query(`SELECT EXISTS(SELECT 1 FROM projects WHERE execution_mode = 'customer' OR aws_account_binding_id IS NOT NULL) AS unsafe`);
    if (unsafe) throw new Error("Customer projects must be reconciled explicitly before removing account execution boundaries.");
    await runner.query(`ALTER TABLE projects DROP CONSTRAINT "FK_project_binding_workspace", DROP CONSTRAINT "CHK_project_binding_workspace", DROP COLUMN aws_account_binding_id, DROP COLUMN execution_mode`);
    await runner.query(`ALTER TABLE aws_account_bindings DROP CONSTRAINT "UQ_binding_workspace"`);
  }
}
