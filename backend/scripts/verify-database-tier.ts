import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeploymentContractService } from "../src/projects/deployment-contract.service";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { StackDetectionService } from "../src/projects/detection/stack-detection.service";
import { TemplateMatchingService } from "../src/projects/detection/template-matching.service";
import { DETECTION_INPUT_FINGERPRINT_VERSION, detectionFingerprint } from "../src/projects/analysis-fingerprint";
import { DatabaseTierProvider } from "../src/projects/project-database-tier.entity";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";
import { EcsService } from "../src/orchestration/ecs.service";
import { DatabaseTierService } from "../src/projects/database-tier.service";

async function main() {
  const root = await mkdtemp(join(tmpdir(), "deployguard-database-tier-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { express: "^4.0.0", sequelize: "^6.0.0", pg: "^8.0.0" }, scripts: { start: "node server.js" } }));
    await writeFile(join(root, "package-lock.json"), "{}");
    await writeFile(join(root, "server.js"), "const express=require('express'); const app=express(); app.get('/health',(_,r)=>r.send('ok')); app.listen(process.env.PORT || 3000, '0.0.0.0'); const db={host:process.env.DB_HOST,name:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,dialect:'postgres'};");
    const scanner = new RepoDeployabilityScannerService();
    const evidence = scanner.scan(root, { ecosystem: "node", framework: "express", packageManager: "npm", buildCommand: null, startCommand: "node server.js", expectedPort: 3000, healthCheckPath: "/health", staticOutput: false, hasDockerfile: false, requiresDatabase: false, requiresPersistentStorage: false });
    assert.equal(evidence.databaseRequired, true);
    assert.equal(evidence.databaseEngine, "postgres");
    assert.equal(evidence.databaseLocalhostDetected, false);

    const project: any = { id: "11111111-1111-4111-8111-111111111111", repositoryFullName: "example/database-app", repositoryUrl: "https://github.com/example/database-app", targetBranch: "main", appDirectory: null, deploymentOverrides: {} };
    const sha = "a".repeat(40);
    const draft = new StackDetectionService(new TemplateMatchingService(), scanner).detect(root, sha);
    draft.rawProfile.inputFingerprintVersion = DETECTION_INPUT_FINGERPRINT_VERSION;
    const profile: any = { id: "22222222-2222-4222-8222-222222222222", projectId: project.id, repositoryFullName: project.repositoryFullName, targetBranch: "main", inputFingerprint: detectionFingerprint(project, sha), ...draft };
    let persisted: any = null;
    let tier: any = null;
    const tierRepository: any = { findOne: async () => tier, create: (value: any) => value, save: async (value: any) => { tier = value; return value; } };
    const historicalVariables = [{
      key: "DATABASE_URL",
      isRequired: true,
      isSecret: true,
      scope: "runtime",
      isActive: true,
    }];
    const service = new DeploymentContractService({ findOne: async () => persisted, create: (value: any) => ({ id: "33333333-3333-4333-8333-333333333333", ...value }), save: async (value: any) => (persisted = value) } as any, {} as any, {} as any, { find: async () => historicalVariables } as any, tierRepository, new TemplateRegistryService(), new DockerTemplateEngineService(), { get: (_key: string, fallback: unknown) => fallback } as any);
    const managed = await service.upsertFromDetection(project, profile);
    assert.equal(managed.deployable, true);
    assert.equal(tier.provider, DatabaseTierProvider.MANAGED);
    assert.equal(tier.engine, "postgres");
    assert.equal(tier.internalHost, `db.project-${project.id}.deployguard.local`);
    assert.equal(tier.persistenceEnabled, true);
    assert.equal(tier.externalHost, null);
    assert.equal(managed.ecsPlan.database.dataPath, "/var/lib/postgresql/data");
    assert.deepEqual(managed.buildPlan.database, { required: true, provider: "managed", engine: "postgres" });
    assert(managed.ecsPlan.secretMappings.some((item: any) => item.name === "DB_PASSWORD" && item.source === "platform_secret"));
    assert.equal(managed.ecsPlan.secretMappings.some((item: any) => item.name === "DATABASE_URL"), false, "DATABASE_URL is not forced without repository evidence");
    assert.equal(managed.requiredEnvVars.includes("DATABASE_URL"), false, "legacy stored DATABASE_URL cannot become repository evidence");
    assert.equal(managed.optionalEnvVars.includes("DATABASE_URL"), false, "legacy stored DATABASE_URL cannot become optional repository evidence");
    assert.equal(managed.runtimeEnvVars.includes("DATABASE_URL"), false, "legacy stored DATABASE_URL remains omitted from the runtime contract");
    const ecs = Object.create(EcsService.prototype) as EcsService;
    const summary = (ecs as any).actionableFailureSummary({ stoppedTaskReason: null, containerExitCode: 1, containerReason: null, containerPort: 3000, targetPort: 3000, logLines: ["SequelizeConnectionRefusedError: connect ECONNREFUSED 127.0.0.1:5432"], targetHealth: [], healthCheckPath: "/health" });
    assert.match(summary, /database at localhost/i);
    assert.equal((ecs as any).diagnosticCode(summary), "DATABASE_LOCALHOST_UNREACHABLE");
    assert.match(summary, /managed database/i);
    const appStorageVariables = await readFile(join(process.cwd(), "terraform/modules/ecs-service/variables.tf"), "utf8");
    assert.match(appStorageVariables, /default\s*=\s*"\/app\/uploads"/);
    const publicDatabase = (Object.create(DatabaseTierService.prototype) as any).safe({ id: "tier", projectId: project.id, requiredByDetection: true, provider: "managed", engine: "postgres", status: "ready", internalHost: tier.internalHost, externalHost: null, externalPort: null, databaseName: "app", databaseUser: "deployguard", persistenceEnabled: true, backupEnabled: true, efsFileSystemId: "fs-private", credentialsSecretArn: "arn:secret:private", lastError: null, updatedAt: new Date() });
    assert.equal(publicDatabase.credentialsConfigured, true);
    assert.equal("credentialsSecretArn" in publicDatabase, false);
    assert.equal("databaseUrlSecretArn" in publicDatabase, false);
    console.log("Database detection, pre-flight, managed runtime contract, and ECS diagnostics verification passed");
  } finally { await rm(root, { recursive: true, force: true }); }
}
void main();
