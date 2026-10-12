import { MigrationInterface, QueryRunner } from "typeorm";

export class OrganizationAiBudget1791676806000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`CREATE TABLE organization_ai_daily_usage (
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT, usage_day date NOT NULL,
      request_count integer NOT NULL DEFAULT 0 CHECK(request_count >= 0), committed_usd_micros bigint NOT NULL DEFAULT 0 CHECK(committed_usd_micros >= 0),
      PRIMARY KEY(organization_id, usage_day))`);
    await runner.query(`CREATE TABLE organization_ai_requests (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT, usage_day date NOT NULL,
      model varchar NOT NULL, pricing_source varchar NOT NULL, pricing_as_of timestamptz NOT NULL,
      input_usd_per_million numeric NOT NULL, output_usd_per_million numeric NOT NULL,
      reserved_usd_micros bigint NOT NULL CHECK(reserved_usd_micros >= 0), created_at timestamptz NOT NULL DEFAULT now())`);
    await runner.query(`CREATE TABLE organization_ai_settlements (
      request_id uuid PRIMARY KEY REFERENCES organization_ai_requests(id) ON DELETE RESTRICT,
      input_tokens integer NOT NULL CHECK(input_tokens >= 0), output_tokens integer NOT NULL CHECK(output_tokens >= 0),
      charged_usd_micros bigint NOT NULL CHECK(charged_usd_micros >= 0), created_at timestamptz NOT NULL DEFAULT now())`);
    await runner.query(`CREATE FUNCTION retain_ai_usage_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'AI usage evidence is immutable'; END $$`);
    for (const table of ["organization_ai_requests", "organization_ai_settlements"]) await runner.query(`CREATE TRIGGER retain_ai_evidence BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION retain_ai_usage_evidence()`);
  }
  async down(runner: QueryRunner) {
    const [{ retained }] = await runner.query(`SELECT EXISTS(SELECT 1 FROM organization_ai_requests) AS retained`);
    if (retained) throw new Error("Retained inference cost evidence requires explicit reconciliation before rollback.");
    await runner.query(`DROP TABLE organization_ai_settlements, organization_ai_requests, organization_ai_daily_usage`);
    await runner.query(`DROP FUNCTION retain_ai_usage_evidence()`);
  }
}
