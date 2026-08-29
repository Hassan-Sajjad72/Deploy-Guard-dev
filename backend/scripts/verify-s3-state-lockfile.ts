import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigService } from "@nestjs/config";
import { TerraformStateService } from "../src/state-management/terraform-state.service";
import { StateCorruptionService } from "../src/state-management/state-corruption.service";
import { StateValidationStatus } from "../src/state-management/project-state-validation-result.entity";

const config = (values: Record<string, string>) => ({
  get: <T>(key: string, defaultValue?: T) => (values[key] ?? defaultValue) as T,
}) as ConfigService;

const awsCli = { run: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }) };
const service = (values: Record<string, string>) => new TerraformStateService(
  null as never,
  config(values),
  awsCli as never
);

async function verify() {
  const workflow = readFileSync(resolve(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
  assert.match(workflow, /terraform_version: 1\.10\.5/);
  assert.match(workflow, /-backend-config="key=projects\/\$PROJECT_ID\/\$ENVIRONMENT_NAME\/\$GENERATION_ID\/terraform\.tfstate"/);
  assert.match(workflow, /-backend-config="use_lockfile=true"/);
  assert.doesNotMatch(workflow, /-lock=false/);
  const remote = service({
    STATE_MOCK_MODE: "false",
    TERRAFORM_STATE_BUCKET: "deployguard-state-bucket",
    TERRAFORM_STATE_REGION: "us-east-1",
    TERRAFORM_STATE_PREFIX: "projects",
    TERRAFORM_STATE_USE_LOCKFILE: "true",
  });
  const project = { id: "project-123" } as never;
  assert.equal(remote.buildStateKey(project), "projects/project-123/dev/project/terraform.tfstate");
  assert.equal(remote.buildStateKey(project, "dev", "11111111-1111-4111-8111-111111111111"), "projects/project-123/dev/11111111-1111-4111-8111-111111111111/terraform.tfstate");
  const backend = remote.generateTerraformBackendConfig(project);
  assert.match(backend, /bucket = "deployguard-state-bucket"/);
  assert.match(backend, /key = "projects\/project-123\/dev\/project\/terraform\.tfstate"/);
  assert.match(backend, /region = "us-east-1"/);
  assert.match(backend, /encrypt = true/);
  assert.match(backend, /use_lockfile = true/);
  assert(!backend.includes("dynamodb_table"));

  const calls: string[][] = [];
  const preflight = new TerraformStateService(
    null as never,
    config({
      STATE_MOCK_MODE: "false",
      TERRAFORM_STATE_BUCKET: "deployguard-state-bucket",
      TERRAFORM_STATE_REGION: "us-east-1",
      TERRAFORM_STATE_PREFIX: "projects",
      TERRAFORM_STATE_USE_LOCKFILE: "true",
    }),
    { run: async (args: string[]) => {
      calls.push(args);
      if (args.includes("head-object")) throw new Error("An error occurred (404) when calling the HeadObject operation: Not Found");
      if (args.includes("get-bucket-versioning")) return { stdout: JSON.stringify({ Status: "Enabled" }), stderr: "" };
      return { stdout: "{}", stderr: "" };
    } } as never
  );
  const validated = await preflight.validateRemoteBackend(project);
  assert.equal(validated.mode, "s3");
  assert.equal(validated.lockfileKey, "projects/project-123/dev/project/terraform.tfstate.tflock");
  assert(calls.some((args) => args.includes("head-bucket")));
  assert(calls.some((args) => args.includes("head-object") && args.includes("projects/project-123/dev/project/terraform.tfstate.tflock")));
  assert(!calls.some((args) => args.some((value) => /dynamodb|put-bucket/i.test(value))));

  let savedState: Record<string, unknown> | null = null;
  const backupService = new TerraformStateService(
    {
      findOne: async () => null,
      create: (value: Record<string, unknown>) => ({ ...value }),
      save: async (value: Record<string, unknown>) => { savedState = value; return value; },
    } as never,
    config({
      STATE_MOCK_MODE: "false",
      TERRAFORM_STATE_BUCKET: "deployguard-state-bucket",
      TERRAFORM_STATE_REGION: "us-east-1",
      TERRAFORM_STATE_PREFIX: "projects",
      TERRAFORM_STATE_USE_LOCKFILE: "true",
    }),
    { run: async (args: string[]) => {
      if (args.includes("get-bucket-versioning")) return { stdout: JSON.stringify({ Status: "Enabled" }), stderr: "" };
      if (args.includes("head-object")) {
        const key = args[args.indexOf("--key") + 1];
        if (key.endsWith(".tflock")) throw new Error("An error occurred (404) when calling the HeadObject operation: Not Found");
        return { stdout: JSON.stringify({ VersionId: "state-version-42" }), stderr: "" };
      }
      return { stdout: "{}", stderr: "" };
    } } as never
  );
  const backup = await backupService.recordDestroyStateBackup({ project, environmentName: "dev", pipelineRunId: "run-1", operationId: "destroy-1" });
  assert.equal(backup.versionId, "state-version-42");
  assert.equal(backup.stateKey, "projects/project-123/dev/project/terraform.tfstate");
  assert.equal((savedState as Record<string, unknown>).currentVersionId, "state-version-42");
  assert.equal(((savedState as Record<string, unknown>).metadata as { destroyStateBackup: { operationId: string } }).destroyStateBackup.operationId, "destroy-1");

  const unversioned = new TerraformStateService(
    null as never,
    config({ STATE_MOCK_MODE: "false", TERRAFORM_STATE_BUCKET: "deployguard-state-bucket", TERRAFORM_STATE_REGION: "us-east-1", TERRAFORM_STATE_PREFIX: "projects", TERRAFORM_STATE_USE_LOCKFILE: "true" }),
    { run: async (args: string[]) => args.includes("get-bucket-versioning") ? { stdout: JSON.stringify({ Status: "Suspended" }), stderr: "" } : { stdout: "{}", stderr: "" } } as never
  );
  await assert.rejects(() => unversioned.validateDestroyBackend(project), /Terraform state bucket versioning is not enabled/);

  const staleCalls: string[][] = [];
  const stale = new TerraformStateService(
    null as never,
    config({
      STATE_MOCK_MODE: "false",
      TERRAFORM_STATE_BUCKET: "deployguard-state-bucket",
      TERRAFORM_STATE_REGION: "us-east-1",
      TERRAFORM_STATE_PREFIX: "projects",
      TERRAFORM_STATE_USE_LOCKFILE: "true",
      STATE_LOCK_STALE_AFTER_SECONDS: "300",
    }),
    { run: async (args: string[]) => {
      staleCalls.push(args);
      if (args.includes("get-bucket-versioning")) return { stdout: JSON.stringify({ Status: "Enabled" }), stderr: "" };
      if (args.includes("head-object")) return { stdout: JSON.stringify({ LastModified: "2020-01-01T00:00:00.000Z" }), stderr: "" };
      return { stdout: "{}", stderr: "" };
    } } as never
  );
  await assert.rejects(
    () => stale.validateRemoteBackend(project),
    /Terraform S3 lockfile exists and may be stale\. Lockfile: projects\/project-123\/dev\/project\/terraform\.tfstate\.tflock/
  );
  const cleared = await stale.clearStaleNativeLockfile(project);
  assert.equal(cleared.cleared, true);
  assert(staleCalls.some((args) => args.includes("delete-object") && args.includes("projects/project-123/dev/project/terraform.tfstate.tflock")));

  const inaccessible = new TerraformStateService(
    null as never,
    config({ STATE_MOCK_MODE: "false", TERRAFORM_STATE_BUCKET: "deployguard-state-bucket", TERRAFORM_STATE_REGION: "us-east-1" }),
    { run: async () => { throw new Error("An error occurred (AccessDenied) when calling the HeadBucket operation"); } } as never
  );
  await assert.rejects(
    () => inaccessible.ensureStateBucket(),
    { message: "AWS credentials cannot access Terraform state bucket or lockfile." }
  );

  const fallbackRegion = service({
    STATE_MOCK_MODE: "false",
    TERRAFORM_STATE_BUCKET: "deployguard-state-bucket",
    AWS_REGION: "eu-west-1",
  });
  assert.match(fallbackRegion.generateTerraformBackendConfig(project), /region = "eu-west-1"/);

  const missingRegion = service({
    STATE_MOCK_MODE: "false",
    TERRAFORM_STATE_BUCKET: "deployguard-state-bucket",
  });
  assert.throws(
    () => missingRegion.generateTerraformBackendConfig(project),
    { message: "Terraform state region is not configured." }
  );

  let mockAwsCalls = 0;
  const mock = new TerraformStateService(
    null as never,
    config({ STATE_MOCK_MODE: "true" }),
    { run: async () => { mockAwsCalls += 1; return { stdout: "{}", stderr: "", exitCode: 0 }; } } as never
  );
  await mock.ensureStateBucket();
  await mock.validateRemoteBackend(project);
  assert.equal(JSON.parse(await mock.getStateObject(project)).resources.length, 0);
  assert.equal(mockAwsCalls, 0);

  const stateWithModules = JSON.stringify({
    version: 4,
    serial: 2,
    resources: [
      { module: "module.network", mode: "managed", type: "aws_vpc", name: "main", instances: [{}] },
      { module: "module.app", mode: "managed", type: "aws_subnet", name: "private", instances: [{ dependencies: ["module.network.aws_vpc.main"] }] },
      { mode: "data", type: "aws_caller_identity", name: "current", instances: [{}] },
      { mode: "managed", type: "aws_iam_role", name: "task", instances: [{ dependencies: ["data.aws_caller_identity.current"] }] },
    ],
  });
  const results: Array<Record<string, unknown>> = [];
  const corruption = new StateCorruptionService(
    { create: (value: unknown) => value, save: async (value: Record<string, unknown>) => { results.push(value); return { id: "validation-1", ...value }; } } as never,
    { findOne: async () => null, save: async (value: unknown) => value } as never,
    config({ STATE_RESOURCE_DROP_WARNING_PERCENT: "70" }),
    mock
  );
  assert.equal(corruption.validateDependencyGraph(stateWithModules), true);
  const advisoryState = JSON.stringify({ version: 4, serial: 3, resources: [{ mode: "managed", type: "aws_instance", name: "app", instances: [{ dependencies: ["aws_security_group.missing"] }] }] });
  const advisory = await corruption.detectCorruption("project-123", "dev", advisoryState, false);
  assert.equal(advisory.status, StateValidationStatus.WARNING);
  assert.equal(advisory.jsonSchemaValid, true);
  assert.equal(advisory.checksumValid, true);
  assert.equal(advisory.resourceCountValid, true);
  assert.equal(advisory.dependencyGraphValid, false);
  console.log("S3 native Terraform state lockfile verification passed");
}

verify().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
