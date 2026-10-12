import { EntityManager } from "typeorm";
import { User } from "../users/user.entity";

export async function ensurePersonalWorkspace(manager: EntityManager, user: User): Promise<string> {
  const [organization] = await manager.query(
    `INSERT INTO organizations (name, kind, personal_owner_user_id) VALUES ($1, 'personal', $2)
     ON CONFLICT (personal_owner_user_id) DO UPDATE SET personal_owner_user_id = EXCLUDED.personal_owner_user_id RETURNING id`,
    [user.githubLogin || user.name || "Personal workspace", user.id],
  );
  await manager.query(`INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [organization.id, user.id]);
  return organization.id;
}
