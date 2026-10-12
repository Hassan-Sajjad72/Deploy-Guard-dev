import { MigrationInterface, QueryRunner } from "typeorm";
export class OrganizationEntitlementVersions1791676810000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE organization_entitlement_versions(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT, version integer NOT NULL CHECK(version>0), tier varchar NOT NULL CHECK(tier IN ('startup','team','agency')), limits jsonb NOT NULL, reason varchar(1000) NOT NULL CHECK(length(trim(reason))>0), actor_user_id integer NOT NULL, idempotency_key uuid NOT NULL UNIQUE, fingerprint varchar(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,version))`);
    await q.query(`CREATE TABLE organization_entitlement_usage_events(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT, entitlement_version_id uuid REFERENCES organization_entitlement_versions(id) ON DELETE RESTRICT, resource varchar NOT NULL CHECK(resource IN ('members','projects','environments','agencyClients')), quantity integer NOT NULL CHECK(quantity<>0), idempotency_key varchar(200) NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX ON organization_entitlement_usage_events(organization_id,created_at)`);
    await q.query(`CREATE FUNCTION retain_organization_entitlements() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Entitlement and metering history is immutable'; END $$`);
    for (const table of ["organization_entitlement_versions", "organization_entitlement_usage_events"]) await q.query(`CREATE TRIGGER retain_entitlement_history BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION retain_organization_entitlements()`);
  }
  async down(q: QueryRunner) {
    await q.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM organization_entitlement_versions) OR EXISTS(SELECT 1 FROM organization_entitlement_usage_events) THEN RAISE EXCEPTION 'Entitlement history must be retained'; END IF; END $$`);
    await q.query(`DROP TABLE organization_entitlement_usage_events,organization_entitlement_versions; DROP FUNCTION retain_organization_entitlements()`);
  }
}
