import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { ConfigService } from "@nestjs/config";
import { InfracostService } from "../src/finops/infracost.service";
import { applicationHealthFromHttpStatus, probeApplicationHealth } from "../src/projects/application-health";
import { ProjectDeletionService } from "../src/projects/project-deletion.service";
import { canAccessProject, canApproveProject } from "../src/workspaces/project-access";
import { requireRole } from "../src/common/rbac/require-role.guard";
import { UserRole } from "../src/users/user.entity";
import { assertLegacyExecutionScope } from "../src/projects/customer-execution-boundary";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { TerraformExportService } from "../src/terraform-export/terraform-export.service";

async function verify() {
  const pricing = new InfracostService(new ConfigService());
  const response = (monthlyCost: unknown) => ({ projects: [{ breakdown: { resources: [{ name: "aws_ecs_service.web", monthlyCost }] } }] });
  for (const value of [undefined, null, "", " ", "unknown", -1, Infinity, false, true, [], {}, "0x10"]) {
    assert.throws(() => pricing.normalizeCostBreakdown(response(value)), /ESTIMATE_INCOMPLETE/);
  }
  assert.equal(pricing.normalizeCostBreakdown(response("0"))[0].monthlyCost, 0);
  assert.equal(pricing.normalizeCostBreakdown(response("32.45"))[0].monthlyCost, 32.45);
  assert.equal(applicationHealthFromHttpStatus(200), "healthy");
  assert.equal(applicationHealthFromHttpStatus(302), "healthy");
  assert.equal(applicationHealthFromHttpStatus(500), "failed");
  assert.equal(applicationHealthFromHttpStatus(404), "failed");
  assert.equal(applicationHealthFromHttpStatus(undefined), "unavailable");
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async (_url, options) => { fetched++; assert.equal(options?.redirect, "manual"); return new Response("Failure", { status: 500 }); };
  try {
    assert.equal((await probeApplicationHealth("http://web.us-east-1.elb.amazonaws.com")).status, "failed");
    assert.equal((await probeApplicationHealth("http://169.254.169.254/latest/meta-data/")).status, "unavailable");
    assert.equal(fetched, 1);
  } finally { globalThis.fetch = originalFetch; }

  const user: any = { id: 1, role: "developer", organizationMemberships: [{ organizationId: "org-a", role: "engineer" }] };
  const project: any = { id: "11111111-1111-4111-8111-111111111111", ownerUserId: 2, organizationId: "org-a", environmentName: "dev", repositoryFullName: "example/app", visibility: "workspace" };
  assert.equal(canAccessProject(user, project, true), true);
  assert.equal(canAccessProject({ ...user, organizationMemberships: [] }, project), false);
  assert.equal(canAccessProject({ ...user, role: "admin", organizationMemberships: [] }, project, true), false);
  assert.equal(canAccessProject({ ...user, role: "readonly", organizationMemberships: [] }, project), false);
  assert.equal(canAccessProject({ ...user, organizationMemberships: [{ organizationId: "org-a", role: "viewer" }] }, project, true), false);
  assert.equal(canAccessProject(user, { ...project, organizationId: "org-b" }), false);
  const archivedUser = { ...user, organizationMemberships: [{ organizationId: "org-a", role: "owner", archivedAt: new Date() }] };
  assert.equal(canAccessProject(archivedUser, project), true, "archived workload evidence remains readable");
  assert.equal(canAccessProject(archivedUser, project, true), false);
  assert.equal(canApproveProject(archivedUser, project), false);
  const OpsGuard = requireRole([UserRole.ADMIN], "platform_ops");
  const guard = new OpsGuard();
  const context = (scope: string) => ({ switchToHttp: () => ({ getRequest: () => ({ user: { role: "admin", githubId: null, internalAdminRole: scope } }) }) }) as any;
  assert.equal(guard.canActivate(context("platform_ops")), true);
  assert.equal(guard.canActivate(context("super_admin")), true);
  for (const scope of ["billing", "support", "security_auditor", ""]) assert.throws(() => guard.canActivate(context(scope)), /scope/);
  assert.doesNotThrow(() => assertLegacyExecutionScope({ ...project, executionMode: "legacy_control_plane" }));
  assert.throws(() => assertLegacyExecutionScope({ ...project, executionMode: "customer" }), /Customer deployment/);
  assert.throws(() => assertLegacyExecutionScope({ ...project, executionMode: undefined } as any), /Customer deployment/);
  const legacy = Object.create(RailpackDeploymentService.prototype) as any;
  let admitted = false;
  legacy.project = async () => ({ ...project, executionMode: "customer" });
  legacy.admitLifecycleOperation = async () => { admitted = true; throw new Error("Mutation was admitted"); };
  await assert.rejects(() => legacy.deploy(user, project.id), /Customer deployment/);
  assert.equal(admitted, false, "new customer projects cannot enter control-plane AWS execution");
  const exports = Object.create(TerraformExportService.prototype) as any;
  exports.projects = { findOne: async () => project };
  exports.artifacts = { createQueryBuilder: () => { throw new Error("Archive was accessed before project authorization"); } };
  await assert.rejects(() => exports.download({ ...user, organizationMemberships: [] }, project.id, "artifact"), /cannot download/);

  const operation: any = {
    id: "22222222-2222-4222-8222-222222222222", projectId: project.id, generationId: "33333333-3333-4333-8333-333333333333", status: "completed",
    metadata: { deploymentAction: "destroy" },
  };
  operation.metadata.destroyVerification = { contractVersion: "deployguard.destroy-result/v2", deploymentOperationId: operation.id, projectId: project.id, environmentName: "dev", status: "project_delete_ready", generationResourcesRemoved: true, projectResourcesRemoved: true, terraformStateArtifactsRemoved: true, sharedPlatformUntouched: true, generationIds: [operation.generationId] };
  const queries: string[] = [];
  const deletion = new ProjectDeletionService({ transaction: async (work: any) => work({ query: async (sql: string) => { queries.push(sql); }, getRepository: () => ({ findOne: async () => operation, delete: async () => ({ affected: 1 }) }) }) } as never,
    { count: async () => 1 } as never, { find: async () => [] } as never, {} as never, { deleteProjectResources: async () => undefined } as never);
  assert.equal((await deletion.finalize(project, operation)).status, "deleted");
  assert.equal(queries.some((sql) => /DELETE FROM audit_logs/i.test(sql)), false);
  for (const file of ["src/app.module.ts", "src/data-source.ts"]) assert.doesNotMatch(readFileSync(file, "utf8"), /rejectUnauthorized:\s*false/);
  console.log("PRD security, ownership, HTTP-health, audit-retention and unknown-price checks passed.");
}

verify().catch((error) => { console.error(error); process.exitCode = 1; });
