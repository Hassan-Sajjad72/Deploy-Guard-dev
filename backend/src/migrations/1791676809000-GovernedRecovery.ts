import { MigrationInterface, QueryRunner } from "typeorm";
export class GovernedRecovery1791676809000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE governed_recovery_requests (id uuid PRIMARY KEY, project_id uuid NOT NULL, organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT, incident_id uuid NOT NULL, created_by_user_id integer NOT NULL, fingerprint varchar(64) NOT NULL, content jsonb NOT NULL, status varchar NOT NULL DEFAULT 'requested', operation_id uuid, started_at timestamptz, completed_at timestamptz, outcome jsonb, created_at timestamptz NOT NULL DEFAULT now(), CHECK(status IN ('requested','approved','rejected','running','resolved','failed','unverified')))`);
    await q.query(`CREATE INDEX ON governed_recovery_requests(project_id,created_at)`);
    await q.query(`CREATE UNIQUE INDEX governed_recovery_single_running ON governed_recovery_requests(project_id) WHERE status='running'`);
    await q.query(`CREATE TABLE governed_recovery_decisions (request_id uuid PRIMARY KEY REFERENCES governed_recovery_requests(id) ON DELETE RESTRICT, actor_user_id integer NOT NULL, actor_role varchar NOT NULL, fingerprint varchar(64) NOT NULL, decision varchar NOT NULL CHECK(decision IN ('approved','rejected')), reason varchar(1000) NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE supervised_repair_proposals (id uuid PRIMARY KEY, project_id uuid NOT NULL, organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT, created_by_user_id integer NOT NULL, fingerprint varchar(64) NOT NULL, content jsonb NOT NULL, status varchar NOT NULL DEFAULT 'unverified', checks jsonb, pull_request_url varchar, created_at timestamptz NOT NULL DEFAULT now(), CHECK(status IN ('unverified','checking','failed','passed','pull_request_opened')))`);
    await q.query(`CREATE UNIQUE INDEX supervised_repair_single_check ON supervised_repair_proposals(project_id) WHERE status='checking'`);
    await q.query(`CREATE FUNCTION retain_governed_recovery_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' OR TG_TABLE_NAME='governed_recovery_decisions' THEN RAISE EXCEPTION 'Governed recovery evidence is immutable'; END IF; IF (to_jsonb(NEW)-ARRAY['status','operation_id','started_at','completed_at','outcome','checks','pull_request_url']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','operation_id','started_at','completed_at','outcome','checks','pull_request_url']) THEN RAISE EXCEPTION 'Governed recovery evidence is immutable'; END IF; RETURN NEW; END $$`);
    for (const table of ["governed_recovery_requests", "governed_recovery_decisions", "supervised_repair_proposals"]) await q.query(`CREATE TRIGGER retain_evidence BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION retain_governed_recovery_evidence()`);
  }
  async down(q: QueryRunner) {
    await q.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM governed_recovery_requests) OR EXISTS(SELECT 1 FROM supervised_repair_proposals) THEN RAISE EXCEPTION 'Recovery evidence must be retained'; END IF; END $$`);
    await q.query(`DROP TABLE governed_recovery_decisions, governed_recovery_requests, supervised_repair_proposals; DROP FUNCTION retain_governed_recovery_evidence()`);
  }
}
