import { MigrationInterface, QueryRunner } from "typeorm";

export class OperationalIntelligence1791676808000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`ALTER TABLE users ADD COLUMN internal_admin_role varchar(32)`);
    await runner.query(`UPDATE users SET internal_admin_role = 'super_admin' WHERE role = 'admin' AND github_id IS NULL`);
    await runner.query(`ALTER TABLE users ADD CONSTRAINT "CHK_internal_admin_role" CHECK (internal_admin_role IS NULL OR (role = 'admin' AND github_id IS NULL AND internal_admin_role IN ('super_admin','platform_ops','support','billing','security_auditor')))`);
    await runner.query(`CREATE TABLE admin_identity_verifications (user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL)`);
    await runner.query(`CREATE TABLE admin_privileged_events (id uuid PRIMARY KEY,actor_user_id integer NOT NULL,target_user_id integer NOT NULL,action varchar(64) NOT NULL,reason varchar(1000) NOT NULL,outcome jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT NOW())`);
    await runner.query(`CREATE TABLE support_access_grants (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT, project_id uuid, operator_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT, approved_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT, purpose varchar(1000) NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz, revoked_by_user_id integer, created_at timestamptz NOT NULL DEFAULT NOW(), CHECK (expires_at <= created_at + interval '24 hours'))`);
    await runner.query(`CREATE TABLE operational_intelligence_records (id uuid PRIMARY KEY, project_id uuid NOT NULL, organization_id uuid, kind varchar(32) NOT NULL CHECK (kind IN ('incident','api_contract','api_run','optimization')), fingerprint varchar(64) NOT NULL, content jsonb NOT NULL, created_by_user_id integer NOT NULL, created_at timestamptz NOT NULL DEFAULT NOW())`);
    await runner.query(`CREATE INDEX "IDX_intelligence_project_kind" ON operational_intelligence_records(project_id,kind,created_at)`);
    await runner.query(`CREATE TABLE api_assurance_approvals (contract_id uuid PRIMARY KEY REFERENCES operational_intelligence_records(id) ON DELETE RESTRICT, actor_user_id integer NOT NULL, fingerprint varchar(64) NOT NULL, expires_at timestamptz NOT NULL, reason varchar(1000) NOT NULL, created_at timestamptz NOT NULL DEFAULT NOW())`);
    await runner.query(`CREATE FUNCTION protect_operational_intelligence_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Operational intelligence evidence is immutable'; END $$`);
    await runner.query(`CREATE TRIGGER "TRG_intelligence_immutable" BEFORE UPDATE OR DELETE ON operational_intelligence_records FOR EACH ROW EXECUTE FUNCTION protect_operational_intelligence_evidence()`);
    await runner.query(`CREATE TRIGGER "TRG_assurance_approval_immutable" BEFORE UPDATE OR DELETE ON api_assurance_approvals FOR EACH ROW EXECUTE FUNCTION protect_operational_intelligence_evidence()`);
    await runner.query(`CREATE TRIGGER "TRG_admin_privileged_events_immutable" BEFORE UPDATE OR DELETE ON admin_privileged_events FOR EACH ROW EXECUTE FUNCTION protect_operational_intelligence_evidence()`);
    await runner.query(`CREATE FUNCTION protect_support_access_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Support access history is retained'; END IF; IF (to_jsonb(NEW)-'revoked_at'-'revoked_by_user_id') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'revoked_by_user_id') OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by_user_id IS DISTINCT FROM OLD.revoked_by_user_id)) OR NEW.revoked_at IS NULL OR NEW.revoked_by_user_id IS NULL THEN RAISE EXCEPTION 'Support scope is immutable; only terminal revocation is permitted'; END IF; RETURN NEW; END $$`);
    await runner.query(`CREATE TRIGGER "TRG_support_scope_immutable" BEFORE UPDATE OR DELETE ON support_access_grants FOR EACH ROW EXECUTE FUNCTION protect_support_access_scope()`);
  }
  async down(runner: QueryRunner) {
    const [{ count }] = await runner.query(`SELECT ((SELECT COUNT(*) FROM operational_intelligence_records)+(SELECT COUNT(*) FROM admin_privileged_events)+(SELECT COUNT(*) FROM support_access_grants))::int AS count`);
    if (count) throw new Error("Retained operational evidence prevents rollback");
    await runner.query(`DROP TABLE api_assurance_approvals, operational_intelligence_records, support_access_grants, admin_identity_verifications, admin_privileged_events`);
    await runner.query(`DROP FUNCTION protect_operational_intelligence_evidence()`);
    await runner.query(`DROP FUNCTION protect_support_access_scope()`);
    await runner.query(`ALTER TABLE users DROP CONSTRAINT "CHK_internal_admin_role", DROP COLUMN internal_admin_role`);
  }
}
