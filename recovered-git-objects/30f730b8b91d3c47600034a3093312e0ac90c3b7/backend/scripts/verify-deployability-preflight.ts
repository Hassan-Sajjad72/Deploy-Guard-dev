import { BadRequestException } from "@nestjs/common";
import { strict as assert } from "assert";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { detectionFingerprint } from "../src/projects/analysis-fingerprint";
import { DeploymentContractService } from "../src/projects/deployment-contract.service";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { StackDetectionService } from "../src/projects/detection/stack-detection.service";
import { TemplateMatchingService } from "../src/projects/detection/template-matching.service";
import { PipelineWorkerService } from "../src/projects/pipeline/pipeline-worker.service";
import { PipelineService } from "../src/projects/pipeline/pipeline.service";
import { PIPELINE_STAGE_REGISTRY } from "../src/projects/pipeline/pipeline-stage-registry";
import { PreflightValidationStatus } from "../src/projects/project-preflight-report.entity";
import { PreflightService } from "../src/projects/templates/preflight.service";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";

async function verifyPersistedContractGeneration() {
  const root = await mkdtemp(join(tmpdir(), "deployguard-contract-test-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { build: "vite build", dev: "vite" },
      dependencies: { react: "latest" },
      devDependencies: { vite: "latest" },
    }));
    await writeFile(join(root, "package-lock.json"), "{}");
    const sha = "c".repeat(40);
    const detector = new StackDetectionService(
      new TemplateMatchingService(),
      new RepoDeployabilityScannerService()
    );
    const draft = detector.detect(root, sha);
    const project: any = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      repositoryUrl: "https://github.com/example/vite",
      repositoryFullName: "example/vite",
      targetBranch: "main",
      appDirectory: null,
      deploymentOverrides: {},
    };
    draft.rawProfile.repositoryUrl = project.repositoryUrl;
    draft.rawProfile.targetBranch = project.targetBranch;
    draft.rawProfile.inputFingerprintVersion = 2;
    const profile: any = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      projectId: project.id,
      repositoryUrl: project.repositoryUrl,
      repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch,
      inputFingerprint: detectionFingerprint(project, sha),
      ...draft,
    };
    let persisted: any = null;
    const repository: any = {
      findOne: async () => persisted,
      create: (value: any) => ({ id: persisted?.id || "dddddddd-dddd-4ddd-8ddd-dddddddddddd", ...value }),
      save: async (value: any) => { persisted = value; return value; },
    };
    const contractService = new DeploymentContractService(
      repository,
      {} as any,
      {} as any,
      { find: async () => [] } as any,
      { findOne: async () => null, create: (value: any) => value, save: async (value: any) => value } as any,
      new TemplateRegistryService(),
      new DockerTemplateEngineService(),
      { get: (_key: string, defaultValue: unknown) => defaultValue } as any
    );
    const contract = await contractService.upsertFromDetection(project, profile);
    assert.equal(contract.deployable, true);
    assert.equal(contract.language, "javascript");
    assert.equal(contract.runtimeType, "static");
    assert.equal(contract.dockerTemplate, "vite-static");
    assert.equal(contract.port, 80);
    assert.equal(contract.ecsPlan.containerPort, 80);
    assert.equal(contract.ecsPlan.targetGroupPort, 80);
    assert.equal(contract.ecsPlan.healthCheckPath, "/");
    assert.match(contract.generatedDockerfile || "", /FROM nginx:1\.27-alpine/);
    return contract;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function buildContract(
  files: Record<string, string>,
  configuredVariables: Array<{ key: string; value: string; isSecret: boolean }> = [],
  currentDetectionEvidence = true
) {
  const root = await mkdtemp(join(tmpdir(), "deployguard-contract-blocker-test-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }
    const project: any = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      repositoryUrl: "https://github.com/example/contract-case",
      repositoryFullName: "example/contract-case",
      targetBranch: "main",
      appDirectory: null,
      deploymentOverrides: {},
    };
    const detector = new StackDetectionService(new TemplateMatchingService(), new RepoDeployabilityScannerService());
    const draft = detector.detect(root, "9".repeat(40));
    if (currentDetectionEvidence) draft.rawProfile.inputFingerprintVersion = 2;
    const profile: any = {
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      projectId: project.id,
      repositoryUrl: project.repositoryUrl,
      repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch,
      inputFingerprint: detectionFingerprint(project, draft.commitSha),
      ...draft,
    };
    let persisted: any = null;
    const service = new DeploymentContractService(
      {
        findOne: async () => persisted,
        create: (value: any) => ({ id: "12121212-1212-4212-8212-121212121212", ...value }),
        save: async (value: any) => { persisted = value; return value; },
      } as any,
      {} as any,
      {} as any,
      { find: async () => configuredVariables } as any,
      { findOne: async () => null, create: (value: any) => value, save: async (value: any) => value } as any,
      new TemplateRegistryService(),
      new DockerTemplateEngineService(),
      { get: (_key: string, defaultValue: unknown) => defaultValue } as any
    );
    return await service.upsertFromDetection(project, profile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyContractBlockersAndWarnings() {
  const ownershipDetection = await buildContract({
    "package.json": JSON.stringify({ scripts: { build: "nest build", "start:prod": "node dist/main.js" }, dependencies: { "@nestjs/core": "latest", "@nestjs/config": "latest" } }),
    "package-lock.json": "{}",
    "src/main.ts": "configService.getOrThrow('APP_SIGNING_SECRET'); configService.get('OPTIONAL_FEATURE'); await app.listen(process.env.PORT || 3000, '0.0.0.0')",
    "tests/platform.spec.ts": "process.env.GITHUB_CLIENT_SECRET",
  });
  assert.ok(ownershipDetection.requiredEnvVars.includes("APP_SIGNING_SECRET"));
  assert.ok(ownershipDetection.optionalEnvVars.includes("OPTIONAL_FEATURE"));
  assert.equal(ownershipDetection.requiredEnvVars.includes("GITHUB_CLIENT_SECRET"), false, "test-only platform references must be ignored");

  const pythonOwnership = await buildContract({
    "requirements.txt": "Flask==3.1.0\ngunicorn==23.0.0\n",
    "app.py": "import os\nfrom flask import Flask\napp=Flask(__name__)\nsecret=os.environ['APP_SECRET']\nflag=os.getenv('OPTIONAL_FLAG')\n@app.get('/health')\ndef health(): return 'ok'",
  });
  assert.ok(pythonOwnership.requiredEnvVars.includes("APP_SECRET"));
  assert.ok(pythonOwnership.optionalEnvVars.includes("OPTIONAL_FLAG"));

  const committedEnv = await buildContract({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }),
    "package-lock.json": "{}",
    "server.js": "app.listen(process.env.PORT || 3000, '0.0.0.0')",
    ".env": "SECRET_VALUE=must-not-be-read",
  });
  assert.match(committedEnv.blockers.join(" "), /real \.env file is present/i);
  assert.equal(JSON.stringify(committedEnv).includes("must-not-be-read"), false);

  const composeAlias = await buildContract({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest", mysql2: "latest" } }),
    "package-lock.json": "{}",
    "server.js": "app.listen(process.env.PORT || 3000, '0.0.0.0'); process.env.MYSQL_HOST",
    "docker-compose.yml": "services:\n  api:\n    environment:\n      MYSQL_HOST: mysql\n  mysql:\n    image: mysql:8\n",
  });
  assert.equal(composeAlias.databaseRequired, true);
  assert.equal(composeAlias.databaseEngine, "mysql");
  assert.equal(composeAlias.deployable, false, "compose-local service aliases cannot become cloud runtime hosts");

  const database = await buildContract({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest", pg: "latest" } }),
    "package-lock.json": "{}",
    "server.js": "app.listen(process.env.PORT || 3000, '0.0.0.0')",
  });
  assert.equal(database.databaseRequired, true);
  assert.equal(database.requiredEnvVars.includes("DATABASE_URL"), false, "a database package alone does not prove DATABASE_URL is consumed");
  assert.match(database.blockers.join(" "), /does not show which runtime database variables/i);

  const registry = await buildContract({
    "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "latest" }, devDependencies: { vite: "latest" } }),
    "package-lock.json": "{}",
    ".npmrc": "@company:registry=https://npm.company.example\n//npm.company.example/:_authToken=${NPM_TOKEN}",
  });
  assert.equal(registry.privateRegistryRequired, true);
  assert.ok(registry.secretEnvVars.includes("NPM_TOKEN"));
  assert.equal(registry.deployable, true);
  assert.match(registry.warnings.join(" "), /Likely runtime application configuration is not set: NPM_TOKEN/i);
  assert.equal(JSON.stringify(registry).includes("npm.company.example/:_authToken"), false);

  const secretValue = "must-never-appear-in-contract";
  const configuredRegistry = await buildContract({
    "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "latest" }, devDependencies: { vite: "latest" } }),
    "package-lock.json": "{}",
    ".npmrc": "@company:registry=https://npm.company.example\n//npm.company.example/:_authToken=${NPM_TOKEN}",
  }, [{ key: "NPM_TOKEN", value: secretValue, isSecret: true }]);
  assert.match(configuredRegistry.blockers.join(" "), /BuildKit secret injection/i);
  assert.equal(JSON.stringify(configuredRegistry).includes(secretValue), false, "contract must contain environment names only");

  const optional = await buildContract({
    "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "latest" }, devDependencies: { vite: "latest" } }),
    "package-lock.json": "{}",
    ".env.example": "VITE_OPTIONAL_FEATURE=false",
  });
  assert.equal(optional.deployable, true);
  assert.ok(optional.optionalEnvVars.includes("VITE_OPTIONAL_FEATURE"));
  assert.match(optional.warnings.join(" "), /Optional environment variables are not configured/i);

  const legacy = await buildContract({
    "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "latest" }, devDependencies: { vite: "latest" } }),
    "package-lock.json": "{}",
  }, [], false);
  assert.equal(legacy.deployable, false);
  assert.match(legacy.blockers.join(" "), /predates the current deployment contract/i);
}

async function main() {
  await verifyPersistedContractGeneration();
  await verifyContractBlockersAndWarnings();
  const project: any = {
    id: "11111111-1111-4111-8111-111111111111",
    ownerUserId: 1,
    repositoryUrl: "https://github.com/example/app",
    repositoryFullName: "example/app",
    targetBranch: "main",
    appDirectory: null,
    deploymentOverrides: {},
  };
  const contract: any = {
    id: "22222222-2222-4222-8222-222222222222",
    projectId: project.id,
    detectionProfileId: "33333333-3333-4333-8333-333333333333",
    repositoryFullName: project.repositoryFullName,
    branch: "main",
    commitSha: "a".repeat(40),
    detectionSourceCommit: "a".repeat(40),
    appRoot: ".",
    language: "javascript",
    framework: "express",
    runtimeType: "server",
    packageManager: "npm",
    dependencyManifest: "package.json",
    lockfile: "package-lock.json",
    nodeVersion: "node-lts",
    pythonVersion: null,
    installCommand: "npm ci",
    buildCommand: null,
    startCommand: "npm start",
    outputDirectory: null,
    port: 3000,
    portSource: "detected",
    bindsToPortEnv: true,
    bindHost: "0.0.0.0",
    healthPath: "/health",
    requiredEnvVars: ["API_KEY"],
    optionalEnvVars: [],
    buildTimeEnvVars: [],
    runtimeEnvVars: ["API_KEY"],
    secretEnvVars: ["API_KEY"],
    missingEnvVars: ["API_KEY"],
    databaseRequired: false,
    persistentStorageRequired: false,
    privateRegistryRequired: false,
    dockerStrategy: "generated",
    dockerTemplate: "express-server",
    generatedDockerfile: "FROM node:22-alpine3.21\nCMD [\"npm\",\"start\"]",
    ecsPlan: {
      containerPort: 3000,
      targetGroupPort: 3000,
      healthCheckPath: "/health",
      command: "npm start",
      cpu: 256,
      memory: 512,
      environmentMappings: [{ name: "PORT", source: "platform" }],
      secretMappings: [],
    },
    deployable: true,
    blockers: [],
    warnings: ["Likely runtime application configuration is not set: API_KEY."],
    confidence: "high",
    contractHash: "contract-hash",
  };
  const envRepository: any = { find: async () => [] };
  const preflightService = new PreflightService(
    {} as any,
    envRepository,
    {} as any,
    {} as any,
    new TemplateRegistryService(),
    {} as any,
    {
      resolveEffectiveDeploymentConfiguration: async () => ({
        blockers: contract.blockers,
        unresolvedRequiredValues: contract.missingEnvVars || [],
        prohibitedOverrides: [],
        duplicateOwnershipConflicts: [],
        ownership: {},
        configurationFingerprint: contract.contractHash,
      }),
    } as any
  );
  const built = await (preflightService as any).buildReport(project, contract);
  assert.equal(built.validationStatus, PreflightValidationStatus.PASSED_WITH_WARNINGS);
  assert.match(built.warnings.join(" "), /Likely runtime application configuration is not set: API_KEY/i);
  assert.equal(built.report.ecsRuntimePlan.containerPort, contract.ecsPlan.containerPort);
  assert.equal(built.report.ecsRuntimePlan.albTargetPort, contract.ecsPlan.targetGroupPort);

  const failedReport: any = {
    id: "44444444-4444-4444-8444-444444444444",
    projectId: project.id,
    inputFingerprint: contract.contractHash,
    validationStatus: PreflightValidationStatus.FAILED,
    errors: built.errors,
  };
  let queued = false;
  const contractService = {
    requireForProject: async () => contract,
    assertDeployable: () => {
      throw new BadRequestException(`Deployability pre-flight failed. ${contract.blockers[0]}`);
    },
  };
  const pipeline = new PipelineService(
    { findOne: async () => null } as any,
    {} as any,
    { findOne: async () => failedReport } as any,
    contractService as any,
    { add: async () => { queued = true; } } as any,
    { getProjectEntityForManage: async () => project } as any,
    {} as any,
    {} as any,
    { recordUserAction: async () => undefined } as any,
    { createRunConfigurationSnapshot: async () => ({ id: "snapshot" }) } as any,
    { evaluate: async () => ({ eligible: false, blockedReason: "not_at_apply_gate" }) } as any
  );
  await assert.rejects(
    () => pipeline.startRun({ id: 1 } as any, project.id, {} as any),
    /Legacy full_deploy execution is retired\. Eligible projects must use the guarded v1 release lifecycle\./i
  );
  assert.equal(queued, false, "retired legacy execution must not enqueue Docker/ECR/Terraform work");

  const worker = Object.create(PipelineWorkerService.prototype) as any;
  assert.throws(
    () => worker.assertContractCommit({ commitSha: "b".repeat(40) }, contract),
    /Repository changed after stack detection/i
  );

  const order = new Map(PIPELINE_STAGE_REGISTRY.map((stage) => [stage.key, stage.order]));
  assert.ok(order.get("deployability_preflight_gate")! < order.get("docker_build")!);
  assert.ok(order.get("deployability_preflight_gate")! < order.get("ecr_push")!);
  assert.ok(order.get("deployability_preflight_gate")! < order.get("terraform_plan")!);
  process.stdout.write("Verified pre-flight reads one deployment contract, contract ECS values stay aligned, blockers cannot enqueue work, and stale commits fail before Docker build.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
