import { MigrationInterface, QueryRunner } from "typeorm";

export class MigratePersonalWorkspaceOwnership1791676801500 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`INSERT INTO organizations (name, kind, personal_owner_user_id)
      SELECT COALESCE(github_login, name, 'Personal workspace'), 'personal', id FROM users ON CONFLICT (personal_owner_user_id) DO NOTHING`);
    await runner.query(`INSERT INTO organization_memberships (organization_id, user_id, role)
      SELECT id, personal_owner_user_id, 'owner' FROM organizations WHERE personal_owner_user_id IS NOT NULL ON CONFLICT DO NOTHING`);
    await runner.query(`UPDATE projects SET organization_id = organization.id FROM organizations organization
      WHERE projects.organization_id IS NULL AND organization.personal_owner_user_id = projects.owner_user_id`);
  }

  async down(): Promise<void> {
    // Retain explicit ownership records; the schema rollback validates safe reassignment.
  }
}
