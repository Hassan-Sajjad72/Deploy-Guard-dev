import { MigrationInterface, QueryRunner } from "typeorm";

export class OrganizationOwnership1791676801000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE organizations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar NOT NULL,
      kind varchar NOT NULL CHECK (kind IN ('personal', 'team', 'agency')),
      personal_owner_user_id integer UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await runner.query(`CREATE TABLE organization_memberships (
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role varchar NOT NULL CHECK (role IN ('owner', 'admin', 'engineer', 'approver', 'viewer')),
      PRIMARY KEY (organization_id, user_id))`);
    await runner.query(`CREATE INDEX "IDX_membership_user_id" ON organization_memberships(user_id)`);
    await runner.query(`ALTER TABLE projects ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT`);
    await runner.query(`CREATE INDEX "IDX_projects_organization_id" ON projects(organization_id)`);
  }

  async down(runner: QueryRunner): Promise<void> {
    const [result] = await runner.query(`SELECT EXISTS (SELECT 1 FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE o.personal_owner_user_id IS DISTINCT FROM p.owner_user_id) AS unsafe`);
    if (result.unsafe) throw new Error("Team-owned projects must be explicitly reassigned before reverting organization ownership.");
    await runner.query(`ALTER TABLE projects DROP COLUMN organization_id`);
    await runner.query(`DROP TABLE organization_memberships`);
    await runner.query(`DROP TABLE organizations`);
  }
}
