import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DETECTION_INPUT_FINGERPRINT_VERSION, detectionFingerprint } from "../src/projects/analysis-fingerprint";
import { evaluateBuildPlanReadiness } from "../src/projects/build-plan-readiness";
import { DeploymentContractService } from "../src/projects/deployment-contract.service";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { StackDetectionService } from "../src/projects/detection/stack-detection.service";
import { TemplateMatchingService } from "../src/projects/detection/template-matching.service";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";
import { additionalFrameworkFixtures, topologyFixtures } from "../test-fixtures/topology-v2/fixtures";

const positiveMatrix = [
  ["React/Vite", "01-static-vite"],
  ["Express", "02-express-api"],
  ["React/Vite + Django + PostgreSQL", "32-separated-vite-django-postgresql"],
  ["React/Vite + FastAPI", "12-separated-vite-fastapi"],
  ["Flask Hello World (TCP readiness)", "04-flask-api"],
  ["Express + MongoDB", "17-managed-mongodb"],
  ["Express + PostgreSQL", "18-managed-postgresql"],
  ["Vue", "vue-vite"],
  ["SvelteKit", "sveltekit"],
] as const;

const tcpReadinessMatrix = [
  ["Django + PostgreSQL without a proven HTTP readiness route", "31-django-postgresql"],
  ["Flask without a proven HTTP readiness route", "04-flask-api"],
  ["FastAPI without a proven HTTP readiness route", "05-fastapi-api"],
] as const;

const negativeMatrix = [
  ["required React Native sibling", "33-required-react-native-sibling", /React Native|mobile/i],
  ["public/private ENV ownership violation", "22-frontend-db-no-owner-invalid", /database|runtime owner|frontend/i],
] as const;

async function analyze(name: string) {
  const fixture = [...topologyFixtures, ...additionalFrameworkFixtures].find((candidate) => candidate.name === name);
  assert.ok(fixture, `fixture '${name}' must exist`);
  const root = await mkdtemp(join(tmpdir(), `deployguard-reliability-${name}-`));
  try {
    for (const [path, content] of Object.entries(fixture.files)) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const project: any = {
      id: "41414141-4141-4141-8141-414141414141",
      repositoryUrl: `https://github.com/fixture/${name}`,
      repositoryFullName: `fixture/${name}`,
      targetBranch: "main",
      appDirectory: null,
      deploymentOverrides: {},
    };
    const detector = new StackDetectionService(new TemplateMatchingService(), new RepoDeployabilityScannerService());
    const draft = detector.detect(root, "a".repeat(40));
    draft.rawProfile.inputFingerprintVersion = DETECTION_INPUT_FINGERPRINT_VERSION;
    const profile: any = {
      id: "42424242-4242-4242-8242-424242424242",
      projectId: project.id,
      repositoryUrl: project.repositoryUrl,
      repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch,
      inputFingerprint: detectionFingerprint(project, draft.commitSha),
      ...draft,
    };
    let persisted: any = null;
    const docker = new DockerTemplateEngineService();
    const configuredEnvironment = name.includes("django")
      ? [{ key: "SECRET_KEY", value: "fixture-encrypted", isSecret: true, isActive: true }]
      : [];
    const contractService = new DeploymentContractService(
      {
        findOne: async () => persisted,
        create: (value: any) => ({ id: "43434343-4343-4343-8343-434343434343", ...value }),
        save: async (value: any) => { persisted = value; return value; },
      } as any,
      {} as any,
      {} as any,
      { find: async () => configuredEnvironment } as any,
      { findOne: async () => null, create: (value: any) => value, save: async (value: any) => value } as any,
      new TemplateRegistryService(),
      docker,
      { get: (_key: string, fallback: unknown) => fallback } as any,
    );
    const contract = await contractService.upsertFromDetection(project, profile);
    return { contract, draft, docker };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  for (const [label, name] of positiveMatrix) {
    const { contract, docker } = await analyze(name);
    const readiness = evaluateBuildPlanReadiness(contract.buildPlan);
    assert.ok(["READY", "READY_WITH_WARNINGS"].includes(readiness.status), `${label}: blockers=${readiness.blockers.join(" | ")} inputs=${readiness.requiredInputs.join(",")}`);
    assert.equal(contract.deployable, true, `${label}: real deployment contract must be deployable`);
    assert.ok(contract.buildPlan.components?.length, `${label}: real BuildPlan components`);
    const generated = contract.buildPlan.components!.length > 1
      ? Object.values(JSON.parse(contract.generatedDockerfile).components) as string[]
      : [contract.generatedDockerfile as string];
    assert.equal(generated.length, contract.buildPlan.components!.length, `${label}: every component has a generated image contract`);
    for (const dockerfile of generated) {
      assert.ok(dockerfile);
      assert.doesNotThrow(() => docker.validateGeneratedDockerfile(dockerfile), `${label}: pre-build Docker validation`);
      assert.doesNotMatch(dockerfile, /USER\s+(?:root|0)\s*$/i, `${label}: final runtime user`);
    }
    if (label.includes("Django")) {
      const frontend = contract.buildPlan.components!.find((component: any) => component.role === "frontend");
      if (frontend) assert.deepEqual(frontend.runtimeSystemDependencies, [], `${label}: PostgreSQL packages cannot leak into Vite`);
      const backend = contract.buildPlan.components!.find((component: any) => component.role === "backend" || component.role === "application");
      assert.ok(backend?.runtimeSystemDependencies.includes("libpq5"), `${label}: PostgreSQL runtime dependency remains backend-owned`);
    }
    console.log(`PASS ${label}: detection -> BuildPlan -> Docker generation -> pre-build validation`);
  }

  for (const [label, name] of tcpReadinessMatrix) {
    const { contract } = await analyze(name);
    const readiness = evaluateBuildPlanReadiness(contract.buildPlan);
    assert.ok(["READY", "READY_WITH_WARNINGS"].includes(readiness.status), `${label}: no explicit HTTP endpoint must use TCP readiness, blockers=${readiness.blockers.join(" | ")}`);
    const runtime = contract.buildPlan.components?.find((component: any) => component.role === "backend" || component.role === "application") || contract.buildPlan;
    assert.deepEqual({ mode: runtime?.healthCheckMode, path: runtime?.healthPath }, { mode: "tcp", path: null }, `${label}: no application health path is fabricated`);
    assert.equal(contract.deployable, true);
    console.log(`PASS ${label}: TCP readiness and platform HTTP liveness fallback`);
  }

  const ambiguous = await analyze("23-two-backends-ambiguous");
  const ambiguousReadiness = evaluateBuildPlanReadiness(ambiguous.contract.buildPlan);
  assert.equal((ambiguous.draft.rawProfile.componentTopology as any).analysisState, "INPUT_REQUIRED");
  assert.equal(ambiguousReadiness.status, "INPUT_REQUIRED", `two-backend blockers: ${ambiguousReadiness.blockers.join(" | ")}`);
  assert.deepEqual(ambiguousReadiness.requiredInputs, ["Choose which of these backend service roots should be deployed."]);
  console.log("PASS two viable backends: INPUT_REQUIRED with an actionable service choice");

  for (const [label, name, evidence] of negativeMatrix) {
    const { contract, draft } = await analyze(name);
    const topology = draft.rawProfile.componentTopology as any;
    assert.equal(contract.deployable, false, `${label}: must fail closed`);
    assert.ok(["UNRESOLVED", "UNSUPPORTED"].includes(topology.analysisState), `${label}: canonical topology state`);
    assert.match([...contract.blockers, ...topology.blockers].join(" "), evidence, `${label}: actionable blocker`);
    console.log(`PASS ${label}: intentionally blocked`);
  }

  const workspace = await analyze("workspace-install-root-preserved");
  const workspaceComponent = workspace.contract.buildPlan.components!.find((component: any) => component.id === "frontend");
  assert.deepEqual(
    { detected: workspace.draft.rawProfile.repositoryInstallRoot, contract: workspace.contract.buildPlan.repositoryInstallRoot, component: workspaceComponent?.repositoryInstallRoot, appRoot: workspaceComponent?.root, buildContext: workspaceComponent?.buildContext },
    { detected: ".", contract: ".", component: ".", appRoot: "apps/web", buildContext: "apps/web" },
    "workspace install root must remain canonical through the component BuildPlan",
  );
  console.log("PASS workspace install-root invariant: detector -> DeploymentContract -> component BuildPlan");

  const samePort = await analyze("same-port-next-express");
  assert.deepEqual(samePort.contract.buildPlan.components!.map((component: any) => component.port), [3000, 3001], "BuildPlan persists deterministic unique awsvpc ports");
  assert.equal(samePort.contract.deployable, true);
  console.log("PASS same-port multi-container invariant: detector ports -> unique BuildPlan task ports");

  console.log("Reliability fixture matrix passed: deployable paths, unknown-readiness gates, and complete-repository negative gates use real detection and BuildPlan generation.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
