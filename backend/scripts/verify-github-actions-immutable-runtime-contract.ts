import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repository = join(__dirname, "../..");
const workflow = join(repository, ".github/workflows/deployguard-reusable.yml");
const root = mkdtempSync(join(tmpdir(), "deployguard-immutable-runtime-"));
const projectId = "11111111-2222-4333-8444-555555555555";
const generationId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const operationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function runtime(operation: string) {
  return { schemaVersion: 1, configurationSnapshotId: "22222222-3333-4444-8555-666666666666", configurationFingerprint: "a".repeat(64), projectId, environmentName: "dev", generationId, generationStateKey: `projects/${projectId}/dev/${generationId}/terraform.tfstate`, platformFoundation: { vpcId: "vpc-12345678", publicSubnetIds: ["subnet-11111111", "subnet-22222222"], ecsClusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/deployguard", ecsClusterName: "deployguard", albArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/deployguard/1234567890abcdef", albDnsName: "deployguard.example.test", listenerArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/deployguard/1234567890abcdef/1234567890abcdef", albSecurityGroupId: "sg-12345678" }, routing: { listenerPriority: 1001, verificationPriority: 21001, productionHost: "p.example.test", candidateHost: "g.example.test" }, projectPersistence: { stateKey: `projects/${projectId}/dev/project/terraform.tfstate`, ecrRepositoryName: "deployguard-fixture", runtimeSecretName: "deployguard/fixture/runtime", ownershipScope: "project" }, retiredGenerationCleanup: null, environment: {}, secretReferences: {}, componentRuntime: { application: { environment: { HOST: "0.0.0.0", PORT: "5000", NODE_ENV: "production", DEPLOYGUARD_PROJECT_ID: projectId, DEPLOYGUARD_GENERATION_ID: generationId, DEPLOYGUARD_ENVIRONMENT: "dev", DEPLOYGUARD_OPERATION_ID: operation }, secretReferences: {} } }, deploymentContext: { schemaVersion: 1, deploymentMode: "FRESH", persistentState: "NONE", recoveryState: "NOT_REQUIRED", recoveryRequired: false, recoveryEvidenceAvailable: false, persistentPreviouslyEstablished: false, deploymentAllowed: true, reason: "fixture" }, retentionProtectedRelease: { imageDigests: [], taskDefinitionArns: [] }, promotion: { contractVersion: "deployguard.promotion-intent/v1", operationId, projectId, environmentName: "dev", generationId, candidate: null, previousLiveGenerationId: null, previousTargetGroupArn: null, previousListenerRuleArn: null, previousProductionUrl: null, intentFingerprint: null }, managedDatabase: null };
}

function run(commit: string, configuration: ReturnType<typeof runtime>) {
  const plan = { planVersion: 2, detectorVersion: "fixture", platformBackendMount: "/__deployguard/backend", repositoryFullName: "fixture/repository", branch: "main", commitSha: commit, appRoot: ".", port: 5000, healthPath: "/health", dockerTemplate: "flask", outputDirectory: null, environmentOwnership: [], requiredInputs: [], components: [{ id: "application", role: "application", root: ".", buildContext: ".", repositoryInstallRoot: ".", port: 5000, healthPath: "/health", healthCheckMode: "http", dockerTemplate: "flask", outputDirectory: null }], relationships: [], serviceBindings: [] };
  const extractor = join(root, "extract.py");
  writeFileSync(extractor, "import sys,yaml\ndoc=yaml.safe_load(open(sys.argv[1]))\nprint(next(s['run'] for s in doc['jobs']['deploy']['steps'] if s.get('name') == 'Validate immutable operation contract'))\n");
  const script = execFileSync("python3", [extractor, workflow], { encoding: "utf8" })
    .replace(/\$\{\{ inputs\.repository_full_name \}\}/g, "fixture/repository").replace(/\$\{\{ inputs\.repository_branch \}\}/g, "main").replace(/\$\{\{ inputs\.commit_sha \}\}/g, commit).replace(/\$\{\{ inputs\.image_tag \}\}/g, "0123456789ab-ABCDEFGHIJKL").replace(/\$\{\{ inputs\.detection_profile_version \}\}/g, "fixture").replace(/\$\{\{ inputs\.deployment_contract_version \}\}/g, "fixture");
  mkdirSync(join(root, ".deployguard"), { recursive: true });
  writeFileSync(join(root, "validate.sh"), script);
  return spawnSync("bash", ["validate.sh"], { cwd: root, encoding: "utf8", env: { ...process.env, DEPLOYMENT_ACTION: "deploy", GITHUB_REPOSITORY: "fixture/repository", GITHUB_REF_NAME: "main", GITHUB_ENV: join(root, "github.env"), PROJECT_ID: projectId, ENVIRONMENT_NAME: "dev", OPERATION_ID: operationId, APP_PORT: "5000", HEALTH_CHECK_PATH: "/health", APPLICATION_ROOT: ".", CONTAINER_PROFILE: "flask", OUTPUT_DIRECTORY: "", INFRASTRUCTURE_NAMESPACE: `/deployguard/${projectId}/dev/${generationId}`, BUILD_PLAN_BASE64: Buffer.from(JSON.stringify(plan)).toString("base64"), ENVIRONMENT_REFERENCES_BASE64: Buffer.from(JSON.stringify(configuration)).toString("base64") } });
}

try {
  writeFileSync(join(root, "README"), "fixture");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "fixture"], { cwd: root });
  execFileSync("git", ["add", "README"], { cwd: root }); execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const valid = run(commit, runtime(operationId));
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
  const mismatch = run(commit, runtime("ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb"));
  assert.notEqual(mismatch.status, 0, "a component operation mismatch must fail immutable validation");
  assert.match(`${mismatch.stdout}\n${mismatch.stderr}`, /Invalid immutable runtime configuration references/);
  console.log("PASS executable reusable-workflow validation accepts empty global environment with canonical component runtime identity and rejects a mismatched component operation.");
} finally { rmSync(root, { recursive: true, force: true }); }
