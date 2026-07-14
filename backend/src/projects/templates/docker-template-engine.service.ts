import { Injectable } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import { ProjectDetectionProfile } from "../project-detection-profile.entity";
import { DevOpsTemplateDefinition } from "./devops-templates";

@Injectable()
export class DockerTemplateEngineService {
  renderDockerfile(
    template: DevOpsTemplateDefinition,
    profile: ProjectDetectionProfile
  ): string | null {
    if (!template.dockerfileTemplatePath) {
      return null;
    }

    const templatePath = join(process.cwd(), template.dockerfileTemplatePath);
    const content = readFileSync(templatePath, "utf8");
    const startCommand = profile.startCommand || this.defaultStartCommand(template);
    const buildCommand = profile.buildCommand || this.defaultBuildCommand(template);
    const values: Record<string, string> = {
      PACKAGE_MANAGER: profile.packageManager || "npm",
      INSTALL_COMMAND: this.installCommand(profile),
      PRUNE_COMMAND: this.pruneCommand(profile),
      BUILD_COMMAND: buildCommand,
      START_COMMAND: startCommand,
      START_COMMAND_JSON: JSON.stringify(["sh", "-c", startCommand]),
      EXPECTED_PORT: String(profile.expectedPort || template.defaultPort || 3000),
      RUNTIME_VERSION: profile.runtimeVersion || "",
      APP_ENTRY: this.appEntry(profile),
      STATIC_OUTPUT: profile.staticOutput ? "true" : "false",
      HEALTH_CHECK_PATH: profile.healthCheckPath || "/",
    };

    return content.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => values[key] ?? "");
  }

  private installCommand(profile: ProjectDetectionProfile) {
    if (profile.ecosystem === "python") {
      return profile.packageManager === "poetry"
        ? "pip install --no-cache-dir poetry && poetry install --only main --no-root"
        : "pip install --no-cache-dir -r requirements.txt";
    }

    if (profile.packageManager === "pnpm") {
      return "corepack enable && pnpm install --frozen-lockfile";
    }

    if (profile.packageManager === "yarn") {
      return "yarn install --frozen-lockfile";
    }

    return "npm ci || npm install";
  }

  private defaultBuildCommand(template: DevOpsTemplateDefinition) {
    return template.ecosystem === "node" ? "npm run build" : "true";
  }

  private pruneCommand(profile: ProjectDetectionProfile) {
    if (profile.ecosystem !== "node") {
      return "true";
    }

    if (profile.packageManager === "pnpm") {
      return "pnpm prune --prod";
    }

    if (profile.packageManager === "yarn") {
      return "yarn install --production --frozen-lockfile --ignore-scripts";
    }

    return "npm prune --omit=dev";
  }

  private defaultStartCommand(template: DevOpsTemplateDefinition) {
    if (template.templateKey === "django-wsgi") {
      return "gunicorn app.wsgi:application --bind 0.0.0.0:8000";
    }

    if (template.templateKey === "fastapi-asgi") {
      return "uvicorn main:app --host 0.0.0.0 --port 8000";
    }

    if (template.templateKey === "flask-wsgi") {
      return "gunicorn app:app --bind 0.0.0.0:5000";
    }

    return "npm start";
  }

  private appEntry(profile: ProjectDetectionProfile) {
    return profile.frameworkVariant || "app";
  }
}
