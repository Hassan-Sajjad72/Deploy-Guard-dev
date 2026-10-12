import { MigrationInterface, QueryRunner } from "typeorm";

export class DeploymentPlans1791676803000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`CREATE TABLE deployment_plans (
      id uuid PRIMARY KEY, project_id uuid NOT NULL,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      version integer NOT NULL CHECK(version > 0), created_by_user_id integer NOT NULL,
      fingerprint varchar(64) NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), content jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id, version))`);
    await runner.query(`CREATE TABLE deployment_plan_decisions (
      plan_id uuid PRIMARY KEY REFERENCES deployment_plans(id) ON DELETE RESTRICT,
      actor_user_id integer NOT NULL, actor_role varchar NOT NULL,
      organization_id uuid NOT NULL, project_id uuid NOT NULL, environment varchar NOT NULL,
      operation_id uuid NOT NULL, monthly_budget_usd numeric(12,2) NOT NULL CHECK(monthly_budget_usd >= 0),
      decision varchar NOT NULL CHECK(decision IN ('approved','rejected')),
      fingerprint varchar(64) NOT NULL, reason varchar(1000) NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    await runner.query(`CREATE FUNCTION deployguard_immutable_plan() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Deployment plans and decisions are immutable'; END $$`);
    await runner.query(`CREATE TRIGGER immutable_deployment_plan BEFORE UPDATE OR DELETE ON deployment_plans FOR EACH ROW EXECUTE FUNCTION deployguard_immutable_plan()`);
    await runner.query(`CREATE TRIGGER immutable_deployment_plan_decision BEFORE UPDATE OR DELETE ON deployment_plan_decisions FOR EACH ROW EXECUTE FUNCTION deployguard_immutable_plan()`);
    await runner.query(`CREATE TABLE deployment_planning_ai_usage (user_id integer NOT NULL, usage_day date NOT NULL, request_count integer NOT NULL CHECK(request_count > 0), PRIMARY KEY(user_id, usage_day))`);
  }
  async down(runner: QueryRunner) {
    const [{ exists }] = await runner.query(`SELECT EXISTS(SELECT 1 FROM deployment_plans) AS exists`);
    if (exists) throw new Error("Retained deployment plans must be archived explicitly before schema rollback.");
    await runner.query(`DROP TABLE deployment_planning_ai_usage, deployment_plan_decisions, deployment_plans`);
    await runner.query(`DROP FUNCTION deployguard_immutable_plan()`);
  }
}
