import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { aliasesFor } from "../src/projects/configuration-ownership";
import { MANAGED_DATABASE_ENGINE_PROFILES, ManagedDatabaseEngine } from "../src/projects/managed-database-engine";

const scanner = new RepoDeployabilityScannerService();
const runtime = {
  framework: "express",
  packageManager: "npm",
  buildCommand: null,
  startCommand: "node server.js",
  expectedPort: 3000,
  healthCheckPath: "/health",
  staticOutput: false,
  hasDockerfile: false,
  requiresDatabase: false,
  requiresPersistentStorage: false,
};

async function fixture(name: string, files: Record<string, string>, ecosystem: "node" | "python") {
  const root = await mkdtemp(join(tmpdir(), `deployguard-${name}-`));
  for (const [file, contents] of Object.entries(files)) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return scanner.scan(root, { ...runtime, ecosystem, framework: ecosystem === "node" ? "express" : "flask", packageManager: ecosystem === "node" ? "npm" : "pip" });
}

async function main() {
  assert.deepEqual(Object.fromEntries(Object.entries(MANAGED_DATABASE_ENGINE_PROFILES).map(([engine, value]) => [engine, [value.image, value.port, value.dataPath]])), {
    postgres: ["postgres:16", 5432, "/var/lib/postgresql/data"],
    mysql: ["mysql:8", 3306, "/var/lib/mysql"],
    mongodb: ["mongo:8", 27017, "/data/db"],
  });

  const cases: Array<{ engine: ManagedDatabaseEngine; files: Record<string, string>; ecosystem: "node" | "python" }> = [
    { engine: "postgres", ecosystem: "node", files: { "package.json": JSON.stringify({ dependencies: { express: "1", pg: "1" }, scripts: { start: "node server.js" } }), "package-lock.json": "{}", "server.js": "app.listen(process.env.PORT,'0.0.0.0'); const host=process.env.DB_HOST" } },
    { engine: "mysql", ecosystem: "node", files: { "package.json": JSON.stringify({ dependencies: { express: "1", mysql2: "1" }, scripts: { start: "node server.js" } }), "package-lock.json": "{}", "server.js": "app.listen(process.env.PORT,'0.0.0.0'); const host=process.env.MYSQL_HOST" } },
    { engine: "mongodb", ecosystem: "node", files: { "package.json": JSON.stringify({ dependencies: { express: "1", mongoose: "1" }, scripts: { start: "node server.js" } }), "package-lock.json": "{}", "server.js": "app.listen(process.env.PORT,'0.0.0.0'); mongoose.connect(process.env.MONGODB_URI)" } },
    { engine: "postgres", ecosystem: "python", files: { "requirements.txt": "flask==3.0.0\npsycopg==3.2.0\n", "app.py": "import os\nDB=os.environ['DATABASE_URL']" } },
    { engine: "mysql", ecosystem: "python", files: { "requirements.txt": "flask==3.0.0\nPyMySQL==1.1.0\n", "app.py": "import os\nDB=os.environ['MYSQL_HOST']" } },
    { engine: "mongodb", ecosystem: "python", files: { "requirements.txt": "flask==3.0.0\npymongo==4.8.0\n", "app.py": "import os\nDB=os.environ['MONGODB_URI']" } },
  ];
  for (const test of cases) {
    const result = await fixture(`${test.ecosystem}-${test.engine}`, test.files, test.ecosystem);
    assert.equal(result.databaseRequired, true, `${test.ecosystem} ${test.engine} must require a database`);
    assert.equal(result.databaseEngine, test.engine, `${test.ecosystem} ${test.engine} must be deterministic`);
    if (test.engine === "mongodb") {
      const uri = result.environmentVariables.find((item) => item.key === "MONGODB_URI");
      assert.equal(uri?.secret, true, "MongoDB connection URIs must never enter public BuildPlan values");
    }
  }

  for (const [name, files, ecosystem] of [
    ["node-conflict", { "package.json": JSON.stringify({ dependencies: { express: "1", pg: "1", mysql2: "1" }, scripts: { start: "node server.js" } }), "package-lock.json": "{}", "server.js": "app.listen(process.env.PORT || 3000, '0.0.0.0'); const a=process.env.POSTGRES_HOST; const b=process.env.MYSQL_HOST" }, "node"],
    ["python-conflict", { "requirements.txt": "flask==3.0.0\npsycopg==3.2.0\npymongo==4.8.0\n", "app.py": "import os\na=os.environ['POSTGRES_HOST']\nb=os.environ['MONGODB_URI']" }, "python"],
    ["node-mongo-mysql-conflict", { "package.json": JSON.stringify({ dependencies: { express: "1", mongoose: "1", mysql2: "1" }, scripts: { start: "node server.js" } }), "package-lock.json": "{}", "server.js": "app.listen(process.env.PORT || 3000, '0.0.0.0'); const a=process.env.MONGODB_URI; const b=process.env.MYSQL_HOST" }, "node"],
  ] as const) {
    const result = await fixture(name, files, ecosystem);
    assert.equal(result.databaseEngine, null, `${name} must not select a database by precedence`);
    assert.match(result.deployabilityBlockers.join(" "), /DATABASE_ENGINE_AMBIGUOUS/, `${name} must fail closed on conflicting engine evidence`);
  }

  for (const engine of ["postgres", "mysql", "mongodb"] as const) {
    for (const property of ["host", "port", "database", "username", "password"] as const) {
      assert.ok(aliasesFor(engine, property).some((key) => key.startsWith("DB_")), `${engine} must expose generic DB_* ${property}`);
    }
  }
  assert.ok(aliasesFor("mongodb", "url").includes("MONGODB_URI"));
  assert.ok(aliasesFor("mongodb", "url").includes("MONGO_URL"));

  const workflow = readFileSync(resolve(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
  for (const expected of [
    /image\s+=\s+"postgres:16", port = 5432, data_path = "\/var\/lib\/postgresql\/data"/,
    /image\s+=\s+"mysql:8", port = 3306, data_path = "\/var\/lib\/mysql"/,
    /image\s+=\s+"mongo:8", port = 27017, data_path = "\/data\/db"/,
    /from_port\s+=\s+local\.database_profile\.port/,
    /containerPort = local\.database_profile\.port/,
    /initialization_environment/,
    /initialization_secret_names/,
    /url_query = "\?authSource=admin"/,
  ]) assert.match(workflow, expected);
  assert.doesNotMatch(workflow, /from_port\s+=\s+5432[\s\S]{0,80}to_port\s+=\s+5432/);

  console.log("Managed PostgreSQL, MySQL, and MongoDB engine profiles, JS/Python detection, aliases, and workflow parameterization passed.");
}

void main();
