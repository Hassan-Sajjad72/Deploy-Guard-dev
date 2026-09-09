import "reflect-metadata";
import { strict as assert } from "node:assert";
import AppDataSource from "../src/data-source";

async function main() {
  await AppDataSource.initialize();
  const applied = await AppDataSource.query(`SELECT 1 FROM migrations WHERE name = 'StripeTestProviderDefaults1788956700000'`);
  assert.equal(applied.length, 1, "Stripe test billing defaults migration must be applied");
  const recurringApplied = await AppDataSource.query(`SELECT 1 FROM migrations WHERE name = 'StripeRecurringSubscriptions1788977100000'`);
  assert.equal(recurringApplied.length, 1, "Stripe recurring subscription migration must be applied");
  const columns = await AppDataSource.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'billing_invoices'`);
  const names = new Set(columns.map((row: { column_name: string }) => row.column_name));
  for (const name of ["invoice_number", "provider_transaction_id", "provider", "plan", "paid_at", "billing_period_start", "billing_period_end", "subscription_status", "invalidated_at"]) assert(names.has(name), `billing_invoices.${name} is required`);
  const subscriptionColumns = await AppDataSource.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'billing_subscriptions'`);
  const subscriptionNames = new Set(subscriptionColumns.map((row: { column_name: string }) => row.column_name));
  for (const name of ["provider_subscription_id", "provider_price_id", "billing_period_start", "billing_period_end", "cancel_at_period_end", "cancelled_at", "ended_at", "provider_event_created_at"]) assert(subscriptionNames.has(name), `billing_subscriptions.${name} is required`);
  const checkoutColumns = await AppDataSource.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'billing_checkout_sessions'`);
  const checkoutNames = new Set(checkoutColumns.map((row: { column_name: string }) => row.column_name));
  for (const name of ["provider_customer_id", "provider_subscription_id", "provider_price_id"]) assert(checkoutNames.has(name), `billing_checkout_sessions.${name} is required`);
  assert.equal((await AppDataSource.query(`SELECT to_regclass('billing_payments') AS table_name`))[0].table_name, "billing_payments");
  const visibleInvalidMocks = await AppDataSource.query(`SELECT count(*)::int AS count FROM billing_invoices WHERE provider_invoice_id LIKE 'mock-%' AND invalidated_at IS NULL`);
  assert.equal(visibleInvalidMocks[0].count, 0, "legacy mock invoices must be preserved but invalidated");
  const mockSubscriptions = await AppDataSource.query(`SELECT count(*)::int AS count FROM billing_subscriptions WHERE provider = 'mock' OR mode = 'mock'`);
  assert.equal(mockSubscriptions[0].count, 0, "unverified mock subscriptions must not remain paid plans");
  const defaults = await AppDataSource.query(`SELECT table_name, column_name, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN ('billing_invoices', 'billing_payments') AND column_name IN ('provider', 'mode')`);
  for (const row of defaults) assert.match(row.column_default, row.column_name === "provider" ? /stripe/ : /test/, `${row.table_name}.${row.column_name} must use Stripe test defaults`);
  console.log("Billing migration verification passed: Stripe recurring identity columns and test payment/invoice defaults are active, with legacy mock history preserved outside verified history.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { if (AppDataSource.isInitialized) await AppDataSource.destroy(); });
