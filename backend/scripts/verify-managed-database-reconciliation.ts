import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyManagedDatabase,
  ManagedDatabaseReconciliationEvidence,
  ManagedDatabaseReconciliationState as State,
} from "../src/projects/managed-database-reconciliation";
import {
  activeTerraformDatabaseAddresses,
  selectManagedDatabaseFileSystem,
} from "../src/projects/managed-database-reconciliation.service";
import { managedDatabaseEfsCreationToken } from "../src/projects/managed-database-identity";

const resource = (id: string) => ({ id, identity: "current" as const, owned: true, available: true });
const base: ManagedDatabaseReconciliationEvidence = {
  managed: true,
  persistenceEnabled: true,
  expectedStorageIdentity: true,
  bindingStatus: "verified",
  bindingFileSystemId: "fs-current",
  bindingAccessPointId: "fsap-current",
  currentFileSystem: resource("fs-current"),
  accessPoint: resource("fsap-current"),
  passwordSecretPresent: true,
  urlSecretPresent: true,
  terraformDatabaseAddresses: ["aws_efs_file_system.database", "aws_efs_access_point.database"],
  usableRecoveryPointArn: null,
};

assert.equal(classifyManagedDatabase(base).state, State.HEALTHY, "healthy retained database may deploy");
assert.equal(classifyManagedDatabase({ ...base, terraformDatabaseAddresses: [] }).state, State.HEALTHY, "retained resources remain healthy after normal destroy state exclusion");
assert.equal(classifyManagedDatabase({ ...base, currentFileSystem: null, accessPoint: null, usableRecoveryPointArn: "arn:aws:backup:us-east-1:111111111111:recovery-point:fixture" }).state, State.RECOVERABLE);
assert.equal(classifyManagedDatabase({ ...base, currentFileSystem: null, accessPoint: null }).state, State.DATA_LOST_RESET_REQUIRED);
assert.equal(classifyManagedDatabase({
  ...base,
  expectedStorageIdentity: false,
  bindingStatus: null,
  bindingFileSystemId: null,
  bindingAccessPointId: null,
  currentFileSystem: null,
  accessPoint: null,
  terraformDatabaseAddresses: [],
}).state, State.STALE_METADATA, "secret existence alone is stale evidence, never proof of storage");
assert.equal(classifyManagedDatabase({
  ...base,
  expectedStorageIdentity: false,
  bindingStatus: "ready",
  bindingFileSystemId: "fs-stale",
  bindingAccessPointId: "fsap-stale",
  currentFileSystem: null,
  accessPoint: null,
  passwordSecretPresent: false,
  urlSecretPresent: false,
  terraformDatabaseAddresses: [],
}).state, State.STALE_METADATA, "a binding without verified storage is stale metadata, not cloud persistence evidence");
assert.equal(classifyManagedDatabase({ ...base, managed: false, persistenceEnabled: false, expectedStorageIdentity: false, bindingStatus: null, bindingFileSystemId: null, bindingAccessPointId: null, currentFileSystem: null, accessPoint: null, passwordSecretPresent: false, urlSecretPresent: false, terraformDatabaseAddresses: [] }).state, State.HEALTHY);
assert.equal(classifyManagedDatabase({ ...base, persistenceEnabled: false }).state, State.STALE_METADATA);
assert.equal(classifyManagedDatabase({ ...base, expectedStorageIdentity: false, bindingStatus: null, bindingFileSystemId: null, bindingAccessPointId: null, currentFileSystem: null, accessPoint: null, passwordSecretPresent: false, urlSecretPresent: false, terraformDatabaseAddresses: [] }).state, State.HEALTHY, "initial provisioning remains allowed");

const projectId = "87a44322-ef32-47f2-a0b1-f9682da91937";
const environment = "dev";
const creationToken = managedDatabaseEfsCreationToken(projectId, environment);
const ownedTags = [
  { Key: "ManagedBy", Value: "DeployGuard" },
  { Key: "DeployGuardProjectId", Value: projectId },
  { Key: "Environment", Value: environment },
  { Key: "Persistence", Value: "project" },
];
const existingProjectDatabase = {
  FileSystemId: "fs-project",
  CreationToken: creationToken,
  LifeCycleState: "available",
  Tags: ownedTags,
};
assert.equal(
  creationToken,
  "dg-efs-87a44322-cc1dc6c6028be0e3f948b24a30ead084504828a4",
  "backend discovery identity must be byte-compatible with the workflow Terraform formula",
);
assert.equal(
  selectManagedDatabaseFileSystem([existingProjectDatabase], "fs-project", creationToken, projectId, environment)?.FileSystemId,
  "fs-project",
  "an authoritative project binding is reusable by a new application generation",
);
assert.equal(
  selectManagedDatabaseFileSystem([existingProjectDatabase], null, creationToken, projectId, environment)?.FileSystemId,
  "fs-project",
  "stale generation/release metadata cannot hide valid project-scoped persistence",
);
assert.equal(
  selectManagedDatabaseFileSystem([], "fs-missing", creationToken, projectId, environment),
  null,
  "a missing persistent resource remains unavailable",
);
assert.equal(
  selectManagedDatabaseFileSystem([{ ...existingProjectDatabase, Tags: ownedTags.map((tag) => tag.Key === "DeployGuardProjectId" ? { ...tag, Value: "another-project" } : tag) }], null, creationToken, projectId, environment),
  null,
  "a creation-token match cannot adopt persistence owned by another project",
);

assert.deepEqual(activeTerraformDatabaseAddresses({ resources: [
  { type: "aws_efs_file_system", name: "database", instances: [] },
  { type: "aws_secretsmanager_secret", name: "database_password", instances: [] },
  { type: "aws_cloudwatch_log_group", name: "database", instances: [{ attributes: { id: "/deployguard/project/database" } }] },
] }), [], "count-zero database configuration is not persistent Terraform state");
assert.deepEqual(activeTerraformDatabaseAddresses({ resources: [
  { type: "aws_efs_file_system", name: "database", instances: [{ attributes: { id: "fs-current" } }] },
  { type: "aws_ecs_cluster", name: "app", instances: [{ attributes: { id: "cluster" } }] },
] }), ["aws_efs_file_system.database"], "an instantiated database resource remains authoritative state evidence");

const smartRetailRegression = classifyManagedDatabase({
  ...base,
  bindingFileSystemId: "fs-01d3d208fee6867e4",
  bindingAccessPointId: "fsap-0cf469906db2de01e",
  currentFileSystem: null,
  accessPoint: null,
  usableRecoveryPointArn: null,
});
assert.equal(smartRetailRegression.state, State.DATA_LOST_RESET_REQUIRED);
assert.equal(smartRetailRegression.deploymentAllowed, false);
assert.equal(smartRetailRegression.resetAllowed, true);
assert.match(smartRetailRegression.message, /no backup exists/i);

const root = resolve(__dirname, "../..");
const deployment = readFileSync(resolve(root, "backend/src/projects/github-actions-deployment.service.ts"), "utf8");
const reset = readFileSync(resolve(root, "backend/src/projects/managed-database-reset.service.ts"), "utf8");
const collector = readFileSync(resolve(root, "backend/src/projects/managed-database-reconciliation.service.ts"), "utf8");
const controller = readFileSync(resolve(root, "backend/src/projects/projects.controller.ts"), "utf8");
const ui = readFileSync(resolve(root, "frontend/src/components/projects/DatabaseTierSettings.jsx"), "utf8");
const dispatch = deployment.slice(deployment.indexOf("private async dispatch("), deployment.indexOf("private async redispatch("));
assert.ok(dispatch.indexOf("managedDatabaseReconciliation.reconcile(project)") < dispatch.indexOf("ensureWorkflow(user.id"), "database drift blocks before caller updates or dispatch");
assert.match(reset, /confirmationPhrase !== "RESET MANAGED DATABASE"/);
assert.match(reset, /--force-delete-without-recovery/);
assert.match(reset, /ManagedBy.*DeployGuard[\s\S]*DeployGuardProjectId[\s\S]*Environment/);
assert.match(reset, /RESETTABLE_STATE_TYPES/);
assert.doesNotMatch(reset, /create-file-system|create-access-point|terraform apply/i, "reset never provisions replacement storage");
assert.match(collector, /list-recovery-points-by-resource/);
assert.match(collector, /get-backup-plan/);
assert.match(collector, /list-backup-selections/);
assert.match(controller, /Post\(":projectId\/database-reset"\)/);
assert.match(ui, /Reset &amp; Deploy Fresh/);
assert.match(ui, /Recoverable backup/);

console.log("Managed database reconciliation checks passed: generic healthy, retained deployment, recoverable, data-loss, stale-secret, disabled-persistence and Smart Retail fixtures.");
