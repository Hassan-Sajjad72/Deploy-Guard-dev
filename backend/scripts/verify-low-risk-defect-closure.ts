import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConflictException } from "@nestjs/common";
import { classifyManagedDatabase, ManagedDatabaseReconciliationState as State } from "../src/projects/managed-database-reconciliation";
import { activeTerraformDatabaseAddresses, ManagedDatabaseReconciliationService } from "../src/projects/managed-database-reconciliation.service";
import { DatabaseTierProvider, DatabaseTierStatus } from "../src/projects/project-database-tier.entity";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { classifyStructuredFailure } from "../src/projects/failure-ownership";

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
  return { ...classifyManagedDatabase(evidence), evidence, tierUpdatedAt: "2026-09-04T00:00:00.000Z", identity: { environment: "dev", activeGenerationId: null } };
};

async function main() {
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
    updatedAt: new Date("2026-09-04T00:00:00.000Z"),
  }) };
  collector.fileSystems = async () => [{ FileSystemId: "fs-current", LifeCycleState: "available", Tags: [
    { Key: "ManagedBy", Value: "DeployGuard" },
    { Key: "DeployGuardProjectId", Value: projectId },
    { Key: "DeployGuardResource", Value: "managed-database" },
  ] }];
  collector.accessPoint = async () => ({ AccessPointId: "fsap-current", LifeCycleState: "available", Tags: [
    { Key: "ManagedBy", Value: "DeployGuard" },
    { Key: "DeployGuardProjectId", Value: projectId },
    { Key: "DeployGuardResource", Value: "managed-database" },
  ] });
  collector.secretPresent = async () => true;
  collector.terraformDatabaseAddresses = async () => ["aws_efs_file_system.database"];
  const collectedHealthy = await collector.reconcile(project);
  assert.equal(collectedHealthy.state, State.HEALTHY, "the AWS/control-plane evidence collector feeds the canonical classifier");

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
    await assert.rejects(() => service.managedDatabaseAdmission(project, "DEPLOY", null), (error: unknown) => error instanceof ConflictException, `${state} blocks ordinary deployment admission`);
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
  assert.throws(() => service.resetFreshAt(recoverable), ConflictException, "reset-fresh cannot bypass available recovery");
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
  assert.ok(deployment.indexOf("if (active) return { active };") < deployment.indexOf("reconcileResetFreshDatabaseIdentity(manager, user, project, deployAdmission)"), "reset mutation occurs only after same-project active-operation admission is checked");
  assert.match(deployment, /managedDatabaseReconciliationState/);
  assert.match(deployment, /cloudResourcesDeleted: false/);
  assert.match(terraform, /mysql_grant_reconciler_command/);
  assert.match(terraform, /'deployguard'@'%'/, "the existing MySQL dynamic task-IP grant remains intact");
  assert.deepEqual(classifyStructuredFailure("terraform_plan", "DG_FAILURE code=DG_TERRAFORM_PLAN_FAILED stage=terraform_plan"), { failureOwner: "DEPLOYGUARD_PLATFORM", externalProvider: null, failureCode: "DG_TERRAFORM_PLAN_FAILED", failureServiceId: null });
  assert.deepEqual(classifyStructuredFailure("terraform_apply", "DG_FAILURE code=DG_TERRAFORM_APPLY_FAILED stage=terraform_apply"), { failureOwner: "EXTERNAL_PROVIDER", externalProvider: "aws", failureCode: "DG_TERRAFORM_APPLY_FAILED", failureServiceId: null });
  console.log("LOW_RISK_DEFECT_CLOSURE=PASS DB_ADMISSION_STATES=5 RESET_FRESH_RECONCILED=1 HEALTHY_DB_PRESERVED=1 TERRAFORM_PLAN_APPLY_SEPARATED=1");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
