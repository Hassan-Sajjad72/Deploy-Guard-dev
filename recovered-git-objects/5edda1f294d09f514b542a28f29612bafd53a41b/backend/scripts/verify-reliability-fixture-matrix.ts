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
import { topologyFixtures } from "../test-fixtures/topology-v2/fixtures";

const positiveMatrix = [
  ["React/Vite", "01-static-vite"],
  ["Express", "02-express-api"],
  ["React/Vite + Django + PostgreSQL", "32-separated-vite-django-postgresql"],
  ["React/Vite + FastAPI", "12-separated-vite-fastapi"],
] as const;

const readinessBlockMatrix = [
  ["Next.js without a proven HTTP readiness route", "15-next-ssr"],
  ["Django + PostgreSQL without a proven HTTP readiness route", "31-django-postgresql"],
  ["Flask without a proven HTTP readiness route", "04-flask-api"],
  ["FastAPI without a proven HTTP readiness route", "05-fastapi-api"],
] as const;

const negativeMatrix = [
  ["required React Native sibling", "33-required-react-native-sibling", /React Native|mobile/i],
  ["two viable backends", "23-two-backends-ambiguous", /backend|multiple/i],
  ["public/private ENV ownership violation", "22-frontend-db-no-owner-invalid", /database|runtime owner|frontend/i],
] as const;

async function analyze(name: string) {
  const fixture = topologyFixtures.find((candidate) => candidate.name === name);
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

  for (const [label, name] of readinessBlockMatrix) {
    const { contract } = await analyze(name);
    const readiness = evaluateBuildPlanReadiness(contract.buildPlan);
    assert.equal(readiness.status, "BLOCKED", `${label}: unknown ALB HTTP readiness must fail closed`);
    assert.match(readiness.blockers.join(" "), /public HTTP readiness endpoint could not be proven/i);
    assert.equal(contract.deployable, false);
    console.log(`PASS ${label}: intentionally blocked before dispatch`);
  }

  for (const [label, name, evidence] of negativeMatrix) {
    const { contract, draft } = await analyze(name);
    const topology = draft.rawProfile.componentTopology as any;
    assert.equal(contract.deployable, false, `${label}: must fail closed`);
    assert.ok(["UNRESOLVED", "UNSUPPORTED"].includes(topology.analysisState), `${label}: canonical topology state`);
    assert.match([...contract.blockers, ...topology.blockers].join(" "), evidence, `${label}: actionable blocker`);
    console.log(`PASS ${label}: intentionally blocked`);
  }

  console.log("Reliability fixture matrix passed: deployable paths, unknown-readiness gates, and complete-repository negative gates use real detection and BuildPlan generation.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
