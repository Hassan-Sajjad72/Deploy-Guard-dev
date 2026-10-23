import { Injectable } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import { DevOpsTemplateDefinition } from "./devops-templates";

export type DeploymentContractDockerInput = {
  language: "javascript" | "python" | null;
  framework: string | null;
  packageManager: string | null;
  nodeVersion: string | null;
  pythonVersion: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  port: number | null;
  healthPath: string;
  runtimeType: "static" | "server" | null;
  buildTimeEnvVars: string[];
};

@Injectable()
export class DockerTemplateEngineService {
  renderDockerfile(
    template: DevOpsTemplateDefinition,
    contract: DeploymentContractDockerInput
  ): string | null {
    if (!template.dockerfileTemplatePath) {
      return null;
    }

    const templatePath = join(process.cwd(), template.dockerfileTemplatePath);
    const content = readFileSync(templatePath, "utf8");
    const startCommand = contract.startCommand || this.defaultStartCommand(template);
    const buildCommand = contract.buildCommand || this.defaultBuildCommand(template);
    const values: Record<string, string> = {
      PACKAGE_MANAGER: contract.packageManager || "npm",
      INSTALL_COMMAND: this.installCommand(contract),
      PRUNE_COMMAND: this.pruneCommand(contract),
      BUILD_COMMAND: buildCommand,
      START_COMMAND: startCommand,
      START_COMMAND_JSON: JSON.stringify(["sh", "-c", startCommand]),
      EXPECTED_PORT: String(contract.port || template.defaultPort || 3000),
      RUNTIME_VERSION: contract.nodeVersion || contract.pythonVersion || "",
      APP_ENTRY: contract.framework || "app",
      STATIC_OUTPUT: contract.runtimeType === "static" ? "true" : "false",
      OUTPUT_DIRECTORY: contract.outputDirectory || this.defaultOutputDirectory(template),
      BUILD_ENV_DECLARATIONS: this.buildEnvironmentDeclarations(contract.buildTimeEnvVars),
      HEALTH_CHECK_PATH: contract.healthPath || "/",
    };

    return content.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => values[key] ?? "");
  }

  private installCommand(contract: DeploymentContractDockerInput) {
    if (contract.installCommand?.trim()) return contract.installCommand.trim();
    if (contract.language === "python") {
      if (contract.packageManager === "poetry") return "pip install --no-cache-dir poetry && poetry install --only main --no-root";
      if (contract.packageManager === "pipenv") return "pip install --no-cache-dir pipenv && pipenv install --system --deploy";
      return "pip install --no-cache-dir -r requirements.txt";
    }

    if (contract.packageManager === "pnpm") {
      return "corepack enable && pnpm install --frozen-lockfile";
    }

    if (contract.packageManager === "yarn") {
      return "yarn install --frozen-lockfile";
    }

    return "npm ci || npm install";
  }

  private defaultOutputDirectory(template: DevOpsTemplateDefinition) {
    if (template.templateKey === "vite-static") return "dist";
    if (template.templateKey === "react-static") return "build";
    if (template.templateKey === "nextjs-static") return "out";
    return ".";
  }

  private buildEnvironmentDeclarations(buildTimeEnvVars: string[]) {
    return buildTimeEnvVars
      .filter((key) => /^(VITE_|NEXT_PUBLIC_|REACT_APP_)[A-Z0-9_]*$/.test(key))
      .map((key) => `ARG ${key}\nENV ${key}=\$${key}`)
      .join("\n");
  }

  private defaultBuildCommand(template: DevOpsTemplateDefinition) {
    return template.ecosystem === "node" ? "npm run build" : "true";
  }

  private pruneCommand(contract: DeploymentContractDockerInput) {
    if (contract.language !== "javascript") {
      return "true";
    }

    if (contract.packageManager === "pnpm") {
      return "pnpm prune --prod";
    }

    if (contract.packageManager === "yarn") {
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
}
