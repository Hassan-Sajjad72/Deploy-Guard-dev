import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { StackDetectionService, DetectedApplicationTopology } from "../src/projects/detection/stack-detection.service";
import { TemplateMatchingService } from "../src/projects/detection/template-matching.service";

const scanner = new RepoDeployabilityScannerService();
const detector = new StackDetectionService(new TemplateMatchingService(), scanner);

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "deployguard-part1-authority-"));
  for (const [name, value] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), value);
  }
  return root;
}

const profile = (overrides: Record<string, unknown> = {}) => ({
  ecosystem: "node", framework: "express", packageManager: "npm", buildCommand: null,
  startCommand: "node server.js", expectedPort: 3000, healthCheckPath: null,
  staticOutput: false, hasDockerfile: false, requiresDatabase: false,
  requiresPersistentStorage: false, rawProfile: {}, ...overrides,
});

async function main() {
  const noPort = await repository({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "5.0.0" } }),
    "package-lock.json": "{}",
    "server.js": "require('express')().listen()",
  });
  try {
    const result = scanner.scan(noPort, profile());
    assert.equal(result.detectedPort, null);
    assert.match(result.deployabilityBlockers.join(" "), /could not be proven/, "framework default alone must not become port authority");
  } finally { await rm(noPort, { recursive: true, force: true }); }

  const generatedPort = await repository({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "5.0.0" } }),
    "package-lock.json": "{}",
    "server.js": "require('express')().listen(process.env.PORT)",
  });
  try {
    const result = scanner.scan(generatedPort, profile());
    assert.equal(result.detectedPort, 3000);
    assert.equal(result.portSource, "platform_generated", "a generated PORT-binding contract may select the platform-owned numeric port");
  } finally { await rm(generatedPort, { recursive: true, force: true }); }

  const conflict = await repository({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "5.0.0" } }),
    "package-lock.json": "{}",
    "server.js": "require('express')().listen(process.env.PORT || 3000, '0.0.0.0')",
    "Dockerfile": "FROM node:22-alpine3.21\nEXPOSE 8080\nCMD [\"node\",\"server.js\"]\n",
  });
  try {
    const result = scanner.scan(conflict, profile({ hasDockerfile: true }));
    assert.equal(result.detectedPort, null);
    assert.match(result.deployabilityBlockers.join(" "), /PORT_IDENTITY_AMBIGUOUS/);
  } finally { await rm(conflict, { recursive: true, force: true }); }

  for (const [name, command] of [
    ["uvicorn-explicit", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"],
    ["django-explicit", "gunicorn config.wsgi:application --bind 0.0.0.0:${PORT:-8000}"],
  ] as const) {
    const root = await repository({ "requirements.txt": "framework==1.0.0\n", "app.py": "" });
    try {
      const result = scanner.scan(root, {
        ecosystem: "python", framework: name.startsWith("django") ? "django" : "fastapi", packageManager: "pip",
        buildCommand: null, startCommand: command, expectedPort: null, healthCheckPath: null,
        staticOutput: false, hasDockerfile: false, requiresDatabase: false, requiresPersistentStorage: false,
      });
      assert.equal(result.detectedPort, 8000, `${name}: explicit generated runtime fallback is authoritative`);
      assert.doesNotMatch(result.deployabilityBlockers.join(" "), /container port could not be proven/, name);
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  for (const [name, route, expectedMode, expectedPath] of [
    ["tcp-only", "", "tcp", null],
    ["health", "app.get('/health', handler);", "http", "/health"],
    ["ready", "app.get('/ready', handler);", "http", "/ready"],
    ["api-prefix-only", "app.use('/api/v1', router);", "tcp", null],
  ] as const) {
    const root = await repository({
      "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "5.0.0" } }),
      "package-lock.json": "{}",
      "server.js": `const app=require('express')(); ${route} app.listen(process.env.PORT || 3000, '0.0.0.0')`,
    });
    try {
      const detected = detector.detect(root, "a".repeat(40));
      const topology = detected.rawProfile.componentTopology as DetectedApplicationTopology;
      const component = topology.components[0];
      assert.equal(component.healthCheckMode, expectedMode, name);
      assert.equal(component.healthCheckPath, expectedPath, name);
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  console.log("Certification Part 1 authority checks passed: proven ports, conflict blocking, and non-fabricated HTTP/TCP health semantics.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
