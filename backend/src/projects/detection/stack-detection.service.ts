import { Injectable, Logger } from "@nestjs/common";
import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { TemplateMatchingService } from "./template-matching.service";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
  "__pycache__",
]);
const MANIFEST_NAMES = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "setup.py",
  "manage.py",
  "Gemfile",
  "composer.json",
  "artisan",
  "index.php",
]);

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

type Candidate = { directory: string; relativeDirectory: string; files: Set<string> };

@Injectable()
export class StackDetectionService {
  private readonly logger = new Logger(StackDetectionService.name);

  constructor(private readonly templateMatchingService: TemplateMatchingService) {}

  detect(
    workspacePath: string,
    commitSha: string | null,
    preferredAppDirectory?: string | null
  ): DeploymentProfileDraft {
    const scanRoot = this.resolveScanRoot(workspacePath, preferredAppDirectory);
    const preferredDirectory = relative(workspacePath, scanRoot).replace(/\\/g, "/") || ".";
    const manifestFiles = this.findManifestFiles(scanRoot);
    const candidates = this.buildCandidates(scanRoot, manifestFiles);
    const selected = this.selectCandidate(candidates);
    const detectedDirectory = selected?.relativeDirectory || ".";
    const appDirectory = [preferredDirectory, detectedDirectory]
      .filter((directory) => directory !== ".")
      .join("/") || ".";
    const appPath = selected?.directory || scanRoot;
    const appFiles = selected?.files || new Set(readdirSync(scanRoot));
    const rootFiles = new Set(readdirSync(workspacePath));
    const hasDockerfile = appFiles.has("Dockerfile") || rootFiles.has("Dockerfile");
    const warnings: string[] = [];
    const errors: string[] = [];
    const rawProfile: Record<string, unknown> = {
      rootFiles: Array.from(rootFiles).sort(),
      appDirectory,
      preferredAppDirectory: preferredAppDirectory || null,
      manifestFiles,
      cloneError: null,
      branchError: null,
    };
    let profile = this.baseProfile(commitSha, hasDockerfile, warnings, errors, rawProfile);

    if (selected) {
      if (appFiles.has("package.json")) {
        profile = this.detectNode(appPath, appFiles, profile);
      } else if (appFiles.has("manage.py") || this.hasPythonManifest(appFiles)) {
        profile = this.detectPython(appPath, appFiles, profile);
      } else if (appFiles.has("composer.json") || appFiles.has("artisan") || appFiles.has("index.php")) {
        profile = this.detectPhp(appPath, appFiles, profile);
      } else if (appFiles.has("Gemfile")) {
        profile = this.detectRuby(appPath, profile);
      }
    } else {
      warnings.push("No known stack manifests were found within scan depth 3.");
    }

    const template = this.templateMatchingService.selectTemplate(profile);
    profile.selectedTemplate = template.selectedTemplate;
    profile.dockerfileRequired = template.dockerfileRequired;
    profile.detectionStatus = template.detectionStatus;
    profile.rawProfile.templateMatched = template.templateMatched;
    profile.rawProfile.unsupportedReason = template.unsupportedReason;
    profile.rawProfile.detected = profile.ecosystem !== "unknown";

    if (template.unsupportedReason) {
      warnings.push(template.unsupportedReason);
    } else if (profile.selectedTemplate === "custom-dockerfile-required") {
      warnings.push("No safe automatic template was found.");
    }
    profile.confidence = profile.framework && profile.framework !== "unknown"
      ? "high"
      : profile.ecosystem !== "unknown" ? "medium" : "low";

    this.logger.log(`Manifest files found: ${manifestFiles.join(", ") || "none"}`);
    this.logger.log(`Selected app directory: ${appDirectory}`);
    this.logger.log(
      `Final stack ecosystem=${profile.ecosystem} framework=${profile.framework} template=${
        profile.selectedTemplate
      } matched=${String(template.templateMatched)}`
    );
    return profile;
  }

  private resolveScanRoot(workspacePath: string, preferredAppDirectory?: string | null) {
    const repositoryRoot = resolve(workspacePath);
    const scanRoot = preferredAppDirectory
      ? resolve(repositoryRoot, preferredAppDirectory)
      : repositoryRoot;

    if (
      scanRoot !== repositoryRoot &&
      !scanRoot.startsWith(`${repositoryRoot}${sep}`)
    ) {
      throw new Error("Application directory is outside the repository workspace.");
    }

    if (!existsSync(scanRoot)) {
      throw new Error(`Application directory '${preferredAppDirectory}' was not found in the repository.`);
    }

    return scanRoot;
  }

  private findManifestFiles(root: string) {
    const found: string[] = [];
    const visit = (directory: string, depth: number) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (depth < 3 && !IGNORED_DIRECTORIES.has(entry.name)) {
            visit(join(directory, entry.name), depth + 1);
          }
          continue;
        }
        const relativePath = relative(root, join(directory, entry.name)).replace(/\\/g, "/");
        if (MANIFEST_NAMES.has(entry.name) || relativePath.endsWith("public/index.php")) {
          found.push(relativePath);
        }
      }
    };
    visit(root, 0);
    return found.sort();
  }

  private buildCandidates(root: string, manifests: string[]): Candidate[] {
    const directories = new Map<string, Set<string>>();
    for (const manifest of manifests) {
      let directory = dirname(manifest);
      if (manifest.endsWith("public/index.php")) directory = dirname(directory);
      const files = directories.get(directory) || new Set<string>();
      const absoluteDirectory = directory === "." ? root : join(root, directory);
      if (existsSync(absoluteDirectory)) {
        for (const entry of readdirSync(absoluteDirectory)) files.add(entry);
      }
      if (manifest.endsWith("public/index.php")) files.add("index.php");
      directories.set(directory, files);
    }
    return Array.from(directories, ([relativeDirectory, files]) => ({
      directory: relativeDirectory === "." ? root : join(root, relativeDirectory),
      relativeDirectory,
      files,
    }));
  }

  private selectCandidate(candidates: Candidate[]) {
    return candidates.sort((a, b) => this.candidateScore(b) - this.candidateScore(a))[0];
  }

  private candidateScore(candidate: Candidate) {
    const depth = candidate.relativeDirectory === "." ? 0 : candidate.relativeDirectory.split("/").length;
    let score = 100 - depth * 10;
    if (candidate.files.has("manage.py") || candidate.files.has("artisan")) score += 50;
    if (candidate.files.has("package.json")) {
      const packageJson = this.readJsonFile(join(candidate.directory, "package.json"));
      const dependencies = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
      if (["react", "vite", "next", "express", "@nestjs/core"].some((name) => dependencies[name])) score += 40;
      if (packageJson?.workspaces) score -= 30;
    }
    if (["frontend", "backend", "server", "api", "web", "app"].includes(basename(candidate.relativeDirectory))) score += 5;
    return score;
  }

  private detectNode(path: string, files: Set<string>, profile: DeploymentProfileDraft) {
    const packageJson = this.readJson(join(path, "package.json"), profile);
    const dependencies = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    const scripts: Record<string, unknown> = packageJson?.scripts || {};
    const hasVite = Boolean(dependencies.vite) || Object.values(scripts).some((value) => /\bvite\b/.test(String(value)));
    const hasReact = Boolean(dependencies.react);
    const hasNext = Boolean(dependencies.next);
    const hasNest = Boolean(dependencies["@nestjs/core"]);
    const hasExpress = Boolean(dependencies.express);
    const db = this.detectNodeDatabase(dependencies);

    profile.ecosystem = "node";
    profile.language = "javascript";
    profile.packageManager = files.has("pnpm-lock.yaml") ? "pnpm" : files.has("yarn.lock") ? "yarn" : "npm";
    profile.runtimeVersion = packageJson?.engines?.node || "node-lts";
    profile.buildCommand = scripts.build ? `${profile.packageManager} run build` : null;
    profile.expectedPort = this.extractPortFromScripts(scripts) || (hasVite ? 8080 : 3000);
    const hasHealthRoute = this.hasHealthRoute(path);
    profile.healthCheckPath = "/health";
    profile.rawProfile.healthCheckDetected = hasHealthRoute;
    if (!hasHealthRoute && !hasVite && !hasReact) {
      profile.warnings.push(
        "No explicit /health route was detected; add one before an AWS launch test."
      );
    }
    profile.requiresDatabase = Boolean(db);
    profile.databaseType = db;
    this.detectPersistentStorage(path, files, profile, dependencies);

    if (hasNext) {
      const configText = this.readOptionalText(path, ["next.config.js", "next.config.mjs", "next.config.ts"]);
      const isStatic = /output\s*:\s*["']export["']/.test(configText || "") || Object.values(scripts).some((s) => String(s).includes("next export"));
      profile.framework = "nextjs";
      profile.frameworkVariant = isStatic ? "nextjs-static" : "nextjs-ssr";
      profile.staticOutput = isStatic;
      if (isStatic) profile.expectedPort = 8080;
      profile.startCommand = scripts.start ? `${profile.packageManager} start` : isStatic ? null : "next start";
    } else if (hasNest) {
      profile.framework = "nestjs";
      profile.frameworkVariant = "express-server";
      profile.startCommand = scripts.start ? `${profile.packageManager} start` : "node dist/main";
    } else if (hasExpress) {
      profile.framework = "express";
      profile.frameworkVariant = "express-server";
      profile.startCommand = scripts.start ? `${profile.packageManager} start` : files.has("server.js") ? "node server.js" : "npm start";
    } else if (hasVite || hasReact) {
      profile.framework = hasVite ? "vite-react" : "react";
      profile.frameworkVariant = hasVite ? "vite-static" : "generic-node";
      profile.staticOutput = Boolean(scripts.build);
      if (hasVite && profile.staticOutput) profile.expectedPort = 8080;
      profile.startCommand = scripts.start
        ? `${profile.packageManager} start`
        : scripts.preview
          ? `${profile.packageManager} run preview -- --host 0.0.0.0 --port ${profile.expectedPort}`
          : null;
    } else {
      profile.framework = "unknown";
      profile.frameworkVariant = "generic-node";
      profile.startCommand = scripts.start ? `${profile.packageManager} start` : null;
    }
    return profile;
  }

  private detectPython(path: string, files: Set<string>, profile: DeploymentProfileDraft) {
    const dependencyText = ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"]
      .map((name) => this.readOptionalFile(path, name)).filter(Boolean).join("\n").toLowerCase();
    profile.ecosystem = "python";
    profile.language = "python";
    profile.packageManager = files.has("pyproject.toml") && /poetry/.test(this.readOptionalFile(path, "pyproject.toml") || "") ? "poetry" : "pip";
    profile.runtimeVersion = this.readOptionalFile(path, "runtime.txt")?.trim() || this.readOptionalFile(path, ".python-version")?.trim() || "python-3.11";
    profile.healthCheckPath = "/health";
    profile.rawProfile.healthCheckDetected = false;
    profile.warnings.push(
      "Verify that the Python application exposes /health before an AWS launch test."
    );
    this.detectPythonPersistentStorage(path, files, profile, dependencyText);
    if (files.has("manage.py") || dependencyText.includes("django")) {
      profile.framework = "django";
      profile.frameworkVariant = "django-wsgi";
      profile.expectedPort = 8000;
      profile.startCommand = `gunicorn ${this.detectDjangoProjectName(path)}.wsgi:application --bind 0.0.0.0:8000`;
      const settings = this.readDjangoSettings(path);
      profile.requiresDatabase = /DATABASES/.test(settings) && /(postgres|psycopg2|dj_database_url)/i.test(settings);
      profile.databaseType = profile.requiresDatabase ? "postgres" : null;
    } else if (dependencyText.includes("fastapi")) {
      profile.framework = "fastapi";
      profile.frameworkVariant = "fastapi-asgi";
      profile.expectedPort = 8000;
      profile.startCommand = existsSync(join(path, "app", "main.py")) ? "uvicorn app.main:app --host 0.0.0.0 --port 8000" : "uvicorn main:app --host 0.0.0.0 --port 8000";
    } else if (dependencyText.includes("flask")) {
      profile.framework = "flask";
      profile.frameworkVariant = "flask-wsgi";
      profile.expectedPort = 5000;
      profile.startCommand = files.has("wsgi.py") ? "gunicorn wsgi:app --bind 0.0.0.0:5000" : "gunicorn app:app --bind 0.0.0.0:5000";
    } else {
      profile.framework = "unknown";
      profile.frameworkVariant = "generic-python";
      profile.expectedPort = 8000;
    }
    return profile;
  }

  private detectPhp(path: string, files: Set<string>, profile: DeploymentProfileDraft) {
    const composer = this.readJsonFile(join(path, "composer.json"));
    const packages = { ...(composer?.require || {}), ...(composer?.["require-dev"] || {}) };
    const laravel = files.has("artisan") || Boolean(packages["laravel/framework"]);
    profile.ecosystem = "php";
    profile.language = "php";
    profile.framework = laravel ? "laravel" : "php";
    profile.frameworkVariant = laravel ? "laravel" : "generic-php";
    profile.packageManager = files.has("composer.json") ? "composer" : null;
    profile.startCommand = laravel ? "php artisan serve --host=0.0.0.0 --port=8000" : "php -S 0.0.0.0:8000";
    profile.expectedPort = 8000;
    profile.healthCheckPath = "/health";
    profile.rawProfile.healthCheckDetected = false;
    profile.warnings.push(
      "Verify that the PHP application exposes /health before an AWS launch test."
    );
    return profile;
  }

  private detectRuby(path: string, profile: DeploymentProfileDraft) {
    const gemfile = this.readOptionalFile(path, "Gemfile")?.toLowerCase() || "";
    profile.ecosystem = "ruby";
    profile.language = "ruby";
    profile.packageManager = "bundler";
    profile.framework = gemfile.includes("rails") ? "rails" : "unknown";
    profile.frameworkVariant = gemfile.includes("rails") ? "rails-server" : "generic-ruby";
    profile.expectedPort = 3000;
    profile.startCommand = gemfile.includes("rails") ? "bundle exec rails server -b 0.0.0.0" : null;
    return profile;
  }

  private baseProfile(commitSha: string | null, hasDockerfile: boolean, warnings: string[], errors: string[], rawProfile: Record<string, unknown>): DeploymentProfileDraft {
    return { commitSha, ecosystem: "unknown", language: null, framework: "unknown", frameworkVariant: null, packageManager: null, runtimeVersion: null, buildCommand: null, startCommand: null, expectedPort: null, healthCheckPath: "/", requiresDatabase: false, databaseType: null, requiresPersistentStorage: false, staticOutput: false, dockerfileRequired: false, hasDockerfile, selectedTemplate: null, confidence: "low", detectionStatus: "failed", warnings, errors, rawProfile };
  }

  private hasPythonManifest(files: Set<string>) { return ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"].some((file) => files.has(file)); }
  private readJson(path: string, profile: DeploymentProfileDraft) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { profile.errors.push("package.json could not be parsed."); return null; } }
  private readJsonFile(path: string) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
  private readOptionalText(path: string, names: string[]) { const name = names.find((candidate) => existsSync(join(path, candidate))); return name ? this.readOptionalFile(path, name) : null; }
  private readOptionalFile(path: string, name: string) { const file = join(path, name); return existsSync(file) ? readFileSync(file, "utf8") : null; }
  private extractPortFromScripts(scripts: Record<string, unknown>) { const text = Object.values(scripts).map(String).join(" "); const match = text.match(/PORT=(\d+)/) || text.match(/--port(?:=|\s+)(\d+)/) || text.match(/-p\s+(\d+)/); return match ? Number(match[1]) : null; }
  private hasHealthRoute(path: string) { return ["server.js", "app.js", "index.js", "src/main.ts", "src/app.ts"].some((file) => /["']\/health["']/.test(this.readOptionalFile(path, file) || "")); }
  private detectDjangoProjectName(path: string) { const dirs = readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).filter((name) => existsSync(join(path, name, "settings.py"))).sort(); return dirs[0] || "app"; }
  private readDjangoSettings(path: string) { return this.readOptionalFile(path, join(this.detectDjangoProjectName(path), "settings.py")) || ""; }
  private detectNodeDatabase(dependencies: Record<string, unknown>) { const names = Object.keys(dependencies); if (names.some((name) => ["pg", "postgres", "typeorm", "prisma", "sequelize"].includes(name))) return "postgres"; if (names.some((name) => ["mysql", "mysql2"].includes(name))) return "mysql"; if (names.some((name) => ["mongoose", "mongodb"].includes(name))) return "mongodb"; if (names.some((name) => ["redis", "ioredis"].includes(name))) return "redis"; return null; }
  private detectPersistentStorage(path: string, files: Set<string>, profile: DeploymentProfileDraft, dependencies: Record<string, unknown>) { const dirs = ["uploads", "media", "storage"].filter((name) => files.has(name)); if (dirs.length || dependencies.multer || this.hasSqliteUsage(path, files)) { profile.requiresPersistentStorage = true; profile.rawProfile.persistentStorageReason = dirs[0] || (dependencies.multer ? "multer dependency detected." : "sqlite file usage detected."); } }
  private detectPythonPersistentStorage(_path: string, files: Set<string>, profile: DeploymentProfileDraft, dependencies: string) { const dirs = ["uploads", "media", "storage"].filter((name) => files.has(name)); if (dirs.length || /sqlite|upload/.test(dependencies)) { profile.requiresPersistentStorage = true; profile.rawProfile.persistentStorageReason = dirs[0] || "sqlite/upload usage detected."; } }
  private hasSqliteUsage(path: string, files: Set<string>) { if (Array.from(files).some((file) => /\.(sqlite|sqlite3|db)$/.test(file))) return true; return ["package.json", "server.js", "app.js", "index.js"].some((file) => /sqlite/i.test(this.readOptionalFile(path, file) || "")); }
}
