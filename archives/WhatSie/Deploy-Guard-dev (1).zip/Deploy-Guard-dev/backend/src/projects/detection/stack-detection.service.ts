import { Injectable } from "@nestjs/common";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { TemplateMatchingService } from "./template-matching.service";

export type DeploymentProfileDraft = {
  commitSha: string | null;
  ecosystem: string;
  language: string | null;
  framework: string | null;
  frameworkVariant: string | null;
  packageManager: string | null;
  runtimeVersion: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  expectedPort: number | null;
  healthCheckPath: string | null;
  requiresDatabase: boolean;
  databaseType: string | null;
  requiresPersistentStorage: boolean;
  staticOutput: boolean;
  dockerfileRequired: boolean;
  hasDockerfile: boolean;
  selectedTemplate: string | null;
  confidence: string;
  detectionStatus: string;
  warnings: string[];
  errors: string[];
  rawProfile: Record<string, unknown>;
};

@Injectable()
export class StackDetectionService {
  constructor(private readonly templateMatchingService: TemplateMatchingService) {}

  detect(workspacePath: string, commitSha: string | null): DeploymentProfileDraft {
    const rootFiles = new Set(readdirSync(workspacePath));
    const hasDockerfile = rootFiles.has("Dockerfile");
    const warnings: string[] = [];
    const errors: string[] = [];
    const rawProfile: Record<string, unknown> = { rootFiles: Array.from(rootFiles).sort() };
    let profile = this.baseProfile(commitSha, hasDockerfile, warnings, errors, rawProfile);

    if (rootFiles.has("package.json")) {
      profile = this.detectNode(workspacePath, rootFiles, profile);
    } else if (
      rootFiles.has("requirements.txt") ||
      rootFiles.has("pyproject.toml") ||
      rootFiles.has("Pipfile") ||
      rootFiles.has("setup.py")
    ) {
      profile = this.detectPython(workspacePath, rootFiles, profile);
    } else if (rootFiles.has("Gemfile")) {
      profile = this.detectRuby(workspacePath, profile);
    } else {
      warnings.push("No supported root-level ecosystem manifest found.");
    }

    const template = this.templateMatchingService.selectTemplate(profile);
    profile.selectedTemplate = template.selectedTemplate;
    profile.dockerfileRequired = template.dockerfileRequired;
    profile.detectionStatus = template.detectionStatus;

    if (profile.selectedTemplate === "custom-dockerfile-required") {
      warnings.push("No safe automatic template was found.");
      profile.confidence = "low";
    } else if (profile.framework && profile.framework !== "unknown") {
      profile.confidence = "high";
    } else if (profile.ecosystem !== "unknown") {
      profile.confidence = "medium";
    }

    return profile;
  }

  private detectNode(
    workspacePath: string,
    rootFiles: Set<string>,
    profile: DeploymentProfileDraft
  ) {
    const packageJson = this.readJson(join(workspacePath, "package.json"), profile);
    const dependencies = {
      ...(packageJson?.dependencies || {}),
      ...(packageJson?.devDependencies || {}),
    };
    const scripts = packageJson?.scripts || {};
    const hasNextConfig =
      rootFiles.has("next.config.js") || rootFiles.has("next.config.mjs");
    const hasNext = Boolean(dependencies.next);
    const hasExpress = Boolean(dependencies.express);

    profile.ecosystem = "node";
    profile.language = "javascript";
    profile.packageManager = rootFiles.has("pnpm-lock.yaml")
      ? "pnpm"
      : rootFiles.has("yarn.lock")
        ? "yarn"
        : "npm";
    profile.runtimeVersion = packageJson?.engines?.node || "node-lts";
    profile.buildCommand = scripts.build ? `${profile.packageManager} run build` : null;
    profile.expectedPort = this.extractPortFromScripts(scripts) || 3000;
    profile.healthCheckPath = this.hasExpressHealthRoute(workspacePath) ? "/health" : "/";

    if (hasNext && hasNextConfig) {
      const nextConfigText = this.readOptionalText(workspacePath, [
        "next.config.js",
        "next.config.mjs",
      ]);
      const isStaticExport =
        /output\s*:\s*["']export["']/.test(nextConfigText || "") ||
        Object.values(scripts).some((script) =>
          String(script).includes("next export")
        );

      profile.framework = "nextjs";
      profile.frameworkVariant = isStaticExport ? "nextjs-static" : "nextjs-ssr";
      profile.staticOutput = isStaticExport;
      profile.startCommand = scripts.start
        ? `${profile.packageManager} start`
        : isStaticExport
          ? null
          : "next start";

      return profile;
    }

    if (hasExpress) {
      profile.framework = "express";
      profile.frameworkVariant = "express-server";
      profile.startCommand = scripts.start
        ? `${profile.packageManager} start`
        : rootFiles.has("server.js")
          ? "node server.js"
          : "npm start";

      return profile;
    }

    profile.framework = "unknown";
    profile.frameworkVariant = "generic-node";
    profile.startCommand = scripts.start ? `${profile.packageManager} start` : null;

    return profile;
  }

  private detectPython(
    workspacePath: string,
    rootFiles: Set<string>,
    profile: DeploymentProfileDraft
  ) {
    const dependencyText = [
      this.readOptionalFile(workspacePath, "requirements.txt"),
      this.readOptionalFile(workspacePath, "pyproject.toml"),
      this.readOptionalFile(workspacePath, "Pipfile"),
      this.readOptionalFile(workspacePath, "setup.py"),
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();

    profile.ecosystem = "python";
    profile.language = "python";
    profile.packageManager = rootFiles.has("pyproject.toml") &&
      /poetry/.test(this.readOptionalFile(workspacePath, "pyproject.toml") || "")
      ? "poetry"
      : "pip";
    profile.runtimeVersion =
      this.readOptionalFile(workspacePath, "runtime.txt")?.trim() ||
      this.readOptionalFile(workspacePath, ".python-version")?.trim() ||
      "python-3.11";
    profile.healthCheckPath = "/";

    if (dependencyText.includes("django") || rootFiles.has("manage.py")) {
      profile.framework = "django";
      profile.frameworkVariant = "django-wsgi";
      profile.expectedPort = 8000;
      profile.startCommand = `gunicorn ${this.detectDjangoProjectName(
        workspacePath
      )}.wsgi:application`;
      const settingsText = this.readDjangoSettings(workspacePath);
      profile.requiresDatabase =
        /DATABASES/.test(settingsText) &&
        /(postgres|postgresql|psycopg2|dj_database_url)/i.test(settingsText);
      profile.databaseType = profile.requiresDatabase ? "postgres" : null;

      return profile;
    }

    if (dependencyText.includes("fastapi")) {
      profile.framework = "fastapi";
      profile.frameworkVariant = "fastapi-asgi";
      profile.expectedPort = 8000;
      profile.startCommand = existsSync(join(workspacePath, "app", "main.py"))
        ? "uvicorn app.main:app --host 0.0.0.0 --port 8000"
        : "uvicorn main:app --host 0.0.0.0 --port 8000";
      profile.requiresDatabase = /(sqlalchemy|asyncpg|psycopg2|databases|tortoise-orm)/.test(
        dependencyText
      );
      profile.databaseType = profile.requiresDatabase ? "postgres" : null;

      return profile;
    }

    if (dependencyText.includes("flask")) {
      profile.framework = "flask";
      profile.frameworkVariant = "flask-wsgi";
      profile.expectedPort = 5000;
      profile.startCommand = rootFiles.has("wsgi.py")
        ? "gunicorn wsgi:app"
        : "gunicorn app:app";

      return profile;
    }

    profile.framework = "unknown";
    profile.frameworkVariant = "generic-python";
    profile.expectedPort = 8000;

    return profile;
  }

  private detectRuby(workspacePath: string, profile: DeploymentProfileDraft) {
    const gemfile = this.readOptionalFile(workspacePath, "Gemfile")?.toLowerCase() || "";
    profile.ecosystem = "ruby";
    profile.language = "ruby";
    profile.packageManager = "bundler";

    if (gemfile.includes("rails")) {
      profile.framework = "rails";
      profile.frameworkVariant = "rails-server";
      profile.expectedPort = 3000;
      profile.startCommand = "bundle exec rails server -b 0.0.0.0";
      profile.requiresDatabase = true;
      profile.databaseType = "postgres";

      return profile;
    }

    profile.framework = "unknown";
    profile.frameworkVariant = "generic-ruby";

    return profile;
  }

  private baseProfile(
    commitSha: string | null,
    hasDockerfile: boolean,
    warnings: string[],
    errors: string[],
    rawProfile: Record<string, unknown>
  ): DeploymentProfileDraft {
    return {
      commitSha,
      ecosystem: "unknown",
      language: null,
      framework: "unknown",
      frameworkVariant: null,
      packageManager: null,
      runtimeVersion: null,
      buildCommand: null,
      startCommand: null,
      expectedPort: null,
      healthCheckPath: "/",
      requiresDatabase: false,
      databaseType: null,
      requiresPersistentStorage: false,
      staticOutput: false,
      dockerfileRequired: false,
      hasDockerfile,
      selectedTemplate: null,
      confidence: "low",
      detectionStatus: "failed",
      warnings,
      errors,
      rawProfile,
    };
  }

  private readJson(path: string, profile: DeploymentProfileDraft) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      profile.errors.push("package.json could not be parsed.");
      return null;
    }
  }

  private readOptionalText(workspacePath: string, names: string[]) {
    const name = names.find((candidate) => existsSync(join(workspacePath, candidate)));
    return name ? this.readOptionalFile(workspacePath, name) : null;
  }

  private readOptionalFile(workspacePath: string, name: string) {
    const path = join(workspacePath, name);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  private extractPortFromScripts(scripts: Record<string, unknown>) {
    const joinedScripts = Object.values(scripts).map(String).join(" ");
    const match =
      joinedScripts.match(/PORT=(\d+)/) ||
      joinedScripts.match(/--port\s+(\d+)/) ||
      joinedScripts.match(/-p\s+(\d+)/);

    return match ? Number(match[1]) : null;
  }

  private hasExpressHealthRoute(workspacePath: string) {
    return ["server.js", "app.js", "index.js"].some((file) => {
      const text = this.readOptionalFile(workspacePath, file);
      return text ? /["']\/health["']/.test(text) : false;
    });
  }

  private detectDjangoProjectName(workspacePath: string) {
    if (!existsSync(join(workspacePath, "manage.py"))) {
      return "app";
    }

    const candidates = readdirSync(workspacePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(workspacePath, name, "settings.py")))
      .sort();

    return candidates[0] || "app";
  }

  private readDjangoSettings(workspacePath: string) {
    const projectName = this.detectDjangoProjectName(workspacePath);
    return this.readOptionalFile(workspacePath, join(projectName, "settings.py")) || "";
  }
}
