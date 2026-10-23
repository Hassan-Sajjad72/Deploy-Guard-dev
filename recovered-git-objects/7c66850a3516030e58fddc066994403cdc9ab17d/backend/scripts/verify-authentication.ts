import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "../src/auth/auth.service";
import { User, UserRole } from "../src/users/user.entity";
import { UsersService } from "../src/users/users.service";
import { AuthenticatedUserMiddleware } from "../src/common/middleware/authenticated-user.middleware";
import { SESSION_COOKIE_NAME } from "../src/auth/auth.service";
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

  const signedUp = await auth.signup({
    name: "  Deploy Guard User  ",
    email: "USER@example.com",
    password: "correct-horse-battery-staple",
  });
  assert.equal(signedUp.name, "Deploy Guard User");
  assert.equal(signedUp.email, "user@example.com");
  assert.match(signedUp.passwordHash, /^pbkdf2\$120000\$/);
  assert.equal(signedUp.passwordHash.includes("correct-horse-battery-staple"), false);

  const loggedIn = await auth.login({
    email: "user@example.com",
    password: "correct-horse-battery-staple",
  });
  assert.equal(loggedIn.id, signedUp.id);
  await assert.rejects(
    auth.login({ email: "user@example.com", password: "incorrect-password" }),
    UnauthorizedException
  );

  const session = auth.createSessionToken(loggedIn);
  assert.equal((await auth.getUserFromSessionToken(session))?.id, loggedIn.id);
  assert.equal(await auth.getUserFromSessionToken(`${session}tampered`), null);

  const middleware = new AuthenticatedUserMiddleware(users as unknown as UsersService, auth);
  const request = {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${session}` },
    header: () => undefined,
  } as never;
  await new Promise<void>((done) => middleware.use(request, {} as never, done));
  assert.equal((request as { user?: User }).user?.id, loggedIn.id);

  const appModuleSource = readFileSync(resolve(__dirname, "../src/app.module.ts"), "utf8");
  assert.match(
    appModuleSource,
    /api\/projects\/:projectId\/pipeline\/runs\/:runId\/approve-apply/,
    "Apply approval must pass through authenticated-user middleware"
  );
  assert.match(
    appModuleSource,
    /api\/projects\/:projectId\/release-lane\/status/,
    "Release-lane status must pass through authenticated-user middleware"
  );
  assert.match(
    appModuleSource,
    /api\/projects\/:projectId\/release-lane\/prepare/,
    "Release-lane preparation must pass through authenticated-user middleware"
  );

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

  console.log("Email/GitHub authentication and protected apply-approval middleware verification passed.");
}

verify();
