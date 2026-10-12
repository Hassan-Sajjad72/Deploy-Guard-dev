import { MigrationInterface, QueryRunner } from "typeorm";

export class AgencyOwnership1791676805000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`CREATE TABLE agency_clients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      name varchar(120) NOT NULL CHECK(length(trim(name)) > 0), archived_at timestamptz, archive_reason varchar(1000),
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id, organization_id))`);
    await runner.query(`CREATE TABLE agency_engagements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, client_id uuid NOT NULL,
      name varchar(120) NOT NULL CHECK(length(trim(name)) > 0), aws_account_binding_id uuid NOT NULL,
      authorized_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT, authorization_reference varchar(1000) NOT NULL CHECK(length(trim(authorization_reference)) > 0),
      archived_at timestamptz, archive_reason varchar(1000), created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY(client_id, organization_id) REFERENCES agency_clients(id, organization_id) ON DELETE RESTRICT,
      FOREIGN KEY(aws_account_binding_id, organization_id) REFERENCES aws_account_bindings(id, organization_id) ON DELETE RESTRICT,
      UNIQUE(id, client_id, organization_id))`);
    await runner.query(`ALTER TABLE projects ADD COLUMN client_id uuid, ADD COLUMN engagement_id uuid,
      ADD CONSTRAINT "CHK_project_agency_pair" CHECK((client_id IS NULL) = (engagement_id IS NULL)),
      ADD CONSTRAINT "FK_project_agency_scope" FOREIGN KEY(engagement_id, client_id, organization_id) REFERENCES agency_engagements(id, client_id, organization_id) ON DELETE RESTRICT,
      ADD CONSTRAINT "CHK_project_agency_workspace" CHECK(client_id IS NULL OR organization_id IS NOT NULL)`);
  }
  async down(runner: QueryRunner) {
    const [{ unsafe }] = await runner.query(`SELECT EXISTS(SELECT 1 FROM agency_clients) OR EXISTS(SELECT 1 FROM projects WHERE client_id IS NOT NULL) AS unsafe`);
    if (unsafe) throw new Error("Agency ownership and authorization records require explicit reconciliation before rollback.");
    await runner.query(`ALTER TABLE projects DROP CONSTRAINT "CHK_project_agency_pair", DROP CONSTRAINT "FK_project_agency_scope", DROP CONSTRAINT "CHK_project_agency_workspace", DROP COLUMN client_id, DROP COLUMN engagement_id`);
    await runner.query(`DROP TABLE agency_engagements, agency_clients`);
  }
}
