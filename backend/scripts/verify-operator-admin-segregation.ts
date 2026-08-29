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

const methodProtected: Array<[ControllerClass, string]> = [
  [ProjectsController, "getDetailedCurrentState"],
  [ProjectsController, "getDetectionProfile"],
  [ProjectsController, "getPreflight"],
];

for (const method of ["overview", "listProjects", "listAuditLogs", "listUsers", "updateUserRole", "updateUserAccess"]) {
  assertAdminOnly(AdminController, method);
}

for (const [controller, method] of [...classProtected, ...methodProtected]) {
  assertAdminOnly(controller, method);
}

for (const method of ["deployGithubActions", "detectStack", "generatePreflight"]) {
  assertDeveloperCommand(ProjectsController, method);
}
assertDeveloperCommand(TerraformExportController, "create");

for (const method of ["list", "get", "start", "regenerate", "followUp", "close"]) {
  assertDeveloperCommand(AiTroubleshootingController, method);
}

authorize(ProjectsController, "getCurrentState", UserRole.READONLY);

console.log("Operator/admin backend authorization segregation verification passed.");
