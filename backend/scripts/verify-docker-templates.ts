import { strict as assert } from "assert";
import { ProjectDetectionProfile } from "../src/projects/project-detection-profile.entity";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";

const registry = new TemplateRegistryService();
const engine = new DockerTemplateEngineService();

function render(templateKey: string, profile: Partial<ProjectDetectionProfile>) {
  const template = registry.getTemplate(templateKey);
  assert.ok(template, `${templateKey} must exist`);
  const dockerfile = engine.renderDockerfile(template, profile as ProjectDetectionProfile);
  assert.ok(dockerfile, `${templateKey} must render a Dockerfile`);
  assert.doesNotMatch(dockerfile, /\{\{[A-Z_]+\}\}/, `${templateKey} has unresolved placeholders`);
  return dockerfile;
}

const express = render("express-server", {
  ecosystem: "node",
  packageManager: "npm",
  expectedPort: 3000,
  startCommand: "npm start",
});
assert.match(express, /node:22-alpine3\.21/);
assert.match(express, /npm prune --omit=dev/);
assert.match(express, /USER app/);

const vite = render("vite-static", {
  ecosystem: "node",
  packageManager: "npm",
  expectedPort: 8080,
  buildCommand: "npm run build",
});
assert.match(vite, /nginxinc\/nginx-unprivileged:1\.27-alpine/);
assert.match(vite, /COPY --from=builder \/app\/dist/);
assert.match(vite, /EXPOSE 8080/);

const python = render("fastapi-asgi", {
  ecosystem: "python",
  packageManager: "pip",
  expectedPort: 8000,
  startCommand: "uvicorn main:app --host 0.0.0.0 --port 8000",
});
assert.match(python, /python -m venv \/opt\/venv/);
assert.match(python, /USER appuser/);

console.log("Generated Docker template hardening verification passed.");
