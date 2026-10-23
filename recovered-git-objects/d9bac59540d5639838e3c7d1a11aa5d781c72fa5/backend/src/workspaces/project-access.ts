import { Project } from "../projects/project.entity";
import { User, UserRole } from "../users/user.entity";

export function canAccessProject(user: User, project: Pick<Project, "organizationId" | "ownerUserId">, write = false) {
  if (!user || user.disabledAt || (write && user.role === UserRole.READONLY)) return false;
  if (!project.organizationId) return project.ownerUserId === user.id;
  const membership = user.organizationMemberships?.find((item) => item.organizationId === project.organizationId);
  return Boolean(membership && (!write || ["owner", "admin", "engineer"].includes(membership.role)));
}

export function canApproveProject(user: User, project: Pick<Project, "organizationId" | "ownerUserId">) {
  if (!canAccessProject(user, project) || user.role === UserRole.READONLY) return false;
  if (!project.organizationId) return user.id === project.ownerUserId;
  return ["owner", "admin", "approver"].includes(user.organizationMemberships!.find((item) => item.organizationId === project.organizationId)!.role);
}
