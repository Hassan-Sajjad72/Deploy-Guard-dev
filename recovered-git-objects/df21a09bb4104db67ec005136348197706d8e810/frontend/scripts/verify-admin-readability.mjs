import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const admin = readFileSync(new URL("../src/pages/AdminUsers.jsx", import.meta.url), "utf8");
const users = readFileSync(new URL("../src/components/admin/UserTable.jsx", import.meta.url), "utf8");
const audit = readFileSync(new URL("../src/components/audit/AuditLogsTable.jsx", import.meta.url), "utf8");
const filters = readFileSync(new URL("../src/components/audit/AuditLogFilters.jsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

for (const section of ["overview", "users", "projects", "audit"]) assert.match(admin, new RegExp(`data-admin-section="${section}"`));
assert.match(admin, /Terraform State Storage/);
assert.match(admin, /Last Updated/);
assert.match(admin, /admin-service-grid/);
assert.match(admin, /admin-project-facts/);
assert.match(users, /admin-table-wrap/);
assert.match(users, /title=\{user\.email/);
assert.match(audit, /admin-table-wrap/);
assert.match(audit, /admin-technical-value/);
assert.match(filters, /admin-audit-filters/);
for (const rule of ["overflow-wrap:anywhere", "overflow-x:auto", "line-height:1.55", "grid-template-columns", "admin-audit-evidence"]) assert.match(styles, new RegExp(rule));
assert.doesNotMatch(admin, /Terraform state/);

console.log("Admin readability verification passed.");
