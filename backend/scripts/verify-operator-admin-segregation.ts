import "reflect-metadata";
import { strict as assert } from "node:assert";
import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { AiTroubleshootingController } from "../src/ai-troubleshooting/ai-troubleshooting.controller";
import { AuditLogController } from "../src/audit-log/audit-log.controller";
import { ProjectsController } from "../src/projects/projects.controller";
import { TerraformExportController } from "../src/terraform-export/terraform-export.controller";
import { AdminController } from "../src/admin/admin.controller";
import { UserRole } from "../src/users/user.entity";

type ControllerClass = { name: string; prototype: object };

function context(role?: UserRole): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: role ? { id: 1, role } : undefined }),
    }),
  } as unknown as ExecutionContext;
}

function authorize(controller: ControllerClass, method: string, role?: UserRole) {
  const classGuards = Reflect.getMetadata(GUARDS_METADATA, controller) || [];
  const methodTarget = (controller.prototype as Record<string, unknown>)[method];
  assert.equal(typeof methodTarget, "function", `${controller.name}.${method} must exist`);
  const methodGuards = Reflect.getMetadata(GUARDS_METADATA, methodTarget) || [];
  const guards = [...classGuards, ...methodGuards];
  assert.ok(guards.length > 0, `${controller.name}.${method} must declare an authorization guard`);
  for (const Guard of guards) {
    const result = new Guard().canActivate(context(role));
    assert.equal(result, true);
  }
}

function assertAdminOnly(controller: ControllerClass, method: string) {
  assert.doesNotThrow(() => authorize(controller, method, UserRole.ADMIN));
  assert.throws(() => authorize(controller, method, UserRole.DEVELOPER), ForbiddenException);
  assert.throws(() => authorize(controller, method, UserRole.READONLY), ForbiddenException);
  assert.throws(() => authorize(controller, method), UnauthorizedException);
}

function assertDeveloperCommand(controller: ControllerClass, method: string) {
  assert.doesNotThrow(() => authorize(controller, method, UserRole.ADMIN));
  assert.doesNotThrow(() => authorize(controller, method, UserRole.DEVELOPER));
  assert.throws(() => authorize(controller, method, UserRole.READONLY), ForbiddenException);
  assert.throws(() => authorize(controller, method), UnauthorizedException);
}

function assertDeveloperRead(controller: ControllerClass, method: string) {
  assert.doesNotThrow(() => authorize(controller, method, UserRole.ADMIN));
  assert.doesNotThrow(() => authorize(controller, method, UserRole.DEVELOPER));
  assert.doesNotThrow(() => authorize(controller, method, UserRole.READONLY));
  assert.throws(() => authorize(controller, method), UnauthorizedException);
}

const classProtected: Array<[ControllerClass, string]> = [[AuditLogController, "listAuditLogs"]];

for (const method of ["overview", "listProjects", "listAuditLogs", "listUsers", "updateUserRole"]) {
  assertAdminOnly(AdminController, method);
}

for (const [controller, method] of classProtected) {
  assertAdminOnly(controller, method);
}

assertDeveloperCommand(ProjectsController, "deployGithubActions");
assertDeveloperRead(ProjectsController, "getDetailedCurrentState");
for (const method of ["create", "download"]) assertDeveloperCommand(TerraformExportController, method);

for (const method of ["list", "get", "start", "regenerate", "followUp", "close"]) {
  assertDeveloperCommand(AiTroubleshootingController, method);
}

authorize(ProjectsController, "getCurrentState", UserRole.READONLY);

assert.equal(typeof (AdminController.prototype as unknown as Record<string, unknown>).enableUser, "undefined");

async function verifyOverviewCountsOnlyActiveProjects() {
  const queries: string[] = [];
  const controller = new AdminController(
    {} as never,
    { record: async () => undefined } as never,
    { get: () => undefined } as never,
    { query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM "projects"')) return [{ count: 0 }];
      if (sql.includes('FROM "project_pipeline_runs"')) return [{ active: 0, failed: 0, destroying: 0 }];
      return [];
    } } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const overview = await controller.overview({ user: { id: 1, role: UserRole.ADMIN, internalAdminRole: "super_admin" } } as never);
  const operationQuery = queries.find((sql) => sql.includes('FROM "project_pipeline_runs"'));
  assert.ok(operationQuery, "the overview must query operation counts");
  assert.match(operationQuery, /JOIN "projects"/i, "operation counts must be correlated to projects");
  assert.match(operationQuery, /\bproject\."status"\s*!=\s*'archived'/i, "archived projects must not create current attention");
  assert.equal(overview.counts.failedOperations, 0);
}

verifyOverviewCountsOnlyActiveProjects()
  .then(() => console.log("Operator/admin backend authorization segregation verification passed."))
  .catch((error) => { console.error(error); process.exitCode = 1; });
