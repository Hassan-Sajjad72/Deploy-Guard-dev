import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DETECTION_INPUT_FINGERPRINT_VERSION, detectionFingerprint } from "../src/projects/analysis-fingerprint";
import { evaluateBuildPlanReadiness } from "../src/projects/build-plan-readiness";
import { DeploymentContractService } from "../src/projects/deployment-contract.service";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { StackDetectionService } from "../src/projects/detection/stack-detection.service";
import { TemplateMatchingService } from "../src/projects/detection/template-matching.service";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";

type Engine = "postgres" | "mysql" | "mongodb";

type Fixture = {
  name: string;
  relativePath: string;
  engine: Engine;
  expectedFramework: string;
  expectedFrameworkMode?: string;
  expectedHealth: string;
  expectedPort: number;
  env: Record<string, string>;
  migrationCommand?: string;
};

const repository = resolve(__dirname, "../..");
// Certification fixtures belong to this repository. Do not depend on an
// unpacked external app bundle that is absent from normal product checkouts.
const fixtureRoot = resolve(repository, "backend/test-fixtures/real-database-apps");
const suiteRoot = mkdtempSync(join(tmpdir(), "deployguard-real-db-certification-"));
const resources: Array<{ name: string; image: string; network: string }> = [];

const fixtures: Fixture[] = [
  {
    name: "express-js-postgresql",
    relativePath: "express-js-postgresql",
    engine: "postgres",
    expectedFramework: "express",
    expectedHealth: "/health",
    expectedPort: 3000,
    env: { PORT: "3000", DATABASE_URL: "postgresql://app:certification-password@db:5432/appdb" },
  },
  {
    name: "fastify-js-mysql",
    relativePath: "fastify-js-mysql",
    engine: "mysql",
    expectedFramework: "fastify",
    expectedHealth: "/health",
    expectedPort: 3000,
    env: { PORT: "3000", DB_HOST: "db", DB_PORT: "3306", DB_NAME: "appdb", DB_USER: "app", DB_PASSWORD: "certification-password" },
  },
  {
    name: "express-ts-mongodb",
    relativePath: "express-ts-mongodb",
    engine: "mongodb",
    expectedFramework: "express",
    expectedHealth: "/health",
    expectedPort: 3000,
    env: { PORT: "3000", MONGODB_URI: "mongodb://app:certification-password@db:27017/appdb?authSource=admin" },
  },
  {
    name: "django-wsgi-postgresql",
    relativePath: "django-wsgi-postgresql",
    engine: "postgres",
    expectedFramework: "django",
    expectedFrameworkMode: "django-wsgi",
    expectedHealth: "/health",
    expectedPort: 8000,
    env: { DB_HOST: "db", DB_PORT: "5432", DB_NAME: "appdb", DB_USER: "app", DB_PASSWORD: "certification-password", DJANGO_SECRET_KEY: "certification-secret-key" },
    migrationCommand: "python manage.py migrate --noinput",
  },
];

function docker(args: string[], options: { encoding?: "utf8"; timeout?: number } = {}) {
  return execFileSync("docker", args, { encoding: options.encoding, timeout: options.timeout || 180_000, stdio: options.encoding ? "pipe" : "inherit" });
}

function environmentArgs(env: Record<string, string>) {
  return Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

async function contractFor(fixture: Fixture, source: string) {
  const project: any = {
    id: "61616161-6161-4161-8161-616161616161",
    repositoryUrl: `https://github.com/deployguard-fixture/${fixture.name}`,
    repositoryFullName: `deployguard-fixture/${fixture.name}`,
    targetBranch: "main",
    appDirectory: null,
    deploymentOverrides: {},
  };
  const detector = new StackDetectionService(new TemplateMatchingService(), new RepoDeployabilityScannerService());
  const draft = detector.detect(source, "d".repeat(40));
  draft.rawProfile.inputFingerprintVersion = DETECTION_INPUT_FINGERPRINT_VERSION;
  const profile: any = {
    id: "62626262-6262-4262-8262-626262626262",
    projectId: project.id,
    repositoryUrl: project.repositoryUrl,
    repositoryFullName: project.repositoryFullName,
    targetBranch: project.targetBranch,
    inputFingerprint: detectionFingerprint(project, draft.commitSha),
    ...draft,
  };
  let persisted: any = null;
  const contracts = new DeploymentContractService(
    { findOne: async () => persisted, create: (value: any) => ({ id: "63636363-6363-4363-8363-636363636363", ...value }), save: async (value: any) => { persisted = value; return value; } } as any,
    {} as any,
    {} as any,
    { find: async () => [] } as any,
    { findOne: async () => null, create: (value: any) => value, save: async (value: any) => value } as any,
    new TemplateRegistryService(),
    new DockerTemplateEngineService(),
    { get: (_key: string, fallback: unknown) => fallback } as any,
  );
  return { draft, contract: await contracts.upsertFromDetection(project, profile) };
}

function waitFor(label: string, test: () => void, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      test();
      return;
    } catch (error) {
      lastError = error;
      spawnSync("sleep", ["1"]);
    }
  }
  throw new Error(`${label} did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function startDatabase(fixture: Fixture, network: string, name: string) {
  if (fixture.engine === "postgres") {
    docker(["run", "-d", "--name", name, "--network", network, "--network-alias", "db", "-e", "POSTGRES_DB=appdb", "-e", "POSTGRES_USER=app", "-e", "POSTGRES_PASSWORD=certification-password", "postgres:16-alpine"]);
    waitFor(`${fixture.name} PostgreSQL`, () => docker(["exec", name, "pg_isready", "-U", "app", "-d", "appdb"]));
    return;
  }
  if (fixture.engine === "mysql") {
    docker(["run", "-d", "--name", name, "--network", network, "--network-alias", "db", "-e", "MYSQL_DATABASE=appdb", "-e", "MYSQL_USER=app", "-e", "MYSQL_PASSWORD=certification-password", "-e", "MYSQL_ROOT_PASSWORD=certification-root-password", "mysql:8.4"]);
    waitFor(`${fixture.name} MySQL`, () => docker(["exec", name, "mysql", "-uapp", "-pcertification-password", "-e", "SELECT 1", "appdb"]));
    return;
  }
  docker(["run", "-d", "--name", name, "--network", network, "--network-alias", "db", "-e", "MONGO_INITDB_ROOT_USERNAME=app", "-e", "MONGO_INITDB_ROOT_PASSWORD=certification-password", "mongo:7"]);
  waitFor(`${fixture.name} MongoDB`, () => docker(["exec", name, "mongosh", "--quiet", "--username", "app", "--password", "certification-password", "--authenticationDatabase", "admin", "--eval", "db.adminCommand({ping:1}).ok"]));
}

async function main() {
  for (const fixture of fixtures) {
    const source = join(fixtureRoot, fixture.relativePath);
    assert.ok(existsSync(source), `${fixture.name}: source fixture exists`);
    assert.equal(existsSync(join(source, "Dockerfile")), false, `${fixture.name}: fixture Dockerfile must not be used`);
    const context = join(suiteRoot, fixture.name);
    cpSync(source, context, { recursive: true });
    rmSync(join(context, ".env"), { force: true });
    rmSync(join(context, ".env.example"), { force: true });
    const image = `deployguard-real-db-certification:${process.pid}-${fixture.name}`;
    const network = `deployguard-real-db-${process.pid}-${fixture.name}`;
    const database = `${network}-database`;
    const application = `${network}-application`;
    resources.push({ name: application, image, network }, { name: database, image: "", network });

    // Original fixture configuration is deliberately checked first. Any local-only database endpoint must block the AWS path.
    const original = await contractFor(fixture, source);
    const originalLocalDatabase = original.contract.blockers.some((blocker: string) => /Local database configuration detected/.test(blocker));
    if (originalLocalDatabase) assert.equal(original.contract.deployable, false, `${fixture.name}: local database configuration must not become an AWS runtime contract`);
    else assert.equal(original.contract.deployable, true, `${fixture.name}: original production-safe fixture context remains deployable`);

    // Contract generation is then performed on the production build context, where .env is excluded. The build consumes only this generated Dockerfile.
    const { draft, contract } = await contractFor(fixture, context);
    const plan = contract.buildPlan;
    const component = plan.components?.[0];
    assert.ok(component, `${fixture.name}: one deployable component`);
    assert.equal(contract.deployable, true, `${fixture.name}: deployable contract ${JSON.stringify({ blockers: contract.blockers, readiness: evaluateBuildPlanReadiness(plan), localhostSources: draft.rawProfile.databaseLocalhostSources })}`);
    assert.ok(["READY", "READY_WITH_WARNINGS"].includes(evaluateBuildPlanReadiness(plan).status), `${fixture.name}: immutable BuildPlan readiness`);
    assert.equal(component.framework, fixture.expectedFramework, `${fixture.name}: framework remains identical downstream`);
    if (fixture.expectedFrameworkMode) assert.equal(component.frameworkMode, fixture.expectedFrameworkMode, `${fixture.name}: framework mode remains identical downstream`);
    assert.equal(plan.appRoot, draft.rawProfile.appDirectory, `${fixture.name}: appRoot remains identical downstream`);
    assert.equal(component.root, plan.appRoot, `${fixture.name}: component root remains identical downstream`);
    assert.equal(component.buildContext, plan.appRoot, `${fixture.name}: buildContext remains identical downstream`);
    assert.equal(plan.repositoryInstallRoot, draft.rawProfile.repositoryInstallRoot, `${fixture.name}: installRoot remains identical downstream`);
    assert.equal(component.repositoryInstallRoot, plan.repositoryInstallRoot, `${fixture.name}: component installRoot remains identical downstream`);
    assert.equal(component.port, fixture.expectedPort, `${fixture.name}: port remains identical downstream`);
    assert.equal(component.healthPath, fixture.expectedHealth, `${fixture.name}: health remains identical downstream`);
    assert.equal(component.database.engine, draft.databaseType, `${fixture.name}: database fact remains identical downstream`);
    assert.ok(Array.isArray(component.environmentOwnership), `${fixture.name}: ENV ownership is immutable structured data`);
    assert.equal(typeof contract.generatedDockerfile, "string", `${fixture.name}: DeployGuard generated Dockerfile`);
    writeFileSync(join(context, "Dockerfile.deployguard"), contract.generatedDockerfile as string);
    writeFileSync(join(context, ".dockerignore"), ".git\n.env\n.env.*\nnode_modules\n__pycache__\nDockerfile\n");
    const buildArgs = ["buildx", "build", "--load", "-f", join(context, "Dockerfile.deployguard"), "-t", image];
    const buildSecret = join(context, "deployguard-build-runtime.json");
    if ((contract.generatedDockerfile as string).includes("deployguard_runtime_config")) {
      writeFileSync(buildSecret, JSON.stringify(fixture.env), { mode: 0o600 });
      buildArgs.push("--secret", `id=deployguard_runtime_config,src=${buildSecret}`);
    }
    buildArgs.push(context);
    docker(buildArgs, { timeout: 420_000 });
    rmSync(buildSecret, { force: true });
    const configuredUser = docker(["image", "inspect", image, "--format", "{{.Config.User}}"], { encoding: "utf8" }).trim();
    assert.ok(configuredUser && configuredUser !== "0" && configuredUser !== "root", `${fixture.name}: generated image runs as non-root`);

    docker(["network", "create", network]);
    startDatabase(fixture, network, database);
    if (fixture.migrationCommand) docker(["run", "--rm", "--network", network, ...environmentArgs(fixture.env), image, "sh", "-c", fixture.migrationCommand]);
    docker(["run", "-d", "--name", application, "--network", network, ...environmentArgs(fixture.env), "-p", `127.0.0.1::${component.port}`, image]);
    const hostPort = docker(["inspect", application, "--format", `{{(index (index .NetworkSettings.Ports \"${component.port}/tcp\") 0).HostPort}}`], { encoding: "utf8" }).trim();
    let body = "";
    waitFor(`${fixture.name} application health`, () => {
      body = execFileSync("curl", ["--fail", "--silent", "--show-error", "--max-time", "3", `http://127.0.0.1:${hostPort}${component.healthPath}`], { encoding: "utf8" });
      if (fixture.name === "django-wsgi-postgresql") assert.match(body, /\"status\"\s*:\s*\"ok\"/);
      else assert.match(body, new RegExp(`\\\"database\\\":\\\"${fixture.engine === "mongodb" ? "mongodb" : fixture.engine}\\\"`));
    });
    assert.notEqual(docker(["exec", application, "id", "-u"], { encoding: "utf8" }).trim(), "0", `${fixture.name}: running container is non-root`);
    console.log(`PASS ${fixture.name}: ${originalLocalDatabase ? "original local DB config blocks; " : "original repository is deployable; "}sanitized production context has immutable handoff, generated Docker build, live ${fixture.engine} connectivity${fixture.migrationCommand ? ", migration" : ""}, health, non-root runtime, cleanup`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  for (const resource of resources.reverse()) {
    if (resource.name) spawnSync("docker", ["rm", "-f", resource.name], { stdio: "ignore" });
    if (resource.image) spawnSync("docker", ["image", "rm", "-f", resource.image], { stdio: "ignore" });
    if (resource.network) spawnSync("docker", ["network", "rm", resource.network], { stdio: "ignore" });
  }
  rmSync(suiteRoot, { recursive: true, force: true });
});
