import { ForbiddenException } from "@nestjs/common";
import { User, UserRole } from "../users/user.entity";

export const INTERNAL_ADMIN_ROLES = ["super_admin", "platform_ops", "support", "billing", "security_auditor"] as const;
export type InternalAdminRole = typeof INTERNAL_ADMIN_ROLES[number];

export function assertInternalAdminScope(user: User, scope: InternalAdminRole) {
  if (!user || user.disabledAt || user.githubId || user.role !== UserRole.ADMIN) throw new ForbiddenException("Internal administrator authentication required");
  const role = user.internalAdminRole;
  if (role !== "super_admin" && role !== scope) throw new ForbiddenException("Administrator scope does not permit this action");
}
