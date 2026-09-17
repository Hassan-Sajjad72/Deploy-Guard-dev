import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = process.cwd();
const envFile = ".env.container.example";
const composeSource = readFileSync("compose.yaml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const backendDockerfile = readFileSync("backend/Dockerfile", "utf8");
const gitignore = readFileSync(".gitignore", "utf8");

const canonical = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

const compose = JSON.parse(execFileSync(
  "docker",
  ["compose", "--env-file", envFile, "config", "--format", "json"],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
));

assert.deepEqual(
  Object.keys(compose.services).sort(),
  ["backend", "frontend", "grafana", "migrate", "postgres", "prometheus"].sort(),
  "the default Compose application must contain the complete product",
);
assert.equal(compose.services.backend.environment.DATABASE_HOST, "postgres");
assert.equal(compose.services.backend.environment.DATABASE_PORT, "5432");
assert.equal(compose.services.backend.environment.DATABASE_USERNAME, canonical.POSTGRES_USER);
assert.equal(compose.services.backend.environment.DATABASE_PASSWORD, canonical.POSTGRES_PASSWORD);
assert.equal(compose.services.backend.environment.DATABASE_NAME, canonical.POSTGRES_DB);
assert.equal(compose.services.migrate.depends_on.postgres.condition, "service_healthy");
assert.equal(compose.services.backend.depends_on.migrate.condition, "service_completed_successfully");
assert.equal(compose.services.frontend.depends_on.backend.condition, "service_healthy");
assert.equal(compose.services.prometheus.depends_on.backend.condition, "service_healthy");
assert.equal(compose.services.grafana.depends_on.prometheus.condition, "service_healthy");
assert.equal(compose.services.prometheus.environment.PROMETHEUS_SCRAPE_TARGET, "backend:5000");
assert.equal(compose.services.backend.environment.PROMETHEUS_BASE_URL, "http://prometheus:9090");

assert.match(composeSource, /env_file:\n\s+- \.env\.container/);
assert.doesNotMatch(composeSource, /backend\/\.env|host\.docker\.internal|privileged:|\/var\/run\/docker\.sock/);
assert.doesNotMatch(composeSource, /\/home\/|\/Users\/|[A-Za-z]:\\\\Users\\\\/);
assert.match(packageJson.scripts["product:start"], /docker compose --env-file \.env\.container up --build --wait/);
assert.match(backendDockerfile, /hashicorp\/terraform:1\.10\.5/);
for (const executable of ["awscli", "curl", "git", "openssh-client", "infracost"]) {
  assert.match(backendDockerfile, new RegExp(executable.replace("-", "\\-")));
}
assert.match(gitignore, /\.env\.\*/);
assert.match(gitignore, /!\.env\.container\.example/);

console.log("Canonical portable-container environment contract passed (values withheld).");
