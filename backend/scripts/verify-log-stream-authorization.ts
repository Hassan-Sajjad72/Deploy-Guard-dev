import "reflect-metadata";
import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import { NotFoundException } from "@nestjs/common";
import { AuthService, SESSION_COOKIE_NAME } from "../src/auth/auth.service";
import { AuthenticatedUserMiddleware } from "../src/common/middleware/authenticated-user.middleware";
import { CloudWatchLogsService } from "../src/observability/cloudwatch-logs.service";
import { LogSanitizerService } from "../src/observability/log-sanitizer.service";
import { User, UserRole } from "../src/users/user.entity";
import { canAccessProject } from "../src/workspaces/project-access";

async function verify() {
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const project = { id: "22222222-2222-4222-8222-222222222222", organizationId, ownerUserId: 2 } as any;
  for (const scenario of ["permitted", "logout", "membership", "disabled", "generation", "slow-reader"]) {
    let user = Object.assign(new User(), { id: 1, githubId: "alice", role: UserRole.DEVELOPER, organizationMemberships: [{ organizationId, role: "engineer" }] });
    const config = new ConfigService({ AUTH_SESSION_SECRET: "test-stream-session-secret-with-32-characters", OBSERVABILITY_LOG_STREAM_POLL_INTERVAL_SECONDS: "0" });
    const revoked = new Set<string>();
    const users = { findById: async () => ({ ...user }) } as any;
    const auth = new AuthService(users, config, { existsBy: async ({ tokenHash }: any) => revoked.has(tokenHash), upsert: async ({ tokenHash }: any) => { revoked.add(tokenHash); }, delete: async () => {} } as any);
    const token = auth.createSessionToken(user);
    const request = { path: "/api/projects/logs", headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } } as any;
    await new AuthenticatedUserMiddleware(users, auth).use(request, {} as any, () => {});
    assert.equal(request.user.id, 1);
    let generationId = "generation-a", fetches = 0, ended = 0;
    const identity = () => ({ projectId: project.id, generationId, serviceId: "web", environmentName: "dev", taskArns: ["task"], logGroupName: "/owned/logs" });
    const access = async (actor: User) => { if (!canAccessProject(actor, project)) throw new NotFoundException("Project not found"); return project; };
    const resolver = { assertAccessForUser: access, resolveForUser: async (actor: User) => { await access(actor); return identity(); } } as any;
    const service = new CloudWatchLogsService(config, resolver, new LogSanitizerService()) as any;
    const frames: string[] = []; let close: () => void = () => {};
    const response = { writableLength: scenario === "slow-reader" ? 4 * 1024 * 1024 : 0, status: () => {}, setHeader: () => {}, flushHeaders: () => {}, write: (frame: string) => { frames.push(frame); }, on: (_event: string, callback: () => void) => { close = callback; }, end: () => { ended++; close(); } } as any;
    service.fetch = async () => {
      fetches++;
      if (scenario === "logout") await auth.revokeSessionToken(token);
      if (scenario === "membership") user = { ...user, organizationMemberships: [] };
      if (scenario === "disabled") user = { ...user, disabledAt: new Date() };
      const message = generationId === "generation-a" ? "OLD_PRIVATE_LOG" : "NEW_VERIFIED_LOG";
      if (scenario === "generation") generationId = "generation-b";
      return [{ id: String(fetches), timestamp: new Date().toISOString(), message }];
    };
    service.sleep = async () => { if (!ended) response.end(); };
    await service.stream(request.user, project.id, response, "web", request.refreshAuthenticatedUser);
    const output = frames.join("");
    assert.equal(ended, 1);
    if (["logout", "membership", "disabled"].includes(scenario)) { assert.match(output, /event: access_revoked/); assert.doesNotMatch(output, /OLD_PRIVATE_LOG|event: connected|generation-a/); }
    else if (scenario === "generation") { assert.doesNotMatch(output, /OLD_PRIVATE_LOG/); assert.match(output, /NEW_VERIFIED_LOG/); assert.equal(fetches, 2); }
    else if (scenario === "slow-reader") { assert.doesNotMatch(output, /OLD_PRIVATE_LOG|event: connected/); }
    else { assert.match(output, /OLD_PRIVATE_LOG/); assert.match(output, /event: connected/); }
    let headersWritten = false;
    await assert.rejects(() => service.stream(user, project.id, { setHeader: () => { headersWritten = true; } } as any, "web"), /access expired/);
    assert.equal(headersWritten, false);
  }
  console.log("Log stream authorization checks passed: actual session logout, disabled identity, fresh membership, in-flight revocation and release changes prevent stale batch delivery.");
}
verify().catch((error) => { console.error(error); process.exitCode = 1; });
