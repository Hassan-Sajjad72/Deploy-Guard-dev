import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Logger } from "@nestjs/common";
import { StackDetectionService, DetectedApplicationTopology } from "../src/projects/detection/stack-detection.service";
import { TemplateMatchingService } from "../src/projects/detection/template-matching.service";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { RelationshipInferenceService } from "../src/projects/detection/relationship-inference.service";
import { hasCurrentCanonicalTopology, TOPOLOGY_ANALYZER_VERSION, TOPOLOGY_SCHEMA_VERSION } from "../src/projects/detection/topology.types";
import { DeploymentProfileService } from "../src/projects/detection/deployment-profile.service";
import { detectionFingerprint } from "../src/projects/analysis-fingerprint";
import { additionalFrameworkFixtures, topologyFixtures, TopologyFixture } from "../test-fixtures/topology-v2/fixtures";

const detector = new StackDetectionService(new TemplateMatchingService(), new RepoDeployabilityScannerService());
Logger.overrideLogger([]);

async function analyze(fixture: TopologyFixture) {
  const root = await mkdtemp(join(tmpdir(), `deployguard-${fixture.name}-`));
  try {
    for (const [name, content] of Object.entries(fixture.files)) {
      const target = join(root, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const first = detector.detect(root, "d".repeat(40));
    const second = detector.detect(root, "d".repeat(40));
    const topology = first.rawProfile.componentTopology as DetectedApplicationTopology;
    const repeat = second.rawProfile.componentTopology as DetectedApplicationTopology;
    assert.ok(topology, `${fixture.name}: canonical topology`);
    assert.equal(topology.schemaVersion, 3, `${fixture.name}: schema`);
    assert.equal(topology.shape, fixture.shape, `${fixture.name}: shape (${topology.blockers.join(" | ")})`);
    assert.equal(topology.analysisState, fixture.state, `${fixture.name}: state (${topology.blockers.join(" | ")})`);
    assert.ok(Array.isArray(topology.evidence), `${fixture.name}: evidence inventory`);
    assert.ok(Array.isArray(topology.applicationUnits), `${fixture.name}: application units`);
    assert.ok(Array.isArray(topology.relationships), `${fixture.name}: relationships`);
    assert.ok(Array.isArray(topology.serviceBindings), `${fixture.name}: service bindings`);
    assert.ok(Array.isArray(topology.requiredUserInputs), `${fixture.name}: actionable inputs`);
    assert.ok(Array.isArray(topology.artifacts), `${fixture.name}: artifacts`);
    assert.deepEqual(JSON.parse(JSON.stringify(topology)), JSON.parse(JSON.stringify(repeat)), `${fixture.name}: deterministic output`);
    for (const component of topology.components) {
      assert.ok(component.id && component.role && component.root && component.buildContext, `${fixture.name}: component identity`);
      assert.ok(component.framework && component.frameworkVariant && component.port > 0, `${fixture.name}: runtime contract`);
      if (component.healthCheckMode === "tcp") assert.equal(component.healthCheckPath, null, `${fixture.name}: TCP health must not invent an HTTP path`);
      else assert.ok(component.healthCheckPath?.startsWith("/"), `${fixture.name}: HTTP health path`);
      assert.ok(Array.isArray(component.environment), `${fixture.name}: ENV ownership`);
    }
    if (fixture.database) {
      assert.equal(topology.managedDatabase?.engine, fixture.database, `${fixture.name}: DB engine`);
      assert.ok(topology.relationships.some((item) => item.kind === "USES_DATABASE"), `${fixture.name}: DB owner`);
    }
    if (fixture.name === "angular-multiple-projects-without-default") {
      assert.ok((first.rawProfile.detectorRequiredInputs as string[] || []).includes("ANGULAR_APPLICATION_SELECTION"), "Angular ambiguity remains an explicit input/blocker instead of selecting the first project");
      assert.equal((first.rawProfile.outputDirectory as string | null) || null, null, "Angular ambiguity cannot inherit an alphabetical output directory");
    }
    if (fixture.name === "plain-static-arbitrary-directory") {
      assert.equal(topology.components[0]?.root, "dashboard", "plain static identity comes from entrypoint/assets, not a preferred directory name");
    }
    if (fixture.name === "flask-framework-owned-templates-and-static") {
      assert.deepEqual(topology.components.map((component) => ({ framework: component.framework, root: component.root, role: component.role })), [{ framework: "flask", root: "src", role: "backend" }], "Flask templates/static remain inside their owning application boundary");
      assert.equal(topology.components.some((component) => component.root === "src/templates"), false, "Flask templates cannot become a static frontend");
    }
    if (fixture.name === "flask-with-independent-static-frontend") {
      assert.deepEqual(topology.components.map((component) => component.root).sort(), ["src", "web"], "a sibling static application remains independently deployable");
    }
    if (fixture.name === "flask-nested-application-roots-own-assets") {
      assert.equal(topology.components.some((component) => /(?:templates|static)$/.test(component.root)), false, "each nested Flask root retains its own framework assets");
    }
    if (fixture.name === "workspace-install-root-preserved") {
      assert.equal((topology.components[0]?.profile.rawProfile as Record<string, unknown>).repositoryInstallRoot, ".", "workspace repository install root remains distinct from component root");
      assert.equal(topology.components[0]?.buildContext, "apps/web");
    }
    if (fixture.name === "same-port-next-express") {
      assert.deepEqual(topology.components.map((component) => component.port), [3000, 3001], "same detected ports receive deterministic unique awsvpc task ports");
      assert.equal(new Set(topology.components.map((component) => component.port)).size, topology.components.length, "every application container port is unique");
    }
    if (fixture.name === "postgresql-plus-redis-cache") {
      assert.equal(topology.managedDatabase?.engine, "postgres", "Redis cache evidence cannot become a competing primary database engine");
      assert.doesNotMatch(topology.blockers.join(" "), /DATABASE_ENGINE_AMBIGUOUS/);
    }
    if (fixture.name === "nested-workspace-worker-unsupported") {
      assert.match(topology.blockers.join(" "), /required worker process/i, "nested workspace worker evidence blocks a partial web-only deployment");
    }
    if (fixture.name === "global-online-learning-academy-process-cwd-static") {
      const detected = topology.components.flatMap((component) => {
        const raw = component.profile.rawProfile as Record<string, any>;
        return Array.isArray(raw.environmentVariables) ? raw.environmentVariables : [];
      }).find((item) => item.key === "DISABLE_HMR");
      assert.deepEqual({ requirement: detected?.requirement, productionRelevant: detected?.productionRelevant }, { requirement: "optional", productionRelevant: false }, "Vite server-only HMR configuration is classified but excluded from production");
      assert.equal(topology.components.some((component) => component.environment.some((item) => item.name === "DISABLE_HMR")), false, "development-only ENV cannot enter canonical production topology");
    }
    if (["UNRESOLVED", "UNSUPPORTED"].includes(fixture.state)) assert.equal(topology.status, "blocked", `${fixture.name}: fail closed`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function main() {
  const canonicalEnvelope = { componentTopology: { schemaVersion: TOPOLOGY_SCHEMA_VERSION, analyzerVersion: TOPOLOGY_ANALYZER_VERSION, components: [], relationships: [], serviceBindings: [], requiredUserInputs: [], artifacts: [], blockers: [] } };
  assert.equal(hasCurrentCanonicalTopology(canonicalEnvelope), true, "current empty canonical topology remains authoritative");
  assert.equal(hasCurrentCanonicalTopology({ componentTopology: { ...canonicalEnvelope.componentTopology, analyzerVersion: "topology-detection-v1" } }), false, "stale analyzer versions require re-analysis");
  assert.equal(hasCurrentCanonicalTopology({ componentTopology: { ...canonicalEnvelope.componentTopology, schemaVersion: 1 } }), false, "stale topology schemas require re-analysis");
  const project: any = { id: "11111111-1111-4111-8111-111111111111", repositoryUrl: "https://github.com/example/app", repositoryFullName: "example/app", targetBranch: "main", appDirectory: null, deploymentOverrides: {} };
  const commitSha = "a".repeat(40);
  const staleProfile: any = { projectId: project.id, commitSha, inputFingerprint: detectionFingerprint(project, commitSha), detectionStatus: "success", rawProfile: { componentTopology: { ...canonicalEnvelope.componentTopology, analyzerVersion: "topology-detection-v1" } } };
  const profileService = new DeploymentProfileService(
    { findOne: async () => staleProfile } as any,
    { getProjectEntityForManage: async () => project } as any,
    { resolveRemoteCommit: async () => commitSha } as any,
    {} as any, {} as any, {} as any,
    { tokenForRepository: async () => ({ token: "test" }) } as any,
  );
  let reanalyzed = false;
  (profileService as any).runDetection = async () => { reanalyzed = true; return { id: "fresh" }; };
  await profileService.getOrRunDetection({ id: "user" } as any, project.id);
  assert.equal(reanalyzed, true, "a stale topology analyzer version must force repository re-analysis even when the commit and fingerprint match");
  const relationships = new RelationshipInferenceService();
  assert.equal(relationships.resolvePathExpression("path.join(process.cwd(), 'dist')"), "dist", "process.cwd static roots resolve");
  assert.equal(relationships.resolvePathExpression("path.join(process.cwd(), missingRoot, 'dist')"), null, "partially resolved paths fail closed");
  assert.equal(topologyFixtures.length, 33, "the required positive and negative reliability fixture matrix must stay complete");
  for (const fixture of [...topologyFixtures, ...additionalFrameworkFixtures]) await analyze(fixture);
  console.log(`Topology Detection V2 certification passed: ${topologyFixtures.length} canonical fixtures plus ${additionalFrameworkFixtures.length} framework boundary fixtures; deterministic output verified.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
