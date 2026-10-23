import { BadRequestException } from "@nestjs/common";
import { strict as assert } from "assert";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { DETECTION_INPUT_FINGERPRINT_VERSION, detectionFingerprint } from "../src/projects/analysis-fingerprint";
import { BUILD_PLAN_DETECTOR_VERSION } from "../src/projects/build-plan";
import { evaluateBuildPlanReadiness } from "../src/projects/build-plan-readiness";
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
import { APPLICATION_FILESYSTEM_EPHEMERAL } from "../src/projects/readiness-warning";

async function verifyPersistedContractGeneration() {
  const root = await mkdtemp(join(tmpdir(), "deployguard-contract-test-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { build: "vite build", dev: "vite" },
      engines: { node: "20.x" },
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
    draft.rawProfile.inputFingerprintVersion = DETECTION_INPUT_FINGERPRINT_VERSION;
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
    assert.equal(contract.port, 8080);
    assert.equal(contract.ecsPlan.containerPort, 8080);
    assert.equal(contract.ecsPlan.targetGroupPort, 8080);
    assert.equal(contract.ecsPlan.healthCheckPath, "/");
    for (const name of ["NODE_ENV", "AWS_REGION", "AWS_DEFAULT_REGION", "DEPLOYGUARD_PROJECT_ID", "DEPLOYGUARD_ENVIRONMENT", "DEPLOYGUARD_OPERATION_ID", "DEPLOYGUARD_APP_LOG_GROUP"]) {
      assert.ok(contract.ecsPlan.environmentMappings.some((item: any) => item.name === name && item.source === "platform"), `${name} must exist before contract finalization`);
    }
    assert.match(contract.generatedDockerfile || "", /FROM nginxinc\/nginx-unprivileged:1\.27-alpine/);
    return contract;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function buildContract(
  files: Record<string, string>,
  configuredVariables: Array<{ key: string; value: string; isSecret: boolean }> = [],
  currentDetectionEvidence = true,
  mutateProfile?: (draft: any) => void,
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
    if (currentDetectionEvidence) draft.rawProfile.inputFingerprintVersion = DETECTION_INPUT_FINGERPRINT_VERSION;
    mutateProfile?.(draft);
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
    const contract = await service.upsertFromDetection(project, profile);
    for (const warning of contract.warnings) {
      assert.ok(contract.buildPlan.warningDetails?.some((detail: any) => detail.message === warning && detail.severity === "warning" && detail.deploymentAllowed === true), `warning must have structured metadata: ${warning}`);
    }
    return contract;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyContractBlockersAndWarnings() {
  const unresolvedTopology = await buildContract({
    "package.json": JSON.stringify({ scripts: { build: "vite build", start: "node server.js" }, dependencies: { express: "latest", react: "latest", vite: "latest", mongoose: "latest" } }),
    "package-lock.json": "{}",
    "src/App.jsx": "const secret=import.meta.env.JWT_SECRET;export default ()=>secret",
    "server.js": "const express=require('express');const app=express();app.use(express.static(resolveAtRuntime()));app.listen(process.env.PORT||3000,'0.0.0.0')",
  });
  assert.equal(unresolvedTopology.buildPlan.topology?.analysisState, "UNRESOLVED");
  assert.deepEqual(unresolvedTopology.buildPlan.components, [], "canonical empty components must not synthesize a legacy Vite component");
  assert.equal(unresolvedTopology.databaseRequired, false, "legacy dependency evidence must not invent a database without a canonical owner");
  assert.equal(unresolvedTopology.databaseEngine, null);
  assert.doesNotMatch(unresolvedTopology.blockers.join(" "), /Private configuration cannot enter a frontend browser build/, "legacy frontend ENV classification must not replace unresolved topology authority");

  const canonicalOverLegacy = await buildContract({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }),
    "package-lock.json": "{}",
    "server.js": "const express=require('express');const app=express();app.get('/health',(_q,r)=>r.send('ok'));app.listen(process.env.PORT||3000,'0.0.0.0')",
  }, [], true, (draft) => {
    draft.framework = "unknown";
    draft.frameworkVariant = null;
    draft.selectedTemplate = null;
    draft.expectedPort = null;
    draft.startCommand = null;
    draft.rawProfile.installCommand = null;
  });
  assert.equal(canonicalOverLegacy.buildPlan.topology?.analysisState, "SUPPORTED");
  assert.equal(canonicalOverLegacy.framework, "express");
  assert.equal(canonicalOverLegacy.dockerTemplate, "express-server");
  assert.equal(canonicalOverLegacy.port, 3000);
  assert.equal(canonicalOverLegacy.deployable, true, "legacy compatibility fields cannot override a current canonical component");

  const ownershipDetection = await buildContract({
    "package.json": JSON.stringify({ scripts: { build: "nest build", "start:prod": "node dist/main.js" }, dependencies: { "@nestjs/core": "latest", "@nestjs/config": "latest" } }),
    "package-lock.json": "{}",
    "src/main.ts": "configService.getOrThrow('APP_SIGNING_SECRET'); configService.get('OPTIONAL_FEATURE'); await app.listen(process.env.PORT || 3000, '0.0.0.0')",
    "tests/platform.spec.ts": "process.env.GITHUB_CLIENT_SECRET",
  });
  assert.ok(ownershipDetection.requiredEnvVars.includes("APP_SIGNING_SECRET"));
  assert.ok(ownershipDetection.optionalEnvVars.includes("OPTIONAL_FEATURE"));
  assert.equal(ownershipDetection.requiredEnvVars.includes("GITHUB_CLIENT_SECRET"), false, "test-only platform references must be ignored");

  const unknownRuntimeAbsent = await buildContract({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }),
    "package-lock.json": "{}",
    "server.js": "const express=require('express');const app=express();console.log(process.env.INTEGRATION_ENDPOINT);app.get('/health',(_q,r)=>r.send('ok'));app.listen(process.env.PORT||3000,'0.0.0.0')",
  });
  assert.equal(unknownRuntimeAbsent.requiredEnvVars.includes("INTEGRATION_ENDPOINT"), false);
  assert.equal(unknownRuntimeAbsent.ecsPlan.environmentMappings.some((item: any) => item.name === "INTEGRATION_ENDPOINT"), false, "an absent unknown runtime value is never invented");
  assert.ok(unknownRuntimeAbsent.buildPlan.requiredUserInputs.includes("INTEGRATION_ENDPOINT"), "unknown runtime requiredness must remain a user decision boundary");
  assert.equal(evaluateBuildPlanReadiness(unknownRuntimeAbsent.buildPlan).status, "INPUT_REQUIRED");
  const unknownRuntimeProvided = await buildContract({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }),
    "package-lock.json": "{}",
    "server.js": "const express=require('express');const app=express();console.log(process.env.INTEGRATION_ENDPOINT);app.get('/health',(_q,r)=>r.send('ok'));app.listen(process.env.PORT||3000,'0.0.0.0')",
  }, [{ key: "INTEGRATION_ENDPOINT", value: "https://integration.example", isSecret: false }]);
  assert.ok(unknownRuntimeProvided.ecsPlan.environmentMappings.some((item: any) => item.name === "INTEGRATION_ENDPOINT" && item.source === "project"), "a supplied unknown runtime value follows backend runtime ownership");
  assert.equal(unknownRuntimeProvided.buildPlan.requiredUserInputs.includes("INTEGRATION_ENDPOINT"), false, "a supplied unknown value is resolved without changing its provenance");

  const pythonOwnership = await buildContract({
    "requirements.txt": "Flask==3.1.0\ngunicorn==23.0.0\n",
    "app.py": "import os\nfrom flask import Flask\napp=Flask(__name__)\nsecret=os.environ['APP_SECRET']\nflag=os.getenv('OPTIONAL_FLAG')\n@app.get('/health')\ndef health(): return 'ok'",
  });
  assert.ok(pythonOwnership.requiredEnvVars.includes("APP_SECRET"));
  assert.ok(pythonOwnership.optionalEnvVars.includes("OPTIONAL_FLAG"));

  const committedEnv = await buildContract({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }),
    "package-lock.json": "{}",
    "server.js": "app.get('/health', handler); app.listen(process.env.PORT || 3000, '0.0.0.0')",
    ".env": "SECRET_VALUE=must-not-be-read",
  });
  assert.equal(committedEnv.optionalEnvVars.includes("SECRET_VALUE"), true, "committed .env keys are bounded configuration evidence");
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
  assert.equal(registry.deployable, false, "secret-dependent registry installs must fail closed before image build");
  assert.match(registry.blockers.join(" "), /Secret variables cannot be used during image build/i);
  assert.ok(registry.missingEnvVars.includes("NPM_TOKEN"));
  assert.doesNotMatch(registry.warnings.join(" "), /runtime application configuration is not set/i, "missing required inputs must not also be warnings");
  assert.equal(JSON.stringify(registry).includes("npm.company.example/:_authToken"), false);

  const secretValue = "must-never-appear-in-contract";
  const configuredRegistry = await buildContract({
    "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "latest" }, devDependencies: { vite: "latest" } }),
    "package-lock.json": "{}",
    ".npmrc": "@company:registry=https://npm.company.example\n//npm.company.example/:_authToken=${NPM_TOKEN}",
  }, [{ key: "NPM_TOKEN", value: secretValue, isSecret: true }]);
  assert.match(configuredRegistry.blockers.join(" "), /Secret variables cannot be used during image build/i);
  assert.equal(JSON.stringify(configuredRegistry).includes(secretValue), false, "contract must contain environment names only");

  const optional = await buildContract({
    "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "latest" }, devDependencies: { vite: "latest" } }),
    "package-lock.json": "{}",
    ".env.example": "VITE_OPTIONAL_FEATURE=false",
  });
  assert.equal(optional.deployable, true);
  assert.ok(optional.optionalEnvVars.includes("VITE_OPTIONAL_FEATURE"));
  assert.match(optional.warnings.join(" "), /Optional environment variables are not configured/i);

  const domainFileWrites = await buildContract({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }),
    "package-lock.json": "{}",
    "server.js": "const express=require('express');const {writeFileSync}=require('fs');const app=express();app.get('/health',(_q,r)=>r.send('ok'));app.post('/records',(q,r)=>{writeFileSync('/tmp/records.json',JSON.stringify(q.body));r.sendStatus(204)});app.listen(process.env.PORT||3000,'0.0.0.0')",
  });
  assert.equal(domainFileWrites.persistentStorageRequired, false, "application-owned file writes must not request platform persistence");
  assert.equal(domainFileWrites.deployable, true, "application-owned file writes are a deployable runtime risk");
  assert.ok(domainFileWrites.buildPlan.warningDetails?.some((warning: any) => warning.code === APPLICATION_FILESYSTEM_EPHEMERAL));
  assert.equal(evaluateBuildPlanReadiness(domainFileWrites.buildPlan).status, "READY_WITH_WARNINGS");

  const databaseFallbackWrites = await buildContract({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest", mongoose: "latest" } }),
    "package-lock.json": "{}",
    "server.js": "const express=require('express');const mongoose=require('mongoose');const {writeFileSync}=require('fs');const app=express();mongoose.connect(process.env.MONGODB_URI);app.get('/health',(_q,r)=>r.send('ok'));app.post('/records',(q,r)=>{if(mongoose.connection.readyState!==1)writeFileSync('/tmp/fallback.json',JSON.stringify(q.body));r.sendStatus(204)});app.listen(process.env.PORT||3000,'0.0.0.0')",
  });
  assert.equal(databaseFallbackWrites.databaseEngine, "mongodb");
  assert.equal(databaseFallbackWrites.persistentStorageRequired, false);
  assert.equal(databaseFallbackWrites.deployable, true);
  assert.ok(databaseFallbackWrites.buildPlan.warningDetails?.some((warning: any) => warning.code === APPLICATION_FILESYSTEM_EPHEMERAL));

  const monolithRepositoryDefault = await buildContract({
    "package.json": JSON.stringify({ scripts: { build: "vite build", start: "node server.js" }, dependencies: { express: "latest", mongoose: "latest", react: "latest" }, devDependencies: { vite: "latest" } }),
    "package-lock.json": "{}",
    "vite.config.js": "process.env.GEMINI_API_KEY = 'repository-fallback'; export default { build: { outDir: 'dist' }, server: { hmr: process.env.DISABLE_HMR !== 'true' } }",
    "server.js": "const express=require('express');const mongoose=require('mongoose');const {writeFileSync}=require('fs');const app=express();mongoose.connect(process.env.MONGODB_URI);app.use(express.static('dist'));app.get('/health',(_q,r)=>r.send('ok'));app.post('/records',(q,r)=>{if(mongoose.connection.readyState!==1)writeFileSync('/tmp/fallback.json',JSON.stringify(q.body));r.sendStatus(204)});app.listen(process.env.PORT||3000,'0.0.0.0')",
  });
  assert.equal(monolithRepositoryDefault.buildPlan.topology?.shape, "MONOLITH_SERVES_FRONTEND");
  assert.equal(monolithRepositoryDefault.deployable, true, "canonical repository-default ENV must not be rematerialized as a secret build input");
  assert.doesNotMatch(monolithRepositoryDefault.blockers.join(" "), /GEMINI_API_KEY/);
  assert.equal(monolithRepositoryDefault.requiredEnvVars.includes("DISABLE_HMR"), false);
  assert.equal(monolithRepositoryDefault.optionalEnvVars.includes("DISABLE_HMR"), false);
  assert.equal(monolithRepositoryDefault.buildPlan.environmentOwnership.some((item: any) => item.key === "DISABLE_HMR"), false, "Vite server-only ENV is omitted from the production BuildPlan");
  assert.equal(evaluateBuildPlanReadiness(monolithRepositoryDefault.buildPlan).status, "READY_WITH_WARNINGS");

  const cacheWrites = await buildContract({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }),
    "package-lock.json": "{}",
    "server.js": "const express=require('express');const {appendFileSync}=require('fs');const app=express();app.get('/health',(_q,r)=>{appendFileSync('/tmp/access.log','hit\\n');r.send('ok')});app.listen(process.env.PORT||3000,'0.0.0.0')",
  });
  assert.equal(cacheWrites.deployable, true);
  assert.equal(evaluateBuildPlanReadiness(cacheWrites.buildPlan).status, "READY_WITH_WARNINGS");

  const localSqlite = await buildContract({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest", "better-sqlite3": "latest" } }),
    "package-lock.json": "{}",
    "server.js": "const express=require('express');const Database=require('better-sqlite3');const app=express();const db=new Database('/tmp/app.sqlite');app.get('/health',(_q,r)=>r.send('ok'));app.listen(process.env.PORT||3000,'0.0.0.0')",
  });
  assert.equal(localSqlite.databaseRequired, false, "local SQLite is application-owned storage, not a managed database request");
  assert.equal(localSqlite.databaseEngine, null);
  assert.equal(localSqlite.persistentStorageRequired, false);
  assert.equal(localSqlite.deployable, true);
  assert.equal(evaluateBuildPlanReadiness(localSqlite.buildPlan).status, "READY_WITH_WARNINGS");
  assert.ok(localSqlite.buildPlan.warningDetails?.some((warning: any) => warning.code === APPLICATION_FILESYSTEM_EPHEMERAL));

  const mandatoryMount = await buildContract({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }),
    "package-lock.json": "{}",
    "server.js": "const express=require('express');const {writeFileSync}=require('fs');const app=express();if(!require('fs').existsSync('/mnt/shared'))throw new Error('persistent shared filesystem mount is required');app.get('/health',(_q,r)=>r.send('ok'));app.post('/records',(q,r)=>{writeFileSync('/mnt/shared/records.json',JSON.stringify(q.body));r.sendStatus(204)});app.listen(process.env.PORT||3000,'0.0.0.0')",
  });
  assert.equal(mandatoryMount.persistentStorageRequired, true);
  assert.equal(mandatoryMount.deployable, false, "an explicit durable mount requirement must remain blocked");
  assert.match(mandatoryMount.blockers.join(" "), /file-system persistence is not supported/i);

  const warningWithMissingInput = {
    ...domainFileWrites.buildPlan,
    requiredInputs: ["APP_SECRET"],
  };
  assert.equal(evaluateBuildPlanReadiness(warningWithMissingInput, { unresolvedRequiredValues: ["APP_SECRET"] }).status, "INPUT_REQUIRED", "a filesystem warning must not mask missing required configuration");
  const warningWithTopologyBlocker = {
    ...domainFileWrites.buildPlan,
    topology: { ...domainFileWrites.buildPlan.topology, analysisState: "UNRESOLVED" },
  };
  assert.equal(evaluateBuildPlanReadiness(warningWithTopologyBlocker).status, "BLOCKED", "a filesystem warning must not mask unsafe topology");

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
    warnings: [],
    confidence: "high",
    contractHash: "contract-hash",
  };
  contract.buildPlan = {
    planVersion: 1, detectorVersion: BUILD_PLAN_DETECTOR_VERSION, repositoryFullName: project.repositoryFullName,
    branch: "main", commitSha: "a".repeat(40), detectorId: "express:express-server", language: "javascript",
    framework: "express", frameworkMode: "express-server", confidence: "high", evidence: [], appRoot: ".",
    packageManager: "npm", dependencyManifest: "package.json", lockfile: "package-lock.json", runtimeVersion: "22",
    baseImage: "node:22-alpine3.21", runtimeImage: "node:22-alpine3.21", installCommand: "npm ci", buildCommand: null,
    releaseCommand: null, runCommand: "npm start", outputDirectory: null, buildSystemDependencies: [], runtimeSystemDependencies: [],
    port: 3000, portSource: "source", healthPath: "/health", bindHost: "0.0.0.0", bindsToPortEnv: true, runtimeType: "server",
    environmentOwnership: [{ key: "API_KEY", owner: "application", required: true, phase: "runtime", secret: true }],
    requiredInputs: ["API_KEY"], optionalInputs: [], buildTimeEnvVars: [], runtimeEnvVars: ["API_KEY"], secretEnvVars: ["API_KEY"],
    dockerStrategy: "generated", dockerTemplate: "express-server", warnings: contract.warnings, blockers: [],
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
  assert.equal(built.validationStatus, PreflightValidationStatus.PASSED);
  assert.equal(built.warnings.length, 0, "missing required configuration must not be represented as a warning");
  assert.equal(built.report.ecsRuntimePlan.containerPort, contract.ecsPlan.containerPort);
  assert.equal(built.report.ecsRuntimePlan.albTargetPort, contract.ecsPlan.targetGroupPort);
  assert.equal(built.report.readiness.decision, "INPUT_REQUIRED");
  assert.deepEqual(built.report.readiness.requiredInputs, ["API_KEY"]);
  assert.equal(built.report.readiness.deployAllowed, false);
  const response = (preflightService as any).toReportResponse({
    id: "report", projectId: project.id, detectionProfileId: contract.detectionProfileId,
    inputFingerprint: contract.contractHash, templateKey: contract.dockerTemplate,
    templateDisplayName: "Express", ecosystem: "node", framework: "express", frameworkVariant: "express-server",
    packageManager: "npm", runtimeVersion: "22", expectedPort: 3000, buildCommand: null,
    startCommand: "npm start", healthCheckPath: "/health", hasDockerfile: false, dockerfileRequired: false,
    generatedDockerfile: contract.generatedDockerfile, report: built.report, validationStatus: built.validationStatus,
    warnings: built.warnings, errors: built.errors, createdAt: new Date(), updatedAt: new Date(),
  });
  assert.equal(response.readinessStatus, "INPUT_REQUIRED");
  assert.deepEqual(response.requiredInputs, ["API_KEY"]);
  assert.equal(response.deployAllowed, false);

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
