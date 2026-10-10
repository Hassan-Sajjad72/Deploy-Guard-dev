import { MigrationInterface, QueryRunner } from "typeorm";

export class OrganizationAwsAccountBindings1791580000000 implements MigrationInterface {
  name = "OrganizationAwsAccountBindings1791580000000";
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE organizations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(120) NOT NULL CHECK (length(trim(name)) > 0),
      mode text NOT NULL DEFAULT 'TEAM' CHECK (mode IN ('TEAM', 'AGENCY')), created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`CREATE TABLE organization_memberships (
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      role text NOT NULL CHECK (role IN ('OWNER', 'ADMINISTRATOR', 'ENGINEER', 'APPROVER', 'VIEWER')),
      revoked_at timestamptz, PRIMARY KEY (organization_id, user_id)
    )`);
    await runner.query(`CREATE INDEX "IDX_organization_memberships_user" ON organization_memberships(user_id) WHERE revoked_at IS NULL`);
    await runner.query(`CREATE TABLE aws_account_bindings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      account_id varchar(12) NOT NULL CHECK (account_id ~ '^[0-9]{12}$'), region text NOT NULL CHECK (region = 'us-east-1'),
      role_arn text NOT NULL CHECK (length(role_arn) <= 2048 AND role_arn ~ ('^arn:aws:iam::' || account_id || ':role/[A-Za-z0-9_+=,.@/-]+$')),
      external_id uuid NOT NULL UNIQUE, status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'REVOKED')),
      revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((status = 'PENDING' AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL)),
      UNIQUE (organization_id, account_id, region, role_arn)
    )`);
    await runner.query(`CREATE FUNCTION deployguard_preserve_aws_binding_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.id, NEW.organization_id, NEW.account_id, NEW.region, NEW.role_arn, NEW.external_id, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.account_id, OLD.region, OLD.role_arn, OLD.external_id, OLD.created_at)
          OR (OLD.status = 'REVOKED' AND ROW(NEW.status, NEW.revoked_at) IS DISTINCT FROM ROW(OLD.status, OLD.revoked_at)) THEN
          RAISE EXCEPTION 'AWS binding identity and revoked evidence are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE TRIGGER preserve_aws_binding_identity BEFORE UPDATE ON aws_account_bindings
      FOR EACH ROW EXECUTE FUNCTION deployguard_preserve_aws_binding_identity()`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`LOCK TABLE organizations, organization_memberships, aws_account_bindings IN ACCESS EXCLUSIVE MODE`);
    const [counts] = await runner.query(`SELECT (SELECT count(*) FROM organizations) + (SELECT count(*) FROM aws_account_bindings) AS total`);
    if (Number(counts.total)) throw new Error("Refusing to discard organization ownership or AWS binding evidence");
    await runner.query(`DROP TABLE aws_account_bindings, organization_memberships, organizations`);
    await runner.query(`DROP FUNCTION deployguard_preserve_aws_binding_identity()`);
  }
}
