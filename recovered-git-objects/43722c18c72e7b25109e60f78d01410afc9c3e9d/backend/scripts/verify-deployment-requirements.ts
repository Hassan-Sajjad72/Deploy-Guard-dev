import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeploymentRequirementsService } from "../src/projects/deployment-requirements.service";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { DeploymentCheckpointService } from "../src/projects/recovery/deployment-checkpoint.service";
import { DeploymentRecoveryPlanner } from "../src/projects/recovery/deployment-recovery-planner.service";

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

    const planner = new DeploymentRecoveryPlanner(new DeploymentCheckpointService());
    const recovery: any = planner.plan({
      projectId: "846665b9-ce31-405d-a131-b84457d80932", repositoryFullName: "owner/cattle-farm", branch: "main",
      contract: { blockers: ["Missing required environment variables: JWT_SECRET."], missingEnvVars: ["JWT_SECRET"], buildTimeEnvVars: [], databaseRequired: true },
      preflight: null, run: null, events: [], scan: null, environment: null, lock: null, storage: null, deployment: null,
      databaseTier: { provider: "managed" }, isDeploymentJobActive: false,
      cloudState: { deploymentStatus: "not_deployed", healthStatus: "unknown", infrastructureStatus: "not_provisioned", resourceStatus: "no_cloud_resources_found", cleanupStatus: "not_requested", cloudVerificationStatus: "verified", inventoryStatus: "scanned", adminActionRequired: false, nextAction: "no_action", statusExplanation: "No issue", evidence: {}, lastCloudVerifiedAt: null, lastInventoryScanId: null, verificationTtlSeconds: 180 },
    } as any);
    assert.match(recovery.primaryActionRoute, /\/requirements\?focus=secrets$/, "recovery owns no duplicate form");

    const migration = await readFile(join(process.cwd(), "src/migrations/1760000029000-CanonicalDeploymentRequirements.ts"), "utf8");
    assert.match(migration, /is_active[^\n]+false/);
    assert.doesNotMatch(migration, /DELETE FROM\s+"project_environment_variables"/i, "reconciliation is non-destructive");
    const infrastructure = await readFile(join(process.cwd(), "src/infrastructure/infrastructure.service.ts"), "utf8");
    assert.match(infrastructure, /env\.isActive = true/, "ECS injection ignores superseded environment rows");
    assert.doesNotMatch(infrastructure, /database\.databaseName \|\| "app"/, "Terraform no longer invents a conflicting database name");
    assert.doesNotMatch(infrastructure, /database\.databaseUser \|\| "deployguard"/, "Terraform no longer invents a conflicting database user");
    const settings = await readFile(join(process.cwd(), "../frontend/src/pages/ProjectSettings.jsx"), "utf8");
    assert.doesNotMatch(settings, /<DatabaseTierSettings/, "Simple Settings no longer renders duplicate database configuration");
    const newProject = await readFile(join(process.cwd(), "../frontend/src/pages/NewProject.jsx"), "utf8");
    assert.doesNotMatch(newProject, /createProjectEnvVar/, "new-project flow no longer asks for arbitrary variables before scanning");
    assert.match(newProject, /\/requirements/, "repository analysis opens canonical requirements");
    const requirementsPage = await readFile(join(process.cwd(), "../frontend/src/pages/DeploymentRequirements.jsx"), "utf8");
    assert.match(requirementsPage, /Re-authenticate and continue/, "expired auth has an actionable recovery path");
    assert.match(requirementsPage, /Save and resume deployment/, "one primary resolution action is rendered");
    assert.match(requirementsPage, /isDeveloperMode/, "resolved technical bindings remain Developer Mode only");
    console.log("Canonical Deployment Requirements ownership, reconciliation, recovery, secret safety, and Simple Mode verification passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main();
