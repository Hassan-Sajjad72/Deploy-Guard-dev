import { MigrationInterface, QueryRunner } from "typeorm";
export class HostingProfileGenerations1791676808500 implements MigrationInterface {
  name = "HostingProfileGenerations1791676808500";
  async up(runner: QueryRunner) {
    await runner.query(`CREATE TABLE hosting_profile_generations (id uuid PRIMARY KEY, project_id uuid NOT NULL, organization_id uuid NOT NULL, environment varchar(64) NOT NULL, profile varchar(16) NOT NULL CHECK(profile IN ('ec2','lightsail','static','lambda')), plan_id uuid NOT NULL, plan_fingerprint varchar(64) NOT NULL, artifact_fingerprint varchar(64) NOT NULL, artifacts jsonb NOT NULL, runtime_identity jsonb, status varchar(32) NOT NULL DEFAULT 'running' CHECK(status IN ('running','verified','failed','cleanup_running','deleted')), previous_generation_id uuid, retained_until timestamptz, created_by_user_id integer NOT NULL, created_at timestamptz NOT NULL DEFAULT NOW(), updated_at timestamptz NOT NULL DEFAULT NOW())`);
    await runner.query(`CREATE UNIQUE INDEX "UQ_hosting_generation_active_job" ON hosting_profile_generations(project_id,environment) WHERE status IN ('running','cleanup_running')`);
    await runner.query(`CREATE TABLE hosting_profile_jobs(id uuid PRIMARY KEY,project_id uuid NOT NULL,organization_id uuid NOT NULL,environment varchar(64) NOT NULL,generation_id uuid NOT NULL,actor_user_id integer NOT NULL,action varchar(16) NOT NULL CHECK(action IN ('deploy','rollback','cleanup')),reason varchar(1000),status varchar(16) NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','failed')),created_at timestamptz NOT NULL DEFAULT NOW(),updated_at timestamptz NOT NULL DEFAULT NOW())`);
    await runner.query(`CREATE UNIQUE INDEX "UQ_hosting_provider_active_job" ON hosting_profile_jobs(project_id,environment) WHERE status='running'`);
    await runner.query(`CREATE TABLE hosting_profile_routes (project_id uuid NOT NULL, environment varchar(64) NOT NULL, live_generation_id uuid NOT NULL REFERENCES hosting_profile_generations(id) ON DELETE RESTRICT, version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT NOW(), PRIMARY KEY(project_id,environment))`);
    await runner.query(`CREATE TABLE hosting_profile_events (id uuid PRIMARY KEY, generation_id uuid NOT NULL, project_id uuid NOT NULL, organization_id uuid NOT NULL, actor_user_id integer NOT NULL, action varchar(80) NOT NULL, evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT NOW())`);
    await runner.query(`CREATE FUNCTION protect_hosting_profile_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' OR TG_TABLE_NAME='hosting_profile_events' OR (to_jsonb(NEW)-'runtime_identity'-'status'-'retained_until'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'runtime_identity'-'status'-'retained_until'-'updated_at') OR (OLD.runtime_identity IS NOT NULL AND NEW.runtime_identity IS DISTINCT FROM OLD.runtime_identity) THEN RAISE EXCEPTION 'Hosting profile artifacts and evidence are retained and immutable'; END IF; RETURN NEW; END $$`);
    await runner.query(`CREATE TRIGGER "TRG_hosting_profile_generation_scope" BEFORE UPDATE OR DELETE ON hosting_profile_generations FOR EACH ROW EXECUTE FUNCTION protect_hosting_profile_evidence()`);
    await runner.query(`CREATE TRIGGER "TRG_hosting_profile_event_immutable" BEFORE UPDATE OR DELETE ON hosting_profile_events FOR EACH ROW EXECUTE FUNCTION protect_hosting_profile_evidence()`);
  }
  async down(runner: QueryRunner) {
    const [{ count }] = await runner.query(`SELECT ((SELECT COUNT(*) FROM hosting_profile_generations)+(SELECT COUNT(*) FROM hosting_profile_events))::int AS count`);
    if (count) throw new Error("Retained hosting generation evidence prevents rollback");
    await runner.query(`DROP TABLE hosting_profile_routes, hosting_profile_jobs, hosting_profile_generations, hosting_profile_events`);
    await runner.query(`DROP FUNCTION protect_hosting_profile_evidence()`);
  }
}
