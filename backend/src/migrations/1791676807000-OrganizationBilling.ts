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
    await runner.query(`ALTER TABLE billing_invoices ADD COLUMN due_at timestamptz, ADD COLUMN reconciliation_reason varchar(1000), ADD COLUMN adjustment_of_invoice_id uuid REFERENCES billing_invoices(id) ON DELETE RESTRICT`);
    await runner.query(`CREATE FUNCTION retain_billing_usage_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Billing usage events are immutable'; END $$`);
    await runner.query(`CREATE TRIGGER retain_billing_usage BEFORE UPDATE OR DELETE ON billing_usage_events FOR EACH ROW EXECUTE FUNCTION retain_billing_usage_evidence()`);
    await runner.query(`CREATE FUNCTION retain_billing_receipt_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Billing receipts are immutable'; END $$`);
    await runner.query(`CREATE TRIGGER retain_billing_receipts BEFORE UPDATE OR DELETE ON billing_payments FOR EACH ROW EXECUTE FUNCTION retain_billing_receipt_evidence()`);
    await runner.query(`CREATE FUNCTION retain_b2b_invoice_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Billing invoice evidence is retained'; END IF;
      IF OLD.provider = 'b2b' AND (TG_OP = 'DELETE' OR ROW(OLD.id, OLD.organization_id, OLD.user_id, OLD.provider_invoice_id, OLD.invoice_number, OLD.provider, OLD.mode, OLD.plan, OLD.amount_due, OLD.currency, OLD.due_at, OLD.billing_period_start, OLD.billing_period_end, OLD.adjustment_of_invoice_id) IS DISTINCT FROM ROW(NEW.id, NEW.organization_id, NEW.user_id, NEW.provider_invoice_id, NEW.invoice_number, NEW.provider, NEW.mode, NEW.plan, NEW.amount_due, NEW.currency, NEW.due_at, NEW.billing_period_start, NEW.billing_period_end, NEW.adjustment_of_invoice_id)) THEN RAISE EXCEPTION 'B2B invoice financial identity is immutable'; END IF;
      IF OLD.provider = 'b2b' AND OLD.provider_transaction_id IS NOT NULL AND ROW(OLD.provider_transaction_id, OLD.paid_at) IS DISTINCT FROM ROW(NEW.provider_transaction_id, NEW.paid_at) THEN RAISE EXCEPTION 'Billing invoice receipt is immutable'; END IF;
      RETURN NEW;
    END $$`);
    await runner.query(`CREATE TRIGGER retain_b2b_invoices BEFORE UPDATE OR DELETE ON billing_invoices FOR EACH ROW EXECUTE FUNCTION retain_b2b_invoice_identity()`);
  }
  async down(runner: QueryRunner) {
    const [{ invoiced }] = await runner.query(`SELECT EXISTS(SELECT 1 FROM billing_invoices WHERE due_at IS NOT NULL OR reconciliation_reason IS NOT NULL) AS invoiced`);
    if (invoiced) throw new Error("Externally reconciled invoice evidence cannot be removed by ownership rollback.");
    for (const name of tables) {
      const [{ unsafe }] = await runner.query(`SELECT EXISTS(SELECT 1 FROM ${name} billing JOIN organizations organization ON organization.id = billing.organization_id WHERE organization.personal_owner_user_id IS DISTINCT FROM billing.user_id) AS unsafe`);
      if (unsafe) throw new Error("Organization billing records require explicit reconciliation before ownership rollback.");
    }
    for (const name of ["billing_accounts", "billing_subscriptions", "billing_usage_counters"]) {
      await runner.query(`DROP INDEX UQ_${name}_legacy_scope, UQ_${name}_organization_scope`);
      await runner.query(`ALTER TABLE ${name} ADD UNIQUE(user_id${name === "billing_usage_counters" ? ", metric, period_start" : ""})`);
    }
    await runner.query(`DROP TRIGGER retain_b2b_invoices ON billing_invoices`);
    await runner.query(`DROP FUNCTION retain_b2b_invoice_identity()`);
    await runner.query(`DROP TRIGGER retain_billing_receipts ON billing_payments`);
    await runner.query(`DROP FUNCTION retain_billing_receipt_evidence()`);
    await runner.query(`ALTER TABLE billing_invoices DROP COLUMN due_at, DROP COLUMN reconciliation_reason, DROP COLUMN adjustment_of_invoice_id`);
    await runner.query(`DROP TRIGGER retain_billing_usage ON billing_usage_events`);
    await runner.query(`DROP FUNCTION retain_billing_usage_evidence()`);
    for (const name of tables) await runner.query(`ALTER TABLE ${name} DROP COLUMN organization_id`);
  }
}
