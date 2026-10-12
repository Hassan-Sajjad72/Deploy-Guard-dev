export function adminLandingPath(role) {
  return role === "billing" ? "/admin/billing" : role === "support" ? "/admin/access" : role === "security_auditor" ? "/admin?section=audit" : ["super_admin", "platform_ops"].includes(role) ? "/admin" : "/403";
}
export function adminSectionAllowed(role, section) {
  if (role === "super_admin") return true;
  if (section === "access") return ["platform_ops", "support", "billing", "security_auditor"].includes(role);
  return role === "platform_ops" ? ["overview", "projects"].includes(section) : role === "security_auditor" ? section === "audit" : role === "billing" ? ["billing","entitlements"].includes(section) : false;
}
