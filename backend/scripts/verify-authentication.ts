import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "../src/auth/auth.service";
import { AuthController } from "../src/auth/auth.controller";
import { User, UserRole } from "../src/users/user.entity";
import { UsersService } from "../src/users/users.service";
import { AuthenticatedUserMiddleware } from "../src/common/middleware/authenticated-user.middleware";
import { ADMIN_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth/auth.service";
import { requireRole } from "../src/common/rbac/require-role.guard";

class InMemoryUsers {
  private user: User | null = null;

  async createWithPassword(data: { name: string; email: string; passwordHash: string }) {
    this.user = Object.assign(new User(), {
      id: 41,
      name: data.name,
      email: data.email,
      passwordHash: data.passwordHash,
      role: UserRole.DEVELOPER,
      lastLoginAt: new Date(),
    });
    return this.user;
  }

  async findByEmailWithPassword(email: string) {
    return this.user?.email.toLowerCase() === email.toLowerCase() ? this.user : null;
  }

  async markLoggedIn(user: User) {
    user.lastLoginAt = new Date();
    return user;
  }

  async findById(id: number) {
    return this.user?.id === id ? this.user : null;
  }
}

async function verify() {
  const users = new InMemoryUsers();
  const config = new ConfigService({
    AUTH_SESSION_SECRET: "test-only-session-secret-with-at-least-32-characters",
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CALLBACK_URL: "http://localhost:5000/api/auth/github/callback",
  });
  const auth = new AuthService(users as unknown as UsersService, config);

  const githubUser = Object.assign(new User(), {
    id: 41, name: "Deploy Guard User", email: "user@example.com",
    githubId: "123", githubLogin: "deployguard-user", role: UserRole.DEVELOPER,
    lastLoginAt: new Date(),
  });
  (users as any).user = githubUser;
  const session = auth.createSessionToken(githubUser);
  assert.equal((await auth.getUserFromSessionToken(session))?.id, githubUser.id);
  assert.equal(await auth.getUserFromSessionToken(`${session}tampered`), null);

  const middleware = new AuthenticatedUserMiddleware(users as unknown as UsersService, auth);
  const request = {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${session}` },
    header: () => undefined,
  } as never;
  await new Promise<void>((done) => middleware.use(request, {} as never, done));
  assert.equal((request as { user?: User }).user?.id, githubUser.id);

  const adminUsers = new InMemoryUsers();
  const adminAuth = new AuthService(adminUsers as unknown as UsersService, config);
  const admin = await adminAuth.signup({
    name: "DeployGuard Admin",
    email: "admin@example.test",
    password: "correct-admin-password",
  });
  admin.role = UserRole.ADMIN;
  const authenticatedAdmin = await adminAuth.adminLogin({
    email: admin.email,
    password: "correct-admin-password",
  });
  const adminSession = adminAuth.createSessionToken(authenticatedAdmin, "admin");
  assert.equal((await adminAuth.getUserFromSessionToken(adminSession, "admin"))?.id, admin.id);
  assert.equal(await adminAuth.getUserFromSessionToken(adminSession, "developer"), null);
  assert.equal(await adminAuth.getUserFromSessionToken(session, "admin"), null);

  const adminMiddleware = new AuthenticatedUserMiddleware(adminUsers as unknown as UsersService, adminAuth);
  const adminRequest = {
    path: "/api/admin/overview",
    headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${adminSession}` },
    header: () => undefined,
  } as never;
  await new Promise<void>((done) => adminMiddleware.use(adminRequest, {} as never, done));
  assert.equal((adminRequest as { user?: User }).user?.id, admin.id);

  const developerOnAdminRoute = {
    path: "/api/admin/overview",
    headers: { cookie: `${SESSION_COOKIE_NAME}=${session}` },
    header: () => undefined,
  } as never;
  await new Promise<void>((done) => adminMiddleware.use(developerOnAdminRoute, {} as never, done));
  assert.equal((developerOnAdminRoute as { user?: User }).user, undefined);

  const appModuleSource = readFileSync(resolve(__dirname, "../src/app.module.ts"), "utf8");
  assert.match(
    appModuleSource,
    /path: "\*"/,
    "Every current API route must pass through authenticated-user middleware"
  );
  const authControllerSource = readFileSync(resolve(__dirname, "../src/auth/auth.controller.ts"), "utf8");
  assert.doesNotMatch(authControllerSource, /@Post\("(?:signup|login)"\)/, "Email/password routes are retired");

  const ApprovalRoleGuard = requireRole([UserRole.ADMIN, UserRole.DEVELOPER]);
  const guard = new ApprovalRoleGuard();
  const context = (user?: Partial<User>) => ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as never;
  assert.throws(() => guard.canActivate(context()), UnauthorizedException);
  assert.throws(() => guard.canActivate(context({ role: UserRole.READONLY })), ForbiddenException);
  assert.equal(guard.canActivate(context({ role: UserRole.DEVELOPER })), true);

  const githubUrl = new URL(auth.getGithubAuthorizationUrl("verified-state"));
  assert.equal(githubUrl.hostname, "github.com");
  assert.equal(githubUrl.searchParams.get("state"), "verified-state");
  assert.match(githubUrl.searchParams.get("scope") || "", /\brepo\b/);

  const legacyGithubAdmin = Object.assign(new User(), {
    id: 77,
    githubId: "legacy-admin-github-id",
    githubLogin: "legacy-admin",
    role: UserRole.ADMIN,
  });
  const repository = {
    findOne: async () => legacyGithubAdmin,
    save: async (value: User) => value,
  };
  const normalized = await new UsersService(repository as never, config).findOrCreate({
    githubId: legacyGithubAdmin.githubId,
    name: "Legacy GitHub Admin",
    email: "legacy@example.test",
    image: "",
    login: "legacy-admin",
  });
  assert.equal(normalized.user.role, UserRole.DEVELOPER, "legacy GitHub-linked administrators must regain developer authentication without changing project ownership");

  const usersSource = readFileSync(resolve(__dirname, "../src/users/users.service.ts"), "utf8");
  assert.match(usersSource, /GitHub-linked users cannot be administrators/);
  const migrationSource = readFileSync(resolve(__dirname, "../src/migrations/1760000070000-SeparateLegacyGithubAdministrators.ts"), "utf8");
  assert.match(migrationSource, /SET "role" = 'developer'[\s\S]*"github_id" IS NOT NULL[\s\S]*"role" = 'admin'/);

  console.log("GitHub authentication and protected API middleware verification passed.");
}

verify();
