import "reflect-metadata";
import { strict as assert } from "node:assert";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ConfigService } from "@nestjs/config";
import { PROVIDER_CHECKS, HostingProfileRegistryService, IMPLEMENTED_PROVIDER_CONTRACTS } from "../src/planning/hosting-profile-registry.service";
import { planFingerprint } from "../src/planning/deployment-plan";
import { CUSTOMER_AUTHORITY_CHECKS, validateCustomerAuthorityProof } from "../src/workspaces/customer-authority-proof";
import { customerControlPlanePrincipal } from "../src/workspaces/customer-control-plane-principal";
import { CustomerAuthorityService } from "../src/workspaces/customer-authority.service";
import { AwsAccountBinding } from "../src/workspaces/aws-account-binding.entity";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { Project } from "../src/projects/project.entity";
import { ProjectPipelineRun } from "../src/projects/project-pipeline-run.entity";
import { assertReusableWorkflowCompatibility, parsePinnedReusableWorkflow, CONTROL_PLANE_EXECUTABLE_PATHS } from "../src/projects/github-actions-workflow-contract";
import { renderDeployguardCallerWorkflow } from "../src/projects/github-app.service";
import { generatedCallerWithKeys } from "../src/projects/github-actions-workflow-contract";
import { verifyEffectiveWorkflowCapabilities } from "../src/projects/github-actions-aws-capability.service";

const key = "local-contract-test-key-never-provider-evidence";
const approvalId = "local-contract-unit-fixture";
const sign = (proof: unknown) => ({ proof, signature: createHmac("sha256", key).update(planFingerprint(proof)).digest("hex") });
const ids = { organizationId: "11111111-1111-4111-8111-111111111111", bindingId: "22222222-2222-4222-8222-222222222222", projectId: "33333333-3333-4333-8333-333333333333", operationId: "44444444-4444-4444-8444-444444444444", planId: "55555555-5555-4555-8555-555555555555" };
const verifiedAt = new Date(Date.now() - 1000).toISOString(), approvedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 3600000).toISOString();
const profileProof = { contractVersion: "deployguard.final-provider-proof/v1", profile: "ecs_fargate", region: "us-east-1", adapterVersion: IMPLEMENTED_PROVIDER_CONTRACTS.ecs_fargate!.version, executableFingerprint: IMPLEMENTED_PROVIDER_CONTRACTS.ecs_fargate!.fingerprint, accountId: "123456789012", verifiedAt, expiresAt, checks: PROVIDER_CHECKS.map((check) => ({ check, status: "verified", artifactSha256: "b".repeat(64) })), finalApproval: { approvalId, actorId: "91", approvedAt } };
const config = new ConfigService({ DEPLOYGUARD_CONTROL_PLANE_ROLE_ARN: "arn:aws:iam::999999999999:role/control", DEPLOYGUARD_FINAL_PROVIDER_PROOF_SIGNING_KEY: key, DEPLOYGUARD_FINAL_PROVIDER_APPROVAL_ID: approvalId, DEPLOYGUARD_FINAL_PROVIDER_PROOFS: JSON.stringify([sign(profileProof)]) });
const binding: any = { id: ids.bindingId, organizationId: ids.organizationId, verificationVersion: 3, verificationStatus: "verified", verifiedAt: new Date(Date.now() - 2000), accountId: "123456789012", roleArn: "arn:aws:iam::123456789012:role/customer", regions: ["us-east-1"], verificationEvidence: { accountIdentity: true, mutationAuthority: "unverified" } };
const authorityProof = { contractVersion: "deployguard.customer-authority-proof/v1", organizationId: ids.organizationId, bindingId: ids.bindingId, bindingVersion: 3, accountId: binding.accountId, roleArn: binding.roleArn, regions: binding.regions, projectIds: [ids.projectId], workflowBrokerRoles: { [ids.projectId]: `arn:aws:iam::999999999999:role/dg-customer-broker-${ids.projectId.replaceAll("-", "").slice(0, 12)}` }, executionRoleBoundaryArns: { [ids.projectId]: `arn:aws:iam::${binding.accountId}:policy/deployguard/${ids.projectId}/ecs-task-boundary-${ids.projectId}` }, verifiedAt, expiresAt, checks: CUSTOMER_AUTHORITY_CHECKS.map((check) => ({ check, status: "verified", artifactSha256: "c".repeat(64) })), finalApproval: { approvalId, actorId: "91", approvedAt } };

async function main() {
  const profiles = new HostingProfileRegistryService(config);
  assert(profiles.available("ecs_fargate", "us-east-1"));
  assert(!profiles.available("ecs_fargate", "eu-west-1"));
  assert(!new HostingProfileRegistryService(new ConfigService()).available("ecs_fargate", "us-east-1"));
  for (const changed of [{ ...profileProof, checks: profileProof.checks.slice(1) }, { ...profileProof, executableFingerprint: "0".repeat(64) }, { ...profileProof, expiresAt: verifiedAt }]) {
    assert(!new HostingProfileRegistryService(new ConfigService({ ...config['internalConfig'], DEPLOYGUARD_FINAL_PROVIDER_PROOFS: JSON.stringify([sign(changed)]) })).available("ecs_fargate", "us-east-1"));
  }
  assert(validateCustomerAuthorityProof(config, sign(authorityProof), binding, ids.projectId));
  assert.equal(validateCustomerAuthorityProof(config, sign(authorityProof), { ...binding, verificationVersion: 4 }, ids.projectId), null);
  assert.equal(validateCustomerAuthorityProof(config, sign(authorityProof), binding, ids.planId), null);
  assert.equal(validateCustomerAuthorityProof(config, { proof: authorityProof, signature: "0".repeat(64) }, binding), null);
  assert.throws(() => customerControlPlanePrincipal(new ConfigService({ DEPLOYGUARD_CONTROL_PLANE_ROLE_ARN: binding.roleArn, AWS_ONBOARDING_CONTROL_PLANE_ROLE_ARN: "arn:aws:iam::999999999999:role/other" })));

  let freshOperator = true, archived = false, auditCount = 0, saves = 0;
  const manager: any = { query: async (sql: string) => sql.includes("admin_identity_verifications") ? freshOperator ? [{ id: 91 }] : [] : sql.includes("FROM organizations") ? archived ? [] : [{ id: ids.organizationId }] : sql.includes("FROM projects") ? [{ id: ids.projectId }] : [], getRepository: (entity: unknown) => { assert.equal(entity, AwsAccountBinding); return { findOne: async () => binding, save: async () => { saves++; } }; } };
  const authority = new CustomerAuthorityService({ transaction: async (work: any) => work(manager) } as any, config, { requireRecentVerification: async () => undefined } as any, { record: async (_event: any, supplied: any) => { assert.equal(supplied, manager); auditCount++; } } as any, profiles);
  const actor: any = { id: 91, role: "admin", internalAdminRole: "platform_ops", githubId: null };
  const input = { ...sign(authorityProof), reason: "Unit fixture for final-evidence admission; no provider certification." };
  assert.equal((await authority.import(actor, ids.organizationId, ids.bindingId, input)).alreadyImported, false);
  assert.equal(saves, 1); assert.equal(auditCount, 1);
  assert.equal((await authority.import(actor, ids.organizationId, ids.bindingId, input)).alreadyImported, true);
  assert.equal(saves, 1);
  freshOperator = false; await assert.rejects(() => authority.import(actor, ids.organizationId, ids.bindingId, input)); freshOperator = true;
  archived = true; await assert.rejects(() => authority.import(actor, ids.organizationId, ids.bindingId, input)); archived = false;

  const context: any = { ...ids, accountId: binding.accountId, region: "us-east-1", sourceSha: "a".repeat(40), environmentName: "dev", planFingerprint: "d".repeat(64), deploymentAction: "deploy", configurationFingerprint: "e".repeat(64), credentials: { accessKeyId: "temp-key", secretAccessKey: "temp-secret", sessionToken: "temp-token", expiration: new Date(Date.now()+900000) } };
  const project: any = { id: ids.projectId, ownerUserId: 2, organizationId: ids.organizationId, executionMode: "customer", environmentName: "dev", repositoryFullName: "owner/app", repositoryUrl: "https://github.com/owner/app", githubInstallationId: "1", targetBranch: "main" };
  const user: any = { id: 3, role: "developer", organizationMemberships: [{ organizationId: ids.organizationId, role: "engineer" }] };
  const deployment: any = Object.create(RailpackDeploymentService.prototype);
  deployment.project = async () => project;
  deployment.dataSource = { transaction: async (work: any) => work(manager) };
  deployment.customerAdmission = { context: async () => { const { credentials, ...scope } = context; return scope; } };
  let sessions = 0;
  deployment.customerSessions = { withApprovedDeploymentSession: async (_scope: any, callback: any) => { sessions++; return callback(context); } };
  deployment.customerBinding = {};
  deployment.githubApp = { tokenForRepository: async (userId: number) => { assert.equal(userId, project.ownerUserId); return { token: "private-source-token" }; } };
  let currentSha = context.sourceSha;
  deployment.source = { resolveSourceSha: async () => currentSha };
  deployment.dispatch = async (...args: any[]) => { assert.equal(args[9], context.sourceSha); assert.equal(args[11], context); return { deployment: { state: "accepted" } }; };
  assert.equal((await deployment.deployApproved(user, project.id, ids.planId, context.planFingerprint)).deployment.state, "accepted");
  currentSha = "f".repeat(40); await assert.rejects(() => deployment.deployApproved(user, project.id, ids.planId, context.planFingerprint)); assert.equal(sessions, 1);

  const repository = resolve(__dirname, "../..");
  const executable: any = Object.fromEntries(Object.entries(CONTROL_PLANE_EXECUTABLE_PATHS).map(([name, path]) => [name, readFileSync(join(repository, path), "utf8")]));
  for (const [name, path] of Object.entries({ runtimeVariables: "variables.tf", runtimeOutputs: "outputs.tf", customerCredentialHelper: "prepare-customer-session.sh" })) executable[name] = readFileSync(join(repository, "infrastructure/railpack-runtime", path), "utf8");
  const workflow = readFileSync(join(repository, ".github/workflows/deployguard-reusable.yml"), "utf8");
  const pinned = parsePinnedReusableWorkflow(`owner/control/.github/workflows/deployguard-reusable.yml@${"a".repeat(40)}`);
  assertReusableWorkflowCompatibility(workflow, pinned, generatedCallerWithKeys(renderDeployguardCallerWorkflow(pinned.reference, true)), executable);
  assert.throws(() => assertReusableWorkflowCompatibility(workflow, pinned, undefined, { ...executable, customerCredentialHelper: executable.customerCredentialHelper + "\n# changed" }));
  const denied = await verifyEffectiveWorkflowCapabilities({ send: async () => ({ EvaluationResults: [] }) }, binding.roleArn, { accountId: binding.accountId, region: "us-east-1", projectId: ids.projectId, environmentName: "dev", generationId: ids.operationId, terraformStateBucket: "test-state", vpcId: "vpc-12345678", managedDatabaseEnabled: false }, "deploy", [{ id: "fixture", area: "ecs", paths: ["deploy"], actions: ["ecs:UpdateService"], resources: () => ["*"] }]);
  assert.deepEqual(denied, ["ecs:UpdateService"]);

  const directory = await mkdtemp(join(tmpdir(), "deployguard-customer-workflow-test-"));
  try {
    const aws = join(directory, "aws"), fixture = join(directory, "binding.json"), output = join(directory, "outputs");
    // Mirrors CustomerWorkflowBindingService.materialize: one immutable authorization per approved operation.
    const boundary = authorityProof.executionRoleBoundaryArns[ids.projectId], servicesPayload = Buffer.from("[]").toString("base64"), controlPlaneSha = "c".repeat(40);
    const infrastructure = { vpcId: "vpc-0123456789abcdef0", publicSubnetIds: ["subnet-0123456789abcdef0", "subnet-0fedcba9876543210"], terraformStateBucket: "dg-customer-state", executionRolePermissionsBoundaryArn: boundary };
    const authorization = { planId: ids.planId, planFingerprint: context.planFingerprint, projectId: ids.projectId, operationId: ids.operationId, sourceSha: context.sourceSha, controlPlaneSha, runtimePayloadSha256: createHash("sha256").update(servicesPayload).digest("hex"),
      environment: "dev", deploymentAction: "deploy", configurationFingerprint: context.configurationFingerprint, assumptions: { cpu: .25, memoryMiB: 512, replicas: 1 }, infrastructure, expiresAt };
    const secret = { contractVersion: "deployguard.customer-binding/v1", organizationId: ids.organizationId, bindingId: ids.bindingId, bindingVersion: 3, accountId: binding.accountId, roleArn: binding.roleArn, externalId: "local-external-id-for-scope-test", authorization, authorityProof };
    await writeFile(fixture, JSON.stringify(secret), { mode: 0o600 });
    await writeFile(aws, '#!/bin/sh\ncat "$DG_FIXTURE_BINDING"\n', { mode: 0o700 }); await chmod(aws, 0o700);
    const workload = { contractVersion: "deployguard.customer-workload/v1", ...ids, bindingVersion: 3, roleArn: binding.roleArn, sourceSha: context.sourceSha, environment: "dev", cpu: .25, memoryMiB: 512, replicas: 1, executionRolePermissionsBoundaryArn: boundary };
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, DG_FIXTURE_BINDING: fixture, GITHUB_OUTPUT: output, CUSTOMER_ACCOUNT_ID: binding.accountId, APPROVED_PLAN_ID: ids.planId, APPROVED_PLAN_FINGERPRINT: context.planFingerprint, CUSTOMER_BINDING_SECRET_ARN: `arn:aws:secretsmanager:us-east-1:999999999999:secret:deployguard/customer-operations/${ids.organizationId}/${ids.projectId}/${ids.operationId}-abcdef`, WORKLOAD_BASE64: Buffer.from(JSON.stringify(workload)).toString("base64"), PROJECT_ID: ids.projectId, OPERATION_ID: ids.operationId, SOURCE_SHA: context.sourceSha, ENVIRONMENT_NAME: "dev", AWS_REGION: "us-east-1",
      SERVICES_BASE64: servicesPayload, DEPLOYMENT_ACTION: "deploy", CONTROL_PLANE_SHA: controlPlaneSha, VPC_ID: infrastructure.vpcId, PUBLIC_SUBNET_IDS: [...infrastructure.publicSubnetIds].reverse().join(","), TERRAFORM_STATE_BUCKET: infrastructure.terraformStateBucket };
    const helper = join(repository, "infrastructure/railpack-runtime/prepare-customer-session.sh");
    const stdout = execFileSync("bash", [helper], { cwd: directory, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert(stdout.includes(`::add-mask::${secret.externalId}`));
    assert((await readFile(output, "utf8")).includes(`role_arn=${binding.roleArn}`));
    await writeFile(fixture, JSON.stringify({ ...secret, authorityProof: { ...authorityProof, projectIds: [ids.planId] } }));
    assert.throws(() => execFileSync("bash", [helper], { cwd: directory, env, stdio: "pipe" }));
  } finally { await rm(directory, { recursive: true, force: true }); }
  console.log("Customer execution contracts passed: signed/expired/versioned proof gates, fresh operator and archive denial, owner source credentials, pre-session source drift, pinned workflow integrity and protected role-chain input scope. These are local fixtures, not provider certification.");
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
