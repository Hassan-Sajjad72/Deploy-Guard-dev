import { strict as assert } from "assert";
import { DeploymentContractDockerInput, DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";

const registry = new TemplateRegistryService();
const engine = new DockerTemplateEngineService();

function render(templateKey: string, input: Partial<DeploymentContractDockerInput>) {
  const template = registry.getTemplate(templateKey);
  assert.ok(template, `${templateKey} must exist`);
  const dockerfile = engine.renderDockerfile(template, {
    language: null,
    framework: null,
    packageManager: null,
    nodeVersion: null,
    pythonVersion: null,
    installCommand: null,
    buildCommand: null,
    startCommand: null,
    outputDirectory: null,
    port: null,
    healthPath: "/",
    runtimeType: "server",
    buildTimeEnvVars: [],
    ...input,
  });
  assert.ok(dockerfile, `${templateKey} must render a Dockerfile`);
  assert.doesNotMatch(dockerfile, /\{\{[A-Z_]+\}\}/, `${templateKey} has unresolved placeholders`);
  return dockerfile;
}

const express = render("express-server", {
  language: "javascript",
  packageManager: "npm",
  port: 3000,
  startCommand: "npm start",
});
assert.match(express, /node:22-alpine3\.21/);
assert.match(express, /npm prune --omit=dev/);
assert.match(express, /USER app/);

const vite = render("vite-static", {
  language: "javascript",
  packageManager: "npm",
  port: 80,
  runtimeType: "static",
  outputDirectory: "dist",
  buildCommand: "npm run build",
  buildTimeEnvVars: ["VITE_API_URL"],
});
assert.match(vite, /nginx:1\.27-alpine/);
assert.match(vite, /COPY --from=builder \/app\/dist/);
assert.match(vite, /ARG VITE_API_URL/);
assert.match(vite, /EXPOSE 80/);

const python = render("fastapi-asgi", {
  language: "python",
  packageManager: "pip",
  port: 8000,
  startCommand: "uvicorn main:app --host 0.0.0.0 --port 8000",
});
assert.match(python, /python -m venv \/opt\/venv/);
assert.match(python, /USER appuser/);

console.log("Generated Docker template hardening verification passed.");
