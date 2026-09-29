import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { GetRoleCommand, IAMClient, UpdateAssumeRolePolicyCommand } from "@aws-sdk/client-iam";
import { classifyManagedDatabase, ManagedDatabaseReconciliationState as State } from "../src/projects/managed-database-reconciliation";
import { activeTerraformDatabaseAddresses, ManagedDatabaseReconciliationService } from "../src/projects/managed-database-reconciliation.service";
import { ManagedDatabaseReconciliationAdmissionError } from "../src/projects/managed-database-reconciliation.error";
import { DatabaseTierProvider, DatabaseTierStatus } from "../src/projects/project-database-tier.entity";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { classifyStructuredFailure } from "../src/projects/failure-ownership";
import { authorizeGithubRepositoryInTrust, GithubActionsOidcTrustService, githubTrustAuthorizesSubject, githubTrustIncludesSubject, githubTrustUpdateRequired, TrustPolicy } from "../src/projects/github-actions-oidc-trust.service";

const projectId = "11111111-1111-4111-8111-111111111111";
const project = { id: projectId, environmentName: "dev" } as any;
const user = { id: 7 } as any;
const resource = (id: string) => ({ id, identity: "current" as const, owned: true, available: true });
const baseEvidence = {
  managed: true,
  persistenceEnabled: true,
  expectedStorageIdentity: true,
  bindingStatus: "ready",
  bindingFileSystemId: "fs-current",
  bindingAccessPointId: "fsap-current",
  currentFileSystem: resource("fs-current"),
  accessPoint: resource("fsap-current"),
  passwordSecretPresent: true,
  urlSecretPresent: true,
  terraformDatabaseAddresses: ["aws_efs_file_system.database"],
  usableRecoveryPointArn: null,
};
const report = (overrides: Record<string, unknown> = {}) => {
  const evidence = { ...baseEvidence, ...overrides };
  return { ...classifyManagedDatabase(evidence), evidence, tierUpdatedAt: "2026-09-04T00:00:00.000Z", engine: "postgres" as const, attachedServiceId: "33333333-3333-4333-8333-333333333333", identity: { environment: "dev", activeGenerationId: null } };
};

async function main() {
  const immutableSubject = "repo:DeployGuard@100/supported-app@200:*";
  const legacySubject = "repo:DeployGuard/supported-app:*";
  const requiredSubjects = [immutableSubject, legacySubject];
  const trust = (trustedSubjects: string[]): TrustPolicy => ({ Version: "2012-10-17", Statement: [{
    Effect: "Allow",
    Principal: { Federated: "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com" },
    Action: "sts:AssumeRoleWithWebIdentity",
    Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" }, StringLike: { "token.actions.githubusercontent.com:sub": trustedSubjects } },
  }] });
  const wildcardTrust: TrustPolicy = { Version: "2012-10-17", Statement: [{
    Effect: "Allow",
    Principal: { Federated: "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com" },
    Action: "sts:AssumeRoleWithWebIdentity",
    Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" }, StringLike: { "token.actions.githubusercontent.com:sub": "repo:DeployGuard/*:*" } },
  }] };
  assert.equal(githubTrustAuthorizesSubject(wildcardTrust, "repo:DeployGuard/supported-app:*"), true, "an existing wildcard OIDC subject authorizes the repository without a trust-policy write");
  assert.equal(githubTrustAuthorizesSubject(wildcardTrust, "repo:AnotherOwner/supported-app:*"), false, "OIDC wildcard authorization remains owner-scoped");
  assert.throws(() => githubTrustUpdateRequired(wildcardTrust, requiredSubjects, false), /externally managed/, "effective wildcard trust cannot replace the two required exact subjects");
  assert.equal(githubTrustUpdateRequired(wildcardTrust, requiredSubjects, true), true, "platform role mode reconciles missing exact repository subjects");

  const legacyMissing = trust([immutableSubject]);
  assert.equal(authorizeGithubRepositoryInTrust(legacyMissing, requiredSubjects), true);
  assert.equal(githubTrustIncludesSubject(legacyMissing, immutableSubject), true, "immutable subject is preserved");
  assert.equal(githubTrustIncludesSubject(legacyMissing, legacySubject), true, "missing legacy subject is added");
  const immutableMissing = trust([legacySubject]);
  assert.equal(authorizeGithubRepositoryInTrust(immutableMissing, requiredSubjects), true);
  assert.equal(githubTrustIncludesSubject(immutableMissing, legacySubject), true, "legacy subject is preserved");
  assert.equal(githubTrustIncludesSubject(immutableMissing, immutableSubject), true, "missing immutable subject is added");
  const neither = trust(["repo:AnotherOwner/another-repository:*"]);
  assert.equal(authorizeGithubRepositoryInTrust(neither, requiredSubjects), true);
  assert.equal(githubTrustIncludesSubject(neither, immutableSubject), true);
  assert.equal(githubTrustIncludesSubject(neither, legacySubject), true);
  assert.equal(githubTrustIncludesSubject(neither, "repo:AnotherOwner/another-repository:*"), true, "unrelated repository trust is preserved");
  assert.equal((neither.Statement as any[])[0].Principal.Federated, "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com", "GitHub OIDC provider principal is unchanged");
  assert.equal((neither.Statement as any[])[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"], "sts.amazonaws.com", "STS audience validation is unchanged");
  const both = trust(requiredSubjects);
  const unchangedTrust = JSON.stringify(both);
  assert.equal(authorizeGithubRepositoryInTrust(both, requiredSubjects), false, "both existing exact subjects require no mutation");
  assert.equal(JSON.stringify(both), unchangedTrust, "no-op reconciliation preserves the policy byte-for-byte");

  const originalSend = IAMClient.prototype.send; const originalDestroy = IAMClient.prototype.destroy;
  async function exerciseService(initial: TrustPolicy, options: { failUpdate?: boolean; staleVerification?: boolean } = {}) {
    let current = structuredClone(initial); let updates = 0; let gets = 0;
    (IAMClient.prototype as any).send = async (command: unknown) => {
      if (command instanceof GetRoleCommand) {
        gets += 1;
        const returned = options.staleVerification && gets > 1 ? initial : current;
        return { Role: { AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(returned)) } };
      }
      if (command instanceof UpdateAssumeRolePolicyCommand) {
        updates += 1;
        if (options.failUpdate) throw new Error("IAM update failed");
        current = JSON.parse(String(command.input.PolicyDocument));
        return {};
      }
      throw new Error("Unexpected IAM command");
    };
    (IAMClient.prototype as any).destroy = () => undefined;
    const service = new GithubActionsOidcTrustService(new ConfigService({ DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN: "arn:aws:iam::111111111111:role/deployguard", DEPLOYGUARD_GITHUB_ACTIONS_ROLE_MANAGEMENT: "platform", AWS_REGION: "us-east-1" }));
    try { await service.ensureRepositoryAuthorized("DeployGuard/supported-app", requiredSubjects); return { current, updates, gets }; }
    finally { (IAMClient.prototype as any).send = originalSend; (IAMClient.prototype as any).destroy = originalDestroy; }
  }
  const noUpdate = await exerciseService(trust(requiredSubjects));
  assert.equal(noUpdate.updates, 0, "both exact subjects avoid an IAM update");
  const reconciled = await exerciseService(trust([immutableSubject, "repo:AnotherOwner/another-repository:*"]));
  assert.equal(reconciled.updates, 1); assert.equal(reconciled.gets, 2, "updated trust is re-read for verification");
  assert.equal(githubTrustIncludesSubject(reconciled.current, legacySubject), true);
  assert.equal(githubTrustIncludesSubject(reconciled.current, "repo:AnotherOwner/another-repository:*"), true);
  await assert.rejects(() => exerciseService(trust([immutableSubject]), { failUpdate: true }), /could not authorize this repository/i, "IAM update failure fails closed");
  await assert.rejects(() => exerciseService(trust([immutableSubject]), { staleVerification: true }), /could not authorize this repository/i, "post-update verification failure fails closed");
  const invalidService = new GithubActionsOidcTrustService(new ConfigService({ DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN: "arn:aws:iam::111111111111:role/deployguard", DEPLOYGUARD_GITHUB_ACTIONS_ROLE_MANAGEMENT: "platform" }));
  await assert.rejects(() => invalidService.ensureRepositoryAuthorized("DeployGuard/supported-app", [immutableSubject, "repo:*/*:*"]), /could not authorize this repository/i, "broad repository wildcards are rejected before IAM access");

  assert.deepEqual(activeTerraformDatabaseAddresses({ resources: [
    { type: "aws_efs_file_system", name: "database", instances: [{}] },
    { type: "aws_ecs_service", name: "application", instances: [{}] },
    { type: "aws_secretsmanager_secret", name: "database", instances: [] },
  ] }), ["aws_efs_file_system.database"], "only active managed-database Terraform addresses are admitted as persistence evidence");

  const collector = Object.create(ManagedDatabaseReconciliationService.prototype) as any;
  collector.tiers = { findOne: async () => ({
    projectId,
    provider: DatabaseTierProvider.MANAGED,
    persistenceEnabled: true,
    status: DatabaseTierStatus.READY,
    efsFileSystemId: "fs-current",
    efsAccessPointId: "fsap-current",
    activeGenerationId: "22222222-2222-4222-8222-222222222222",
    engine: "postgres",
    attachedServiceId: "33333333-3333-4333-8333-333333333333",
    updatedAt: new Date("2026-09-04T00:00:00.000Z"),
  }) };
  collector.fileSystems = async () => [{ FileSystemId: "fs-current", LifeCycleState: "available", Tags: [
    { Key: "ManagedBy", Value: "DeployGuard" },
    { Key: "DeployGuardProjectId", Value: projectId },
    { Key: "Environment", Value: "dev" },
    { Key: "DeployGuardResource", Value: "managed-database" },
  ] }];
  collector.accessPoint = async () => ({ AccessPointId: "fsap-current", LifeCycleState: "available", Tags: [
    { Key: "ManagedBy", Value: "DeployGuard" },
    { Key: "DeployGuardProjectId", Value: projectId },
    { Key: "Environment", Value: "dev" },
    { Key: "DeployGuardResource", Value: "managed-database" },
  ] });
  collector.secretPresent = async () => true;
  collector.terraformDatabaseAddresses = async () => ["aws_efs_file_system.database"];
  const collectedHealthy = await collector.reconcile(project);
  assert.equal(collectedHealthy.state, State.HEALTHY, "the AWS/control-plane evidence collector feeds the canonical classifier");
  assert.equal(collector.owned([{ Key: "ManagedBy", Value: "DeployGuard" }, { Key: "DeployGuardProjectId", Value: projectId }, { Key: "Environment", Value: "production" }, { Key: "DeployGuardResource", Value: "managed-database" }], projectId, "dev"), false, "another environment's database evidence cannot affect this environment");
  assert.equal(collector.owned([{ Key: "ManagedBy", Value: "DeployGuard" }, { Key: "DeployGuardProjectId", Value: "99999999-9999-4999-8999-999999999999" }, { Key: "Environment", Value: "dev" }, { Key: "DeployGuardResource", Value: "managed-database" }], projectId, "dev"), false, "another project's database evidence cannot affect this project");

  // DatabaseTierService persists a newly configured managed tier as PENDING.
  // Reconcile the actual service path with no durable cloud or state evidence
  // for each supported engine; PENDING alone must not manufacture stale state.
  for (const engine of ["postgres", "mysql", "mongodb"] as const) {
    collector.tiers = { findOne: async () => ({
      projectId, provider: DatabaseTierProvider.MANAGED, persistenceEnabled: true,
      status: DatabaseTierStatus.PENDING, efsFileSystemId: null, efsAccessPointId: null,
      activeGenerationId: null, engine, attachedServiceId: "33333333-3333-4333-8333-333333333333", updatedAt: new Date("2026-09-06T00:00:00.000Z"),
    }) };
    collector.fileSystems = async () => [];
    collector.secretPresent = async () => false;
    collector.terraformDatabaseAddresses = async () => [];
    const fresh = await collector.reconcile(project);
    assert.equal(fresh.evidence.bindingStatus, DatabaseTierStatus.PENDING, `${engine} preserves the configured pending lifecycle status as evidence`);
    assert.equal(fresh.state, State.HEALTHY, `${engine} fresh pending managed tier is healthy`);
    assert.equal(fresh.deploymentAllowed, true, `${engine} fresh pending managed tier admits first provisioning`);
    assert.equal(fresh.resetAllowed, false, `${engine} fresh pending managed tier is never reset-eligible`);
  }
  collector.secretPresent = async () => true;
  const staleOwnedSecret = await collector.reconcile(project);
  assert.equal(staleOwnedSecret.state, State.STALE_METADATA, "an exact project/environment-owned managed database secret remains stale metadata");
  collector.secretPresent = async () => false;
  collector.terraformDatabaseAddresses = async () => ["aws_efs_file_system.database"];
  const staleTerraformState = await collector.reconcile(project);
  assert.equal(staleTerraformState.state, State.STALE_METADATA, "an exact project/environment Terraform database address remains stale metadata");
  collector.terraformDatabaseAddresses = async () => [];
  const freshEvidence = {
    managed: true, persistenceEnabled: true, expectedStorageIdentity: false,
    bindingStatus: DatabaseTierStatus.PENDING, bindingFileSystemId: null, bindingAccessPointId: null,
    currentFileSystem: null, accessPoint: null, passwordSecretPresent: false, urlSecretPresent: false,
    terraformDatabaseAddresses: [], usableRecoveryPointArn: null,
  };
  assert.equal(classifyManagedDatabase(freshEvidence).state, State.HEALTHY, "PENDING alone is not stale metadata");
  assert.equal(classifyManagedDatabase({ ...freshEvidence, passwordSecretPresent: true, urlSecretPresent: true }).state, State.STALE_METADATA, "a durable owned managed-database secret remains stale metadata");
  assert.equal(classifyManagedDatabase({ ...freshEvidence, terraformDatabaseAddresses: ["aws_efs_file_system.database"] }).state, State.STALE_METADATA, "a durable Terraform database address remains stale metadata");

  collector.tiers = { findOne: async () => ({
    projectId, provider: DatabaseTierProvider.NONE, persistenceEnabled: false,
    status: DatabaseTierStatus.NOT_REQUIRED, efsFileSystemId: null, efsAccessPointId: null,
    activeGenerationId: null, engine: null, attachedServiceId: null, updatedAt: new Date("2026-09-06T00:00:00.000Z"),
  }) };
  collector.secretPresent = async () => true;
  collector.terraformDatabaseAddresses = async () => ["aws_efs_file_system.database"];
  const disabledWithDurableEvidence = await collector.reconcile(project);
  assert.equal(disabledWithDurableEvidence.state, State.STALE_METADATA, "provider NONE cannot hide exact owned secret or Terraform database evidence");
  assert.equal(disabledWithDurableEvidence.deploymentAllowed, false, "ordinary Deploy cannot remove partially provisioned managed database resources");

  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.managedDatabaseReconciliation = { reconcile: async () => report() };
  const healthy = await service.managedDatabaseAdmission(project, "DEPLOY", null);
  assert.equal(healthy.databaseReconciliation.state, State.HEALTHY);
  assert.equal(healthy.databaseReconciliation.deploymentAllowed, true, "healthy managed database passes ordinary deployment admission");

  const blockedEvidence: Array<[State, Record<string, unknown>]> = [
    [State.RECOVERABLE, { currentFileSystem: null, accessPoint: null, usableRecoveryPointArn: "arn:aws:backup:us-east-1:111111111111:recovery-point:fixture" }],
    [State.DATA_LOST_RESET_REQUIRED, { currentFileSystem: null, accessPoint: null, usableRecoveryPointArn: null }],
    [State.STALE_METADATA, {
      expectedStorageIdentity: false,
      bindingStatus: null,
      bindingFileSystemId: null,
      bindingAccessPointId: null,
      currentFileSystem: null,
      accessPoint: null,
      terraformDatabaseAddresses: [],
    }],
    [State.IDENTITY_MIGRATION_REQUIRED, { accessPoint: null }],
  ];
  for (const [state, evidence] of blockedEvidence) {
    const blockedReport = report(evidence);
    assert.equal(blockedReport.state, state, `${state} fixture is classified by the canonical reconciler`);
    service.managedDatabaseReconciliation = { reconcile: async () => blockedReport };
    await assert.rejects(() => service.managedDatabaseAdmission(project, "DEPLOY", null), (error: unknown) => error instanceof ManagedDatabaseReconciliationAdmissionError && error.report.state === state, `${state} blocks ordinary deployment admission with its structured state intact`);
  }

  const resettable = report({ currentFileSystem: null, accessPoint: null, usableRecoveryPointArn: null });
  assert.equal(resettable.state, State.DATA_LOST_RESET_REQUIRED);
  const resetAt = service.resetFreshAt(resettable);
  assert.match(resetAt, /^\d{4}-\d{2}-\d{2}T/);
  const resetAdmission = await service.managedDatabaseAdmission(project, "RESET_FRESH", resetAt, resettable);
  assert.equal(resetAdmission.recoveryDecision.deploymentMode, "RESET_FRESH", "explicit reset creates a fresh recovery identity");
  assert.equal(resetAdmission.recoveryDecision.deploymentAllowed, true);
  assert.equal(resetAdmission.resetDatabaseIdentity, true);

  let savedTier: any = null;
  const manager = {
    getRepository: () => ({
      findOne: async () => ({ projectId, provider: "managed", updatedAt: new Date(resettable.tierUpdatedAt) }),
      save: async (value: any) => { savedTier = value; return value; },
    }),
  };
  await service.reconcileResetFreshDatabaseIdentity(manager, user, project, resetAdmission);
  assert.equal(savedTier.activeGenerationId, null);
  assert.equal(savedTier.restoreMetadata.cloudResourcesDeleted, false, "reset reconciliation never deletes healthy/persistent cloud resources");
  assert.equal(savedTier.restoreMetadata.previousReconciliationState, State.DATA_LOST_RESET_REQUIRED);

  const recoverable = report({ currentFileSystem: null, accessPoint: null, usableRecoveryPointArn: "arn:aws:backup:us-east-1:111111111111:recovery-point:fixture" });
  assert.throws(() => service.resetFreshAt(recoverable), ManagedDatabaseReconciliationAdmissionError, "reset-fresh cannot bypass available recovery");
  assert.equal(service.resetFreshAt(report()), null, "healthy persistent database data is preserved");

  const root = join(__dirname, "..", "..");
  const workflow = readFileSync(join(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
  const deployment = readFileSync(join(root, "backend/src/projects/railpack-deployment.service.ts"), "utf8");
  const terraform = readFileSync(join(root, "infrastructure/railpack-runtime/main.tf"), "utf8");
  assert.match(workflow, /terraform .* plan .*\|\| \{ echo 'DG_FAILURE code=DG_TERRAFORM_PLAN_FAILED stage=terraform_plan'/);
  assert.match(workflow, /terraform .* apply[\s\S]{0,500}DG_TERRAFORM_APPLY_FAILED stage=terraform_apply/);
  assert.doesNotMatch(workflow.match(/terraform .* plan[^\n]+/)?.[0] || "", /DG_TERRAFORM_APPLY_FAILED/);
  const buildTargetResolution = deployment.indexOf("resolveBuildTargetsAtExactSha");
  assert.ok(buildTargetResolution >= 0 && deployment.indexOf("managedDatabaseReconciliation.reconcile(project)", buildTargetResolution) > buildTargetResolution, "exact-SHA BuildTarget compatibility precedes managed-database cloud reconciliation");
  assert.match(deployment, /managedDatabaseAdmission\(project, requestedMode, effectiveResetAt, report\)/);
  assert.ok(deployment.indexOf('operation.currentStage = "managed_database_reconciliation"', buildTargetResolution) < deployment.indexOf("managedDatabaseReconciliation.reconcile(project)", buildTargetResolution), "the managed-database stage is persisted before reconciliation executes");
  assert.ok(deployment.indexOf('operation.currentStage = "deployment_requirement_admission"', buildTargetResolution) < deployment.indexOf("resolveRequirementsAtExactSha", buildTargetResolution), "the requirement-admission stage is persisted before requirement resolution executes");
  assert.ok(deployment.indexOf("if (active) return { active };") < deployment.indexOf("reconcileResetFreshDatabaseIdentity(manager, user, project, deployAdmission)"), "reset mutation occurs only after same-project active-operation admission is checked");
  assert.match(deployment, /managedDatabaseReconciliationState/);
  assert.match(deployment, /cloudResourcesDeleted: false/);
  assert.match(terraform, /mysql_grant_reconciler_command/);
  assert.match(terraform, /'deployguard'@'%'/, "the existing MySQL dynamic task-IP grant remains intact");
  assert.deepEqual(classifyStructuredFailure("terraform_plan", "DG_FAILURE code=DG_TERRAFORM_PLAN_FAILED stage=terraform_plan"), { failureOwner: "DEPLOYGUARD_PLATFORM", externalProvider: null, failureCode: "DG_TERRAFORM_PLAN_FAILED", failureServiceId: null });
  assert.deepEqual(classifyStructuredFailure("terraform_apply", "DG_FAILURE code=DG_TERRAFORM_APPLY_FAILED stage=terraform_apply"), { failureOwner: "EXTERNAL_PROVIDER", externalProvider: "aws", failureCode: "DG_TERRAFORM_APPLY_FAILED", failureServiceId: null });
  console.log("LOW_RISK_DEFECT_CLOSURE=PASS DB_ADMISSION_STATES=5 FRESH_PENDING_ENGINES=3 PROJECT_ENVIRONMENT_ISOLATION=1 RESET_FRESH_RECONCILED=1 HEALTHY_DB_PRESERVED=1 TERRAFORM_PLAN_APPLY_SEPARATED=1");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
