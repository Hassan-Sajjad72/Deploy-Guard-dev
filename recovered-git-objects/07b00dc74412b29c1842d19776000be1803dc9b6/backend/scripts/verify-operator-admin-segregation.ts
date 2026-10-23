import "reflect-metadata";
import { strict as assert } from "node:assert";
import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { AiTroubleshootingController } from "../src/ai-troubleshooting/ai-troubleshooting.controller";
import { AuditLogController } from "../src/audit-log/audit-log.controller";
import { ProjectsController } from "../src/projects/projects.controller";
import { TerraformExportController } from "../src/terraform-export/terraform-export.controller";
import { AdminController } from "../src/admin/admin.controller";
import { User, UserRole } from "../src/users/user.entity";
import { UsersService } from "../src/users/users.service";

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

for (const method of ["overview", "listProjects", "listAuditLogs", "listUsers", "updateUserRole", "enableUser"]) {
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

async function verifyEnableUser() {
  const disabled = Object.assign(new User(), {
    id: 27, githubId: "github-readonly", role: UserRole.READONLY, disabledAt: new Date(),
  });
  const saved: User[] = [];
  const users = new UsersService({
    findOne: async () => disabled,
    save: async (user: User) => { saved.push(user); return user; },
  } as never, {} as never);
  const actions: string[] = [];
  const controller = new AdminController(
    users,
    { record: async ({ action }: { action: string }) => { actions.push(action); } } as never,
    {} as never, {} as never, {} as never, {} as never,
  );
  const result = await controller.enableUser(27, { user: { id: 1, role: UserRole.ADMIN } } as never);
  assert.deepEqual(result.user, { id: "27", enabled: true, role: UserRole.READONLY });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].githubId, "github-readonly");
  assert.equal(saved[0].disabledAt, null);
  assert.deepEqual(actions, ["USER_ENABLED"]);
}

verifyEnableUser().then(() => console.log("Operator/admin backend authorization segregation verification passed.")).catch((error) => { console.error(error); process.exitCode = 1; });
