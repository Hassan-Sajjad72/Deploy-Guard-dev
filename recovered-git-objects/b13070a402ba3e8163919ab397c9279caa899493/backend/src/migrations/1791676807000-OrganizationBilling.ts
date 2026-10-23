import { MigrationInterface, QueryRunner } from "typeorm";

const tables = ["billing_accounts", "billing_subscriptions", "billing_usage_counters", "billing_usage_events", "billing_checkout_sessions", "billing_invoices", "billing_payments"];

export class OrganizationBilling1791676807000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    for (const name of tables) {
      await runner.query(`ALTER TABLE ${name} ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT`);
      await runner.query(`UPDATE ${name} billing SET organization_id = organization.id FROM organizations organization WHERE organization.personal_owner_user_id = billing.user_id`);
      const [{ unmapped }] = await runner.query(`SELECT EXISTS(SELECT 1 FROM ${name} WHERE organization_id IS NULL) AS unmapped`);
      if (unmapped) throw new Error(`Unmapped legacy billing ownership in ${name}; reconcile before migrating.`);
      await runner.query(`CREATE INDEX IDX_${name}_organization ON ${name}(organization_id)`);
    }
    for (const name of ["billing_accounts", "billing_subscriptions", "billing_usage_counters"]) {
      const table = (await runner.getTable(name))!;
      const columns = name === "billing_usage_counters" ? ["user_id", "metric", "period_start"] : ["user_id"];
      for (const unique of table.uniques.filter((item) => item.columnNames.length === columns.length && columns.every((column) => item.columnNames.includes(column)))) await runner.dropUniqueConstraint(name, unique);
      for (const index of table.indices.filter((item) => item.isUnique && item.columnNames.length === columns.length && columns.every((column) => item.columnNames.includes(column)))) await runner.dropIndex(name, index);
      const suffix = name === "billing_usage_counters" ? ", metric, period_start" : "";
      await runner.query(`CREATE UNIQUE INDEX UQ_${name}_legacy_scope ON ${name}(user_id${suffix}) WHERE organization_id IS NULL`);
      await runner.query(`CREATE UNIQUE INDEX UQ_${name}_organization_scope ON ${name}(organization_id${suffix}) WHERE organization_id IS NOT NULL`);
    }
    await runner.query(`ALTER TABLE billing_invoices ADD COLUMN due_at timestamptz, ADD COLUMN reconciliation_reason varchar(1000)`);
  }
  async down(runner: QueryRunner) {
    for (const name of tables) {
      const [{ unsafe }] = await runner.query(`SELECT EXISTS(SELECT 1 FROM ${name} billing JOIN organizations organization ON organization.id = billing.organization_id WHERE organization.personal_owner_user_id IS DISTINCT FROM billing.user_id) AS unsafe`);
      if (unsafe) throw new Error("Organization billing records require explicit reconciliation before ownership rollback.");
    }
    for (const name of ["billing_accounts", "billing_subscriptions", "billing_usage_counters"]) {
      await runner.query(`DROP INDEX UQ_${name}_legacy_scope, UQ_${name}_organization_scope`);
      await runner.query(`ALTER TABLE ${name} ADD UNIQUE(user_id${name === "billing_usage_counters" ? ", metric, period_start" : ""})`);
    }
    await runner.query(`ALTER TABLE billing_invoices DROP COLUMN due_at, DROP COLUMN reconciliation_reason`);
    for (const name of tables) await runner.query(`ALTER TABLE ${name} DROP COLUMN organization_id`);
  }
}
