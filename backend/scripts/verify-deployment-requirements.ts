import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeploymentRequirementsService } from "../src/projects/deployment-requirements.service";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { DeploymentCheckpointService } from "../src/projects/recovery/deployment-checkpoint.service";
import { DatabaseRequirementAnalyzer } from "../src/projects/recovery/database-requirement-analyzer.service";
import { DeploymentRecoveryPlanner } from "../src/projects/recovery/deployment-recovery-planner.service";
import { EcsDiagnosticsClassifier } from "../src/projects/recovery/ecs-diagnostics-classifier.service";
import { PreflightIssueMapper } from "../src/projects/recovery/preflight-issue-mapper.service";
import { StorageRequirementAnalyzer } from "../src/projects/recovery/storage-requirement-analyzer.service";

async function main() {
  const root = await mkdtemp(join(tmpdir(), "deployguard-requirements-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "^4", pg: "^8" } }));
    await writeFile(join(root, "package-lock.json"), "{}");
    await writeFile(join(root, "server.js"), `
      const express=require("express");
      const app=express();
      const port=process.env.PORT || "5000";
      const db={name:process.env.DB_NAME || "cattle_farm_db",user:process.env.DB_USER || "postgres",host:process.env.DB_HOST || "localhost",password:process.env.DB_PASSWORD};
      if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET required");
      app.get("/health",(_,res)=>res.send("ok")); app.listen(port,"0.0.0.0");
    `);
    const result: any = new RepoDeployabilityScannerService().scan(root, {
      ecosystem: "node", framework: "express", packageManager: "npm", buildCommand: null,
      startCommand: "node server.js", expectedPort: 5000, healthCheckPath: "/health", staticOutput: false,
      hasDockerfile: false, requiresDatabase: false, requiresPersistentStorage: false,
    });
    const evidence = new Map<string, any>(result.environmentVariables.map((item: any) => [item.key, item]));
    assert.equal(result.databaseRequired, true, "PostgreSQL dependency is detected");
    assert.equal(evidence.get("DB_NAME").detectedDefault, "cattle_farm_db", "safe DB name default is retained");
    assert.equal(evidence.get("DB_HOST").detectedDefault, "localhost", "local default is evidence, not an effective binding");
    assert.equal(evidence.get("JWT_SECRET").required, true, "JWT secret is a required input");
    assert.equal(evidence.get("JWT_SECRET").detectedDefault, undefined, "secret defaults are never retained");
    assert.equal(result.detectedPort, 5000, "application port is detected");

    const react = join(root, "react-pomodoro");
    await mkdir(react);
    await writeFile(join(react, "package.json"), JSON.stringify({
      scripts: { build: "NODE_ENV='production' ./node_modules/.bin/webpack" },
      dependencies: { react: "^15" },
      devDependencies: { webpack: "^5.97.1", "webpack-cli": "^6.0.1" },
    }));
    await writeFile(join(react, "package-lock.json"), "{}");
    await writeFile(join(react, "webpack.production.config.js"), `
      const webpack = require("webpack");
      module.exports = { plugins: [new webpack.DefinePlugin({
        "process.env.NODE_ENV": JSON.stringify("production")
      })] };
    `);
    await writeFile(join(react, "app.js"), `
      if (process.env.NODE_ENV === "production") console.log("production bundle");
      fetch(process.env.APPLICATION_API_URL + "/timer");
    `);
    const reactResult: any = new RepoDeployabilityScannerService().scan(react, {
      ecosystem: "node", framework: "react", packageManager: "npm", buildCommand: "npm run build",
      startCommand: null, expectedPort: null, healthCheckPath: "/", staticOutput: true,
      hasDockerfile: false, requiresDatabase: false, requiresPersistentStorage: false,
    });
    const reactEvidence = new Map<string, any>(reactResult.environmentVariables.map((item: any) => [item.key, item]));
    assert.equal(reactEvidence.get("NODE_ENV").ownership, "repository_build", "script/config assignments are repository build-owned");
    assert.equal(reactEvidence.get("NODE_ENV").required, false, "repository build-owned variables are not user-required");
    assert.equal(reactEvidence.get("NODE_ENV").phase, "build", "repository build-owned variables retain build phase");
    assert.equal(reactResult.optionalEnvironmentVariables.includes("NODE_ENV"), false, "repository build-owned variables are not optional user inputs");
    assert.deepEqual(reactResult.requiredEnvironmentVariables, ["APPLICATION_API_URL"], "genuinely unresolved application variables remain required");
    // This intentionally incomplete historical shape must fail during the local
    // build preflight, before the workflow can reach Terraform.  Webpack's
    // default entry is src/index.js while this fixture deliberately supplies
    // only app.js and no explicit entry in the configuration.
    execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: react, stdio: "pipe", timeout: 120_000 });
    const pomodoroBuild = spawnSync("docker", [
      "run", "--rm", "-v", `${react}:/app`, "-w", "/app", "node:22-alpine",
      "sh", "-lc", "npm ci --ignore-scripts >/dev/null && npm run build",
    ], { encoding: "utf8", timeout: 180_000 });
    assert.notEqual(pomodoroBuild.status, 0, "the intentionally missing Webpack entry must fail preflight");
    assert.match(`${pomodoroBuild.stdout}\n${pomodoroBuild.stderr}`, /(?:Can't resolve|Module not found|src[\\/]index)/i, "the preflight failure identifies the missing entry rather than silently producing an image");
    // The test container runs npm as root; remove its transient dependency tree
    // as root before the host-owned temporary fixture is removed in finally.
    execFileSync("docker", ["run", "--rm", "-v", `${react}:/app`, "node:22-alpine", "rm", "-rf", "/app/node_modules"], { stdio: "pipe", timeout: 60_000 });

    const service: any = Object.create(DeploymentRequirementsService.prototype);
    const keys = service.requiredUserKeys({ requiredEnvVars: ["PORT", "DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "DATABASE_URL", "JWT_SECRET"] }, [...evidence.values()], "managed");
    assert.deepEqual(keys, ["JWT_SECRET"], "managed PostgreSQL leaves only the user-owned secret unresolved");
    assert.match(service.generatedDatabaseUser("846665b9-ce31-405d-a131-b84457d80932"), /^dg_[a-f0-9]{12}$/, "managed database user is deterministic and platform-owned");
    const issue = service.recoveryIssue("846665b9-ce31-405d-a131-b84457d80932", true);
    assert.equal(issue.resumeFromStage, "database_tier_setup", "database resolution resumes at database setup");
    assert.equal(issue.affectedStages.includes("docker_build"), false, "database changes do not rebuild the image");

    const publicView = service.publicView({
      projectId: "project", sourceCommit: "sha", scanRevision: "scan", status: "saved", applicationStatus: "pending_deployment",
      architecture: {}, requiredInputs: [{ key: "JWT_SECRET", secret: true, configured: true, value: "never-return" }],
      managedBindings: [{ key: "DB_PASSWORD", owner: "platform_generated", configured: true, source: "Secrets Manager", value: "never-return" }],
      database: {}, blockers: [], readyToResume: true, resumeFromStage: "database_tier_setup", resumeSequence: [],
      configurationRevision: 1, savedAt: new Date(), appliedAt: null, verifiedAt: null,
    });
    assert.equal("value" in publicView.requiredInputs[0], false, "user secret values are removed from API responses");
    assert.equal("value" in publicView.managedBindings[0], false, "managed secret values are removed from API responses");
    assert.equal(publicView.applicationStatus, "pending_deployment", "saved and applied states remain distinct");

    const planner = new DeploymentRecoveryPlanner(
      new DeploymentCheckpointService(),
      new PreflightIssueMapper(),
      new EcsDiagnosticsClassifier(),
      new DatabaseRequirementAnalyzer(),
      new StorageRequirementAnalyzer(),
    );
    const recovery: any = planner.plan({
      projectId: "846665b9-ce31-405d-a131-b84457d80932", repositoryFullName: "owner/cattle-farm", branch: "main",
      contract: { blockers: ["Missing required environment variables: JWT_SECRET."], missingEnvVars: ["JWT_SECRET"], buildTimeEnvVars: [], databaseRequired: true },
      preflight: null, run: null, events: [], scan: null, environment: null, lock: null, storage: null, deployment: null,
      databaseTier: { provider: "managed" }, isDeploymentJobActive: false,
      stateSafety: { stateStatus: "missing", lockStatus: "none", lockId: null, heartbeatAt: null, releasedAt: null, validationStatus: "not_validated", validatedAt: null, stateVersionId: null, resourceCount: null, queueActive: false, activePipelineRunId: null, recoveryRequired: false, authoritativeTimestamp: null, supersedesHistoricalFailuresAt: null, sources: {}, currentStateInvalidation: { generation: 0, invalidatedAt: null, reason: null } },
      cloudState: { deploymentStatus: "not_deployed", healthStatus: "unknown", infrastructureStatus: "not_provisioned", resourceStatus: "no_cloud_resources_found", cleanupStatus: "not_requested", cloudVerificationStatus: "verified", inventoryStatus: "scanned", adminActionRequired: false, nextAction: "no_action", statusExplanation: "No issue", evidence: {}, lastCloudVerifiedAt: null, lastInventoryScanId: null, verificationTtlSeconds: 180 },
    } as any);
    assert.match(recovery.primaryActionRoute, /\/requirements\?focus=secrets$/, "recovery owns no duplicate form");

    const migration = await readFile(join(process.cwd(), "src/migrations/1760000029000-CanonicalDeploymentRequirements.ts"), "utf8");
    assert.match(migration, /is_active[^\n]+false/);
    assert.doesNotMatch(migration, /DELETE FROM\s+"project_environment_variables"/i, "reconciliation is non-destructive");
    const infrastructure = await readFile(join(process.cwd(), "src/infrastructure/infrastructure.service.ts"), "utf8");
    assert.match(infrastructure, /resolveEffectiveDeploymentConfiguration/, "ECS injection uses the canonical ownership resolver");
    const effectiveConfiguration = await readFile(join(process.cwd(), "src/infrastructure/database-service-binding.service.ts"), "utf8");
    assert.match(effectiveConfiguration, /variable\.isActive = true/, "canonical ownership resolution ignores superseded environment rows");
    assert.doesNotMatch(infrastructure, /database\.databaseName \|\| "app"/, "Terraform no longer invents a conflicting database name");
    assert.doesNotMatch(infrastructure, /database\.databaseUser \|\| "deployguard"/, "Terraform no longer invents a conflicting database user");
    const settings = await readFile(join(process.cwd(), "../frontend/src/pages/ProjectSettings.jsx"), "utf8");
    assert.doesNotMatch(settings, /<DatabaseTierSettings/, "Simple Settings no longer renders duplicate database configuration");
    const newProject = await readFile(join(process.cwd(), "../frontend/src/pages/NewProject.jsx"), "utf8");
    assert.doesNotMatch(newProject, /createProjectEnvVar/, "new-project flow no longer asks for arbitrary variables before scanning");
    assert.match(newProject, /connectGithubAppInstallation/, "new-project flow links an existing GitHub App installation");
    assert.match(newProject, /getGithubRepositories/, "new-project flow offers only authorized repositories");
    assert.match(newProject, /parseEnvPaste/, "new-project flow accepts one validated pasted .env block");
    assert.match(newProject, /bulkUpsertProjectEnvVars/, "new-project flow saves parsed application values securely");
    assert.match(newProject, /deployGithubActionsDeployment/, "new-project flow dispatches the canonical idempotent deployment");
    assert.doesNotMatch(newProject, /\/requirements/, "new-project flow does not require the retired Requirements page");
    const projectsService = await readFile(join(process.cwd(), "src/projects/projects.service.ts"), "utf8");
    assert.match(projectsService, /variable\.owner = defaults\.isRequired \? "user_required" : "user_optional"/, "bulk pasted values retain their resolved ownership");
    const requirementsPage = await readFile(join(process.cwd(), "../frontend/src/pages/DeploymentRequirements.jsx"), "utf8");
    assert.match(requirementsPage, /Re-authenticate and continue/, "expired auth has an actionable recovery path");
    assert.match(requirementsPage, /Save requirements/, "configuration has one save-only action");
    assert.match(requirementsPage, /Saving configuration never starts deployment/);
    assert.doesNotMatch(requirementsPage, /Save and deploy|Save without deploying/);
    const requirementsService = await readFile(join(process.cwd(), "src/projects/deployment-requirements.service.ts"), "utf8");
    assert.doesNotMatch(requirementsService, /this\.resume\.execute|StageSelectiveResumeService/);
    assert.match(requirementsService, /NORMAL_V1_DEPLOYMENT_REQUIRES_EXPLICIT_ACTION/);
    assert.doesNotMatch(
      requirementsPage,
      /isDeveloperMode|Developer Mode|configurationFingerprint|Resolved configuration/,
      "the canonical Environment surface must not expose technical binding internals",
    );
    console.log("Canonical Deployment Requirements ownership, reconciliation, recovery, secret safety, and Simple Mode verification passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main();
