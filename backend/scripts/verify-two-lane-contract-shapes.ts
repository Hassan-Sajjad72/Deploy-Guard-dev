import { strict as assert } from "node:assert";
import { canonicalJson, canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import {
  validateInfrastructureManifestCreate,
  validateReleaseManifestCreate,
} from "../src/orchestration-contracts/contracts/manifest.validator";

const projectId = "11111111-1111-4111-8111-111111111111";
const infrastructureManifestId = "22222222-2222-4222-8222-222222222222";
const sha = "a".repeat(64);

const desiredSpec = {
  region: "us-east-1",
  terraformTemplateVersion: "v1",
  network: {
    topology: "managed_vpc",
    availabilityZoneCount: 2,
    publicSubnets: true,
    privateSubnets: true,
    natMode: "single",
  },
  registry: {
    managedEcrRepository: true,
    immutableTags: true,
    lifecyclePolicyHash: null,
  },
  ecsFoundation: {
    clusterMode: "shared_project",
    serviceName: "deployguard-app",
    launchType: "fargate",
    capacityProviders: ["FARGATE"],
  },
  ingress: {
    enabled: true,
    protocol: "HTTP",
    containerPort: 3000,
    targetGroupPort: 3000,
    healthCheckPath: "/api/health",
    healthCheckProtocol: "HTTP",
  },
  database: {
    mode: "none",
    engine: null,
    tierRevision: null,
    persistence: false,
    externalTlsRequired: null,
  },
  storage: {
    efsRequired: false,
    accessPointRequired: false,
    encrypted: true,
    backupRequired: false,
  },
  discovery: {
    cloudMapRequired: false,
    namespace: null,
  },
  observability: {
    cloudWatchLogs: true,
    cloudWatchMetrics: true,
    prometheus: false,
  },
  iamPolicyRevision: "v1",
  tags: { managedBy: "DeployGuard" },
};

const infrastructureInput = {
  schemaVersion: 1,
  projectId,
  environmentName: "production",
  origin: "planner",
  terraformTemplateVersion: "v1",
  stateBackend: "s3",
  stateKey: `projects/${projectId}/terraform.tfstate`,
  desiredSpec,
  changeSet: {
    fromManifestId: null,
    changedPaths: ["network"],
    categories: ["network"],
    destructivePaths: [],
    requiresApproval: true,
    reasonCodes: ["INITIAL_INFRASTRUCTURE"],
  },
  requiresTerraform: true,
  specHash: canonicalSha256(desiredSpec),
};

const releaseSpec = {
  source: {
    repositoryFullName: "example/web-app",
    branch: "main",
    commitSha: "b".repeat(40),
    appRoot: ".",
  },
  build: {
    dockerStrategy: "generated",
    dockerTemplate: "node-server-v1",
    buildCommand: "npm run build",
    outputDirectory: null,
    buildArgumentNames: [],
  },
  runtime: {
    imageUri: null,
    imageDigest: null,
    command: "npm start",
    containerPort: 3000,
    cpu: 256,
    memory: 512,
    plainVariableNames: ["NODE_ENV"],
    secretReferenceNames: ["DATABASE_URL"],
    serviceBindingRevisions: [],
  },
  health: {
    path: "/api/health",
    expectedPort: 3000,
    gracePeriodSeconds: 60,
  },
};

const releaseInput = {
  schemaVersion: 1,
  projectId,
  environmentName: "production",
  infrastructureManifestId,
  origin: "planner",
  repositoryFullName: releaseSpec.source.repositoryFullName,
  branch: releaseSpec.source.branch,
  commitSha: releaseSpec.source.commitSha,
  appRoot: releaseSpec.source.appRoot,
  deploymentContractHash: sha,
  configurationFingerprint: sha,
  buildFingerprint: sha,
  runtimeFingerprint: sha,
  releaseSpec,
  specHash: canonicalSha256(releaseSpec),
};

assert.equal(validateInfrastructureManifestCreate(infrastructureInput).projectId, projectId);
assert.equal(
  validateReleaseManifestCreate(releaseInput).infrastructureManifestId,
  infrastructureManifestId,
);
assert.equal(
  canonicalJson({ z: 1, a: { y: 2, x: 1 } }),
  canonicalJson({ a: { x: 1, y: 2 }, z: 1 }),
);
assert.equal(
  canonicalSha256({ z: 1, a: { y: 2, x: 1 } }),
  canonicalSha256({ a: { x: 1, y: 2 }, z: 1 }),
);

assert.throws(
  () => validateInfrastructureManifestCreate({ ...infrastructureInput, status: "applied" }),
  /mutable or unknown fields/,
);
assert.throws(
  () => validateInfrastructureManifestCreate({ ...infrastructureInput, revision: 7 }),
  /mutable or unknown fields/,
);
assert.throws(
  () => validateInfrastructureManifestCreate({ ...infrastructureInput, specHash: sha }),
  /does not match/,
);
assert.throws(
  () => validateInfrastructureManifestCreate({
    ...infrastructureInput,
    desiredSpec: { ...desiredSpec, mutableOutput: "vpc-123" },
  }),
  /mutable or unknown fields/,
);
assert.throws(
  () => validateReleaseManifestCreate({
    ...releaseInput,
    infrastructureManifestId: undefined,
  }),
  /must be a string/,
);
assert.throws(
  () => validateReleaseManifestCreate({ ...releaseInput, imageDigest: "sha256:mutable" }),
  /mutable or unknown fields/,
);
assert.throws(
  () => validateReleaseManifestCreate({
    ...releaseInput,
    releaseSpec: {
      ...releaseSpec,
      source: { ...releaseSpec.source, commitSha: "not-a-commit" },
    },
  }),
  /invalid format/,
);
assert.throws(
  () => validateReleaseManifestCreate({
    ...releaseInput,
    repositoryFullName: "different/repository",
  }),
  /source fields do not match/,
);

console.log("Two-lane immutable contract shape verification passed");
