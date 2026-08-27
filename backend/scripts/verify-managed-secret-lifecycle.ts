import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  expectedManagedSecrets,
  MANAGED_SECRET_PURGE_POLICY,
  ManagedSecretDescription,
  ManagedSecretLifecyclePort,
  ManagedSecretLifecycleReconciler,
} from "../src/infrastructure/managed-secret-lifecycle.service";

const projectId = "11111111-2222-4333-8444-555555555555";
const arn = (name: string) => `arn:aws:secretsmanager:us-east-1:123456789012:secret:${name}-AbCd12`;
const descriptor = (name: string, purpose: string, environment = "dev", deletionDate: string | null = null): ManagedSecretDescription => ({
  arn: arn(name),
  name,
  deletionDate,
  tags: { ManagedBy: "DeployGuard", DeployGuardProjectId: projectId, Environment: environment, SecretPurpose: purpose },
});

class FakePort implements ManagedSecretLifecyclePort {
  imports: Array<{ address: string; id: string }> = [];
  restores: string[] = [];
  waits = 0;
  constructor(
    readonly secrets: Map<string, ManagedSecretDescription[]>,
    readonly state = new Set<string>(),
  ) {}
  async findExact(name: string) { return this.secrets.get(name) || []; }
  async restore(secretArn: string) {
    this.restores.push(secretArn);
    for (const [name, matches] of this.secrets) {
      this.secrets.set(name, matches.map((secret) => secret.arn === secretArn ? { ...secret, deletionDate: null } : secret));
    }
  }
  async currentVersionId() { return "version-current"; }
  async stateAddresses() { return new Set(this.state); }
  async importResource(address: string, id: string) { this.imports.push({ address, id }); this.state.add(address); }
  async wait() { this.waits += 1; }
}

const variables = (environment = "dev", database = true, appSecrets: Record<string, string> = {}) => ({
  project_id: projectId,
  environment_name: environment,
  database_service: { enabled: database },
  ecs_secret_environment_variables: appSecrets,
});

async function main() {
  assert.equal(MANAGED_SECRET_PURGE_POLICY.activated, false);
  assert.equal(MANAGED_SECRET_PURGE_POLICY.forceDeleteWithoutRecovery, false);
  const database = expectedManagedSecrets(variables());
  assert.equal(database.length, 2);
  assert.equal(database[0].name, `deployguard/${projectId}/dev/database/password`);
  assert.equal(database[0].resourceAddress, "module.database_service.aws_secretsmanager_secret.password[0]");

  const missingPort = new FakePort(new Map());
  const missing = await new ManagedSecretLifecycleReconciler(missingPort, { attempts: 2, intervalMs: 0 }).reconcile(database);
  assert.deepEqual(missing.map((result) => result.initialStatus), ["missing", "missing"]);
  assert.equal(missingPort.imports.length, 0, "a new project must allow Terraform to create initial secrets");

  const password = database[0];
  const activePort = new FakePort(new Map([[password.name, [descriptor(password.name, password.purpose)]]]));
  const active = await new ManagedSecretLifecycleReconciler(activePort, { attempts: 2, intervalMs: 0 }).reconcile([password]);
  assert.equal(active[0].importResult, "secret_and_version");
  assert.deepEqual(activePort.imports.map((item) => item.address), [password.resourceAddress, password.versionAddress]);
  assert.equal(activePort.imports[1].id, `${arn(password.name)}|version-current`);

  const retainedState = new Set([password.resourceAddress, password.versionAddress]);
  const retainedPort = new FakePort(new Map([[password.name, [descriptor(password.name, password.purpose)]]]), retainedState);
  const retained = await new ManagedSecretLifecycleReconciler(retainedPort).reconcile([password]);
  assert.equal(retained[0].importResult, "not_required");
  assert.equal(retainedPort.imports.length, 0);

  const deletingPort = new FakePort(new Map([[password.name, [descriptor(password.name, password.purpose, "dev", "2026-08-09T00:00:00Z")]]]));
  const restored = await new ManagedSecretLifecycleReconciler(deletingPort, { attempts: 2, intervalMs: 0 }).reconcile([password]);
  assert.equal(restored[0].restoreResult, "restored");
  assert.equal(deletingPort.restores.length, 1);
  assert.equal(deletingPort.imports.length, 2);
  const repeated = await new ManagedSecretLifecycleReconciler(deletingPort, { attempts: 2, intervalMs: 0 }).reconcile([password]);
  assert.equal(repeated[0].restoreResult, "not_required");
  assert.equal(repeated[0].importResult, "not_required");
  assert.equal(deletingPort.restores.length, 1, "repeated reconciliation must be idempotent");
  assert.equal(deletingPort.imports.length, 2, "repeated reconciliation must not import or version again");

  for (const environment of ["dev", "production"]) {
    const generated = expectedManagedSecrets(variables(environment, true, { API_TOKEN: "never-log-this-value" }));
    assert.equal(generated.length, 3);
    assert.ok(generated.every((item) => item.name.includes(`/${environment}/`)));
    assert.equal(JSON.stringify(generated).includes("never-log-this-value"), false);
  }
  assert.deepEqual(expectedManagedSecrets(variables("dev", false)), [], "database-disabled deployments must not reconcile database secrets");

  const wrongTags = descriptor(password.name, password.purpose);
  wrongTags.tags.DeployGuardProjectId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const wrongTagsReconciler = new ManagedSecretLifecycleReconciler(
    new FakePort(new Map([[password.name, [wrongTags]]])),
  );
  await assert.rejects(
    wrongTagsReconciler.reconcile([password]),
    /ownership verification/,
  );
  const missingTags = descriptor(password.name, password.purpose);
  delete missingTags.tags.SecretPurpose;
  const missingTagsReconciler = new ManagedSecretLifecycleReconciler(
    new FakePort(new Map([[password.name, [missingTags]]])),
  );
  await assert.rejects(
    missingTagsReconciler.reconcile([password]),
    /ownership verification/,
  );
  const duplicateReconciler = new ManagedSecretLifecycleReconciler(new FakePort(new Map([
    [password.name, [descriptor(password.name, password.purpose), descriptor(password.name, password.purpose)]],
  ])));
  await assert.rejects(duplicateReconciler.reconcile([password]), /ambiguous/);

  const root = join(__dirname, "..");
  const databaseTerraform = await readFile(join(root, "terraform/modules/database-service/main.tf"), "utf8");
  const applicationTerraform = await readFile(join(root, "terraform/modules/ecs-service/main.tf"), "utf8");
  for (const purpose of ["database_password", "database_url"]) assert.match(databaseTerraform, new RegExp(`SecretPurpose\\s+= "${purpose}"`));
  assert.equal((databaseTerraform.match(/ignore_changes = \[secret_string\]/g) || []).length, 2);
  assert.ok(applicationTerraform.includes('recovery_window_in_days = 7'));
  assert.match(applicationTerraform, /SecretPurpose\s+= "application_\$\{each\.key\}"/);
  assert.ok(applicationTerraform.includes("ignore_changes = [secret_string]"));
  assert.equal(`${databaseTerraform}\n${applicationTerraform}`.includes("force_delete_without_recovery"), false);

  console.log("Managed Secrets Manager reconciliation checks passed: creation, ownership, restore/import, idempotency, and version no-op without loading retired mutation services.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Managed-secret lifecycle verification failed.");
  process.exitCode = 1;
});
