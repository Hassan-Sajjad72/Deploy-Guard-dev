import { Injectable } from "@nestjs/common";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { extname, join, relative } from "path";
import { deriveWebpackOutputDirectory } from "./webpack-output";
import { ManagedDatabaseEngine } from "../managed-database-engine";
import { isPublicFrontendConfigurationKey } from "../configuration-ownership";

const IGNORED = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "vendor", "__pycache__", ".venv", "venv", "__tests__", "tests", "test", "examples"]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py"]);
const PLATFORM_VARIABLES = new Set(["PORT", "HOST", "NODE_ENV", "PYTHONUNBUFFERED"]);
const DATABASE_VARIABLE = /^(?:DATABASE_(?:URL|HOST|PORT|NAME|USER|PASSWORD)|DB_(?:HOST|PORT|NAME|USER|PASSWORD)|POSTGRES(?:QL)?_(?:URL|HOST|PORT|USER|PASSWORD|DB)|PG(?:HOST|PORT|USER|PASSWORD|DATABASE)|MYSQL_(?:URL|HOST|PORT|USER|PASSWORD|DATABASE)|MONGO(?:DB)?_(?:URI|URL|HOST|PORT|USER|PASSWORD|DB|DATABASE))$/;
const SECRET_VARIABLE = /(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|(?:DATABASE|POSTGRES(?:QL)?|MYSQL|MONGO(?:DB)?)_(?:URL|URI)|CREDENTIAL|AUTH_KEY)/;
const BUILD_VARIABLE = /^(VITE_|NEXT_PUBLIC_|REACT_APP_)/;
const JS_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];
const PYTHON_LOCKFILES = ["poetry.lock", "Pipfile.lock", "uv.lock", "pdm.lock"];
const PYTHON_MANIFESTS = ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg"];
const GENERATED_PYTHON_RUNTIME_PINS = {
  gunicorn: "gunicorn==23.0.0",
  uvicorn: "uvicorn==0.35.0",
} as const;
const serviceAliasLikeHost = (key: string) => /^(?:DB_HOST|DATABASE_HOST|POSTGRES_HOST|PGHOST|MYSQL_HOST|REDIS_HOST|MONGO_HOST|MONGODB_HOST)$/.test(key);

type RuntimeProfile = {
  ecosystem: string;
  framework: string | null;
  packageManager: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  expectedPort: number | null;
  healthCheckPath: string | null;
  staticOutput: boolean;
  hasDockerfile: boolean;
  requiresDatabase: boolean;
  requiresPersistentStorage: boolean;
};

type EnvEvidence = {
  key: string;
  required: boolean;
  phase: "build" | "runtime";
  public: boolean;
  secret: boolean;
  database: boolean;
  platformProvided: boolean;
  ownership: "user" | "repository_build" | "platform";
  component: "frontend" | "backend" | "platform";
  exposure: "public" | "private";
  requirement: "required" | "optional" | "unknown";
  sources: string[];
  detectedDefault?: string;
};

@Injectable()
export class RepoDeployabilityScannerService {
  scan(appPath: string, profile: RuntimeProfile) {
    const blockers: string[] = [];
    const warnings: string[] = [];
    const sourceScan = this.sourceFiles(appPath);
    const sourceFiles = sourceScan.files;
    const source = sourceFiles.map((file) => ({ file: relative(appPath, file).replace(/\\/g, "/"), text: this.safeRead(file) }));
    const combined = source.map((item) => item.text).join("\n");
    const rootFiles = new Set(readdirSync(appPath));
    const env = this.environmentEvidence(appPath, source, profile);
    const composeLocalSources = this.dockerComposeEvidence(appPath, env);
    const runtimeType = profile.staticOutput ? "static" : "server";
    const detectedHealthPath = this.detectHealthPath(combined);
    const bindingEvidence = `${combined}\n${profile.startCommand || ""}`;
    const sourcePort = this.detectPort(bindingEvidence);
    const dockerfilePort = profile.hasDockerfile ? this.detectPort(this.safeRead(join(appPath, "Dockerfile"))) : null;
    const detectedPort = sourcePort || dockerfilePort;
    const bindsToPortEnv = runtimeType === "server" && this.usesPlatformPort(bindingEvidence);
    const bindHost = this.detectBindHost(profile.startCommand || "", profile.framework) || this.detectBindHost(combined, profile.framework);
    let dependencyFiles: string[] = [];
    let lockfiles: string[] = [];
    let installCommand: string | null = null;
    let platformRuntimeInstallCommand: string | null = null;
    let outputDirectory: string | null = null;
    let privateRegistryRequired = false;
    let databaseRequired = profile.requiresDatabase;
    let databaseEngine: ManagedDatabaseEngine | "unsupported" | null = null;
    let persistentStorageRequired = profile.requiresPersistentStorage || this.detectPersistentStorage(combined, rootFiles);
    const dockerfileImages = profile.hasDockerfile ? this.dockerfileImages(appPath, blockers) : [];

    if (rootFiles.has(".env")) blockers.push("A real .env file is present in the repository. DeployGuard does not read its values; remove it from source control and configure required secrets securely.");

    if (sourceScan.truncated) blockers.push("Repository source scan reached its safety limit. Select a narrower application directory before deployment.");

    if (profile.ecosystem === "node") {
      dependencyFiles = rootFiles.has("package.json") ? ["package.json"] : [];
      lockfiles = JS_LOCKFILES.filter((name) => rootFiles.has(name));
      const packageJson = this.readJson(join(appPath, "package.json"));
      const scripts = (packageJson?.scripts || {}) as Record<string, unknown>;
      const declaredPackageManager = this.declaredNodePackageManager(packageJson?.packageManager);
      const lockfilePackageManagers = this.nodeLockfilePackageManagers(lockfiles);
      if (!packageJson) blockers.push("A valid package.json dependency manifest is required for JavaScript deployment.");
      if (lockfiles.length > 1) blockers.push(`Conflicting JavaScript lockfiles found: ${lockfiles.join(", ")}. Keep only the lockfile for the selected package manager.`);
      if (!lockfiles.length) warnings.push("No JavaScript lockfile was found; deployment will use a compatible non-frozen install command.");
      if (declaredPackageManager && lockfilePackageManagers.length === 1 && declaredPackageManager !== lockfilePackageManagers[0]) {
        blockers.push(`package.json declares ${declaredPackageManager}, but the repository lockfile belongs to ${lockfilePackageManagers[0]}.`);
      }
      if (profile.packageManager && lockfilePackageManagers.length === 1 && profile.packageManager !== lockfilePackageManagers[0]) {
        blockers.push(`Detected package manager ${profile.packageManager} does not match the ${lockfilePackageManagers[0]} lockfile.`);
      }
      if (lockfiles.includes("package-lock.json") && this.npmLockfileOutOfSync(packageJson, this.readJson(join(appPath, "package-lock.json")))) {
        blockers.push("package-lock.json is out of sync with package.json. Regenerate and commit the npm lockfile.");
      }
      installCommand = this.nodeInstallCommand(profile.packageManager, lockfiles);
      outputDirectory = this.nodeOutputDirectory(appPath, profile, scripts);
      if (profile.staticOutput && !scripts.build && !profile.buildCommand) blockers.push("Static JavaScript applications require a production build script.");
      if (profile.staticOutput && !outputDirectory) blockers.push("Static build output directory could not be inferred safely.");
      if (!profile.staticOutput && !profile.startCommand) blockers.push("A safe production start command could not be inferred for this JavaScript server.");
      const effectiveStartScript = String(scripts["start:prod"] || scripts.start || "");
      if (!profile.staticOutput && /\b(?:nodemon|ts-node-dev|vite\s+(?:dev|serve)|next\s+dev|react-scripts\s+start)\b|nest\s+start[^\n]*--watch/i.test(effectiveStartScript)) {
        blockers.push("The inferred start script launches a development server. Configure a production start command.");
      }
      if (!profile.staticOutput && ["express", "nestjs", "fastify", "nextjs", "nuxt", "sveltekit", "astro", "remix"].includes(profile.framework || "") && !bindsToPortEnv) {
        blockers.push("Server does not appear to read PORT from the environment. Bind the public server to the platform PORT value.");
      }
      if (bindHost === "localhost") blockers.push("Server appears to bind only to localhost. Bind the public server to 0.0.0.0.");
      if (profile.framework === "fastify" && bindHost !== "0.0.0.0") blockers.push("Fastify must explicitly bind to 0.0.0.0; its default host is not externally reachable.");
      databaseRequired = databaseRequired || this.nodeDatabaseEvidence(packageJson, combined);
      databaseEngine = this.nodeDatabaseEngine(packageJson, combined);
      const registry = this.nodePrivateRegistry(appPath);
      if (registry) {
        privateRegistryRequired = true;
        this.upsertEnv(env, "NPM_TOKEN", true, "build", registry, "required");
        warnings.push("Private npm registry configuration detected; NPM_TOKEN must be configured as a build secret.");
      }
    } else if (profile.ecosystem === "python") {
      dependencyFiles = PYTHON_MANIFESTS.filter((name) => rootFiles.has(name));
      lockfiles = PYTHON_LOCKFILES.filter((name) => rootFiles.has(name));
      const dependencyText = dependencyFiles.map((name) => this.safeRead(join(appPath, name))).join("\n").toLowerCase();
      if (rootFiles.has("requirements.txt") && this.requirementsArePinned(this.safeRead(join(appPath, "requirements.txt")))) lockfiles.push("requirements.txt");
      if (!dependencyFiles.length) blockers.push("Python deployment requires requirements.txt, pyproject.toml, Pipfile, setup.py, or setup.cfg.");
      if (lockfiles.length > 1) blockers.push(`Conflicting Python lockfiles found: ${lockfiles.join(", ")}. Keep only the lockfile for the selected package manager.`);
      if (!lockfiles.length) warnings.push("No Python lockfile or fully pinned requirements.txt was found; deployment will use the compatible manifest install command.");
      if (lockfiles.includes("uv.lock") || lockfiles.includes("pdm.lock")) blockers.push("uv.lock and pdm.lock projects are detected, but their locked environments are not yet supported safely by generated Docker templates.");
      installCommand = this.pythonInstallCommand(rootFiles, appPath);
      if (!profile.startCommand) blockers.push("A safe Python web application target and production start command could not be inferred.");
      platformRuntimeInstallCommand = this.generatedPythonRuntimeInstallCommand(profile, dependencyText);
      if (installCommand && platformRuntimeInstallCommand) {
        installCommand = `${installCommand} && ${platformRuntimeInstallCommand}`;
        warnings.push(`DeployGuard will supply the pinned ${platformRuntimeInstallCommand.includes("gunicorn") ? "Gunicorn" : "Uvicorn"} executable required by the generated runtime.`);
      }
      if (profile.framework === "streamlit" && !/\bstreamlit\b/.test(dependencyText)) blockers.push("Streamlit deployment requires streamlit in the dependency manifest.");
      if (!bindsToPortEnv) blockers.push("Python server does not prove that it accepts the platform PORT value.");
      if (bindHost === "localhost") blockers.push("Python server binds only to localhost. Bind it to 0.0.0.0.");
      this.validateDjango(profile.framework, source, env, blockers);
      databaseRequired = databaseRequired || this.pythonDatabaseEvidence(dependencyText, combined);
      databaseEngine = this.pythonDatabaseEngine(dependencyText, combined);
      const registry = this.pythonPrivateRegistry(appPath, dependencyText);
      if (registry) {
        privateRegistryRequired = true;
        this.upsertEnv(env, "PYPI_TOKEN", true, "build", registry, "required");
        warnings.push("Private Python package registry configuration detected; PYPI_TOKEN must be configured as a build secret.");
      }
    } else {
      blockers.push("Only JavaScript and Python web applications are supported.");
    }

    if (runtimeType === "server" && !profile.expectedPort && !detectedPort) blockers.push("A container port could not be inferred safely.");
    const privateFrontendBuildVariables = env
      .filter((item) => item.component === "frontend" && item.phase === "build" && item.exposure === "private" && item.secret && item.ownership === "user")
      .map((item) => item.key);
    if (privateFrontendBuildVariables.length) blockers.push(`Private configuration cannot enter a frontend browser build: ${privateFrontendBuildVariables.join(", ")}. Move it to a backend runtime or use an explicitly public frontend variable.`);
    if (runtimeType === "server" && bindHost === null && !["express", "nestjs"].includes(profile.framework || "")) blockers.push("The server bind host could not be proven safe for ECS.");
    if (!profile.healthCheckPath && !detectedHealthPath) blockers.push("A health-check path could not be inferred. Configure a public health path before deployment.");
    const healthPath = detectedHealthPath || profile.healthCheckPath || null;
    if (healthPath === "/") warnings.push("No explicit health endpoint was detected; the root path will be used for ALB health checks.");
    if (runtimeType === "server" && !detectedPort) warnings.push(`Using framework default port ${profile.expectedPort}; configure an explicit PORT fallback if the application uses another port.`);
    const databaseEvidenceKeys = env.filter((item) => item.database).map((item) => item.key);
    databaseRequired = databaseRequired || databaseEvidenceKeys.length > 0;
    if (!databaseEngine && databaseEvidenceKeys.some((key) => /MONGO/.test(key))) databaseEngine = "mongodb";
    if (!databaseEngine && databaseEvidenceKeys.some((key) => /MYSQL/.test(key))) databaseEngine = "mysql";
    if (!databaseEngine && databaseEvidenceKeys.some((key) => /POSTGRES|PG(?:HOST|PORT|USER|PASSWORD|DATABASE)/.test(key))) databaseEngine = "postgres";
    if (!databaseEngine && databaseEvidenceKeys.some((key) => /^DB_|^DATABASE_/.test(key))) databaseEngine = "postgres";
    const localDatabaseSources = databaseRequired ? [...new Set([...this.localDatabaseSources(source, appPath), ...composeLocalSources])] : [];
    if (databaseRequired && !env.some((item) => item.database && item.required)) {
      blockers.push("A database dependency was detected, but repository evidence does not show which runtime database variables the application consumes.");
    }
    if (databaseRequired && databaseEngine === "unsupported") blockers.push("The repository requires a database engine outside DeployGuard's managed PostgreSQL, MySQL, and MongoDB profiles.");

    if (profile.hasDockerfile) this.validateDockerfile(appPath, profile.expectedPort || detectedPort, blockers);
    if (profile.ecosystem === "node" && !this.readJson(join(appPath, "package.json"))?.engines?.node && !rootFiles.has(".nvmrc") && !rootFiles.has(".node-version")) warnings.push("No Node.js version is pinned in package.json, .nvmrc, or .node-version.");
    if (profile.ecosystem === "python" && !rootFiles.has("runtime.txt") && !rootFiles.has(".python-version") && !/requires-python\s*=/.test(this.safeRead(join(appPath, "pyproject.toml")))) warnings.push("No Python version is pinned in runtime.txt, .python-version, or pyproject.toml.");

    const requiredEnvironmentVariables = env.filter((item) => item.required && item.ownership === "user").map((item) => item.key).sort();
    const optionalEnvironmentVariables = env.filter((item) => !item.required && item.ownership === "user").map((item) => item.key).sort();
    return {
      runtimeType,
      bindsToPortEnv,
      bindHost,
      detectedPort,
      portSource: runtimeType === "static" ? "template_default" : sourcePort ? "source" : dockerfilePort ? "dockerfile_expose" : profile.expectedPort ? "framework_default" : null,
      detectedHealthPath,
      installCommand,
      platformRuntimeInstallCommand,
      outputDirectory,
      dependencyFiles,
      lockfiles,
      sourceFileCount: sourceFiles.length,
      requiredEnvironmentVariables,
      optionalEnvironmentVariables,
      environmentVariables: env.sort((a, b) => a.key.localeCompare(b.key)),
      platformProvidedEnvironmentVariables: env.filter((item) => item.ownership === "platform").map((item) => item.key).sort(),
      databaseRequired,
      databaseEngine,
      databaseLocalhostDetected: localDatabaseSources.length > 0,
      databaseLocalhostSources: localDatabaseSources,
      persistentStorageRequired,
      privateRegistryRequired,
      dockerfileBuildImage: dockerfileImages[0] || null,
      dockerfileRuntimeImage: dockerfileImages[dockerfileImages.length - 1] || null,
      deployabilityBlockers: [...new Set(blockers)],
      deployabilityWarnings: [...new Set(warnings)],
    };
  }

  private sourceFiles(root: string) {
    const files: string[] = [];
    let truncated = false;
    const visit = (directory: string, depth: number) => {
      if (depth > 7 || files.length >= 600) { truncated = true; return; }
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (files.length >= 600) { truncated = true; break; }
        if (entry.isDirectory()) { if (!IGNORED.has(entry.name)) visit(join(directory, entry.name), depth + 1); continue; }
        if (/\.(?:test|spec)\.[cm]?[jt]sx?$|^test[_-].*\.py$|_test\.py$/i.test(entry.name)) continue;
        const path = join(directory, entry.name);
        if (SOURCE_EXTENSIONS.has(extname(entry.name)) && statSync(path).size <= 512_000) files.push(path);
      }
    };
    visit(root, 0);
    return { files, truncated };
  }

  private environmentEvidence(appPath: string, source: Array<{ file: string; text: string }>, profile: RuntimeProfile) {
    const values = new Map<string, EnvEvidence>();
    const repositoryBuildAssignments = this.repositoryBuildAssignments(appPath, source);
    for (const item of source) {
      this.envMatches(item.text, /process\.env(?:\?\.)?\.([A-Z][A-Z0-9_]*)/g).forEach(({ key, optional }) => this.upsertEnv(values, key, !optional, BUILD_VARIABLE.test(key) ? "build" : "runtime", item.file));
      this.envMatches(item.text, /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g).forEach(({ key, optional }) => this.upsertEnv(values, key, !optional, BUILD_VARIABLE.test(key) ? "build" : "runtime", item.file));
      this.matches(item.text, /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\.env/g).flatMap((group) => group.split(",")).map((key) => key.split(/[=:]/)[0].trim()).filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key)).forEach((key) => this.upsertEnv(values, key, true, BUILD_VARIABLE.test(key) ? "build" : "runtime", item.file));
      this.envMatches(item.text, /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g).forEach(({ key, optional }) => this.upsertEnv(values, key, !optional, "build", item.file));
      this.envMatches(item.text, /(?:configService|config)\.get(?:<[^>]+>)?\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g, true).forEach(({ key }) => this.upsertEnv(values, key, false, "runtime", item.file));
      this.envMatches(item.text, /(?:configService|config)\.getOrThrow(?:<[^>]+>)?\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g).forEach(({ key }) => this.upsertEnv(values, key, true, "runtime", item.file));
      this.envMatches(item.text, /os\.environ\[['"]([A-Z][A-Z0-9_]*)['"]\]/g).forEach(({ key }) => this.upsertEnv(values, key, true, "runtime", item.file));
      this.envMatches(item.text, /(?:os\.getenv|os\.environ\.get|config|env(?:\.\w+)?)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g, true).forEach(({ key }) => this.upsertEnv(values, key, false, "runtime", item.file));
      for (const key of this.explicitlyRequiredEnvironmentKeys(item.text)) {
        this.upsertEnv(values, key, true, BUILD_VARIABLE.test(key) ? "build" : "runtime", item.file, "required");
      }
    }
    for (const name of [".env.example", ".env.sample", "sample.env"]) {
      const text = this.safeRead(join(appPath, name));
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*([^#]*)/);
        if (!match) continue;
        const value = match[2].trim().replace(/^['"]|['"]$/g, "");
        const required = !value || /^(?:<.+>|\$\{.+\}|change[-_]?me|replace[-_]?me|your[-_].+|xxx+)$/i.test(value);
        this.upsertEnv(values, match[1], required, BUILD_VARIABLE.test(match[1]) ? "build" : "runtime", name, required ? "required" : "optional");
        this.setSafeDetectedDefault(values, match[1], value);
      }
    }
    for (const name of readdirSync(appPath).filter((entry) => /^config\.example\./i.test(entry))) {
      const text = this.safeRead(join(appPath, name));
      this.matches(text, /(?:^|\n)\s*([A-Z][A-Z0-9_]*)\s*[:=]/g).forEach((key) => this.upsertEnv(values, key, false, "runtime", name));
    }
    for (const item of source) {
      const patterns = [
        /process\.env(?:\?\.)?\.([A-Z][A-Z0-9_]*)\s*(?:\|\||\?\?)\s*['"]([^'"]+)['"]/g,
        /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]\s*(?:\|\||\?\?)\s*['"]([^'"]+)['"]/g,
        /(?:os\.getenv|os\.environ\.get)\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g,
      ];
      for (const pattern of patterns) {
        for (const match of item.text.matchAll(pattern)) this.setSafeDetectedDefault(values, match[1], match[2]);
      }
    }
    for (const [key, assignmentSources] of repositoryBuildAssignments) {
      const evidence = values.get(key);
      if (!evidence) continue;
      evidence.required = false;
      evidence.phase = "build";
      evidence.platformProvided = false;
      evidence.ownership = "repository_build";
      evidence.requirement = "optional";
      for (const source of assignmentSources) if (!evidence.sources.includes(source)) evidence.sources.push(source);
    }
    for (const evidence of values.values()) {
      if (evidence.ownership === "platform") {
        evidence.component = "platform";
        evidence.exposure = "private";
        continue;
      }
      evidence.component = profile.staticOutput ? "frontend" : "backend";
      if (profile.staticOutput) evidence.phase = "build";
      evidence.exposure = profile.staticOutput && isPublicFrontendConfigurationKey(evidence.key) ? "public" : "private";
      evidence.public = evidence.exposure === "public";
      evidence.secret = evidence.exposure === "private" && SECRET_VARIABLE.test(evidence.key);
      evidence.required = evidence.requirement !== "optional";
    }
    return Array.from(values.values());
  }

  private explicitlyRequiredEnvironmentKeys(text: string) {
    const keys = new Set<string>();
    for (const match of text.matchAll(/if\s*\(\s*!\s*(?:process\.env(?:\?\.)?\.|process\.env\[['"]|import\.meta\.env\.|os\.environ\[['"])([A-Z][A-Z0-9_]*)/gi)) keys.add(match[1].toUpperCase());
    return keys;
  }

  private repositoryBuildAssignments(appPath: string, source: Array<{ file: string; text: string }>) {
    const assignments = new Map<string, string[]>();
    const add = (key: string, sourceName: string) => {
      const sources = assignments.get(key) || [];
      if (!sources.includes(sourceName)) sources.push(sourceName);
      assignments.set(key, sources);
    };
    const packageJson = this.readJson(join(appPath, "package.json"));
    const scripts = (packageJson?.scripts || {}) as Record<string, unknown>;
    for (const [name, raw] of Object.entries(scripts)) {
      const script = typeof raw === "string" ? raw : "";
      for (const match of script.matchAll(/(?:^|\s|[;&|])(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(?:'[^']*'|"[^"]*"|[^\s;&|]+)/g)) {
        add(match[1], `package.json#scripts.${name}`);
      }
    }
    const buildConfig = /^(?:webpack|vite|rollup|next|babel)(?:\.[\w-]+)*\.config\.[cm]?[jt]s$/i;
    for (const item of source.filter(({ file }) => buildConfig.test(file.split("/").pop() || ""))) {
      for (const match of item.text.matchAll(/process\.env(?:\.|\[['"])([A-Z][A-Z0-9_]*)(?:['"]\])?\s*[:=]\s*(?![=])/g)) add(match[1], item.file);
      for (const match of item.text.matchAll(/["']process\.env\.([A-Z][A-Z0-9_]*)["']\s*:\s*/g)) add(match[1], item.file);
    }
    return assignments;
  }

  private dockerComposeEvidence(appPath: string, values: EnvEvidence[]) {
    const localSources: string[] = [];
    for (const name of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
      const text = this.safeRead(join(appPath, name));
      if (!text) continue;
      const serviceNames = new Set(Array.from(text.matchAll(/^\s{2}([a-zA-Z0-9_.-]+):\s*$/gm), (match) => match[1]));
      for (const match of text.matchAll(/^\s*(?:-\s*)?([A-Z][A-Z0-9_]*)\s*(?:=|:)\s*([^#\n]*)/gm)) {
        const key = match[1];
        const raw = match[2].trim().replace(/^['"]|['"]$/g, "");
        const unresolved = !raw || /^\$\{[^}:]+(?::-[^}]*)?\}$/.test(raw);
        this.upsertEnv(values, key, unresolved, BUILD_VARIABLE.test(key) ? "build" : "runtime", name);
        if (!unresolved) this.setSafeDetectedDefault(new Map(values.map((item) => [item.key, item])), key, raw);
        if (serviceAliasLikeHost(key) && serviceNames.has(raw)) localSources.push(`${name}:${key}`);
      }
    }
    return localSources;
  }

  private setSafeDetectedDefault(values: Map<string, EnvEvidence>, key: string, raw: string) {
    const item = values.get(key);
    const value = raw.trim();
    if (!item || item.secret || item.platformProvided || !value || value.length > 255 || /\r|\n/.test(value)) return;
    item.detectedDefault = value;
  }

  private nodeInstallCommand(packageManager: string | null, lockfiles: string[]) {
    if (!packageManager) return null;
    if (packageManager === "pnpm") return lockfiles.includes("pnpm-lock.yaml") ? "corepack enable && pnpm install --frozen-lockfile" : "corepack enable && pnpm install";
    if (packageManager === "yarn") return lockfiles.includes("yarn.lock") ? "corepack enable && yarn install --frozen-lockfile" : "corepack enable && yarn install";
    if (packageManager === "bun") return lockfiles.some((item) => item.startsWith("bun.lock")) ? "bun install --frozen-lockfile" : "bun install";
    return lockfiles.some((item) => ["package-lock.json", "npm-shrinkwrap.json"].includes(item)) ? "npm ci" : "npm install";
  }

  private declaredNodePackageManager(value: unknown) {
    return String(value || "").trim().match(/^(npm|yarn|pnpm|bun)(?:@|$)/)?.[1] || null;
  }

  private nodeLockfilePackageManagers(lockfiles: string[]) {
    return [
      lockfiles.some((item) => item === "package-lock.json" || item === "npm-shrinkwrap.json") ? "npm" : null,
      lockfiles.includes("yarn.lock") ? "yarn" : null,
      lockfiles.includes("pnpm-lock.yaml") ? "pnpm" : null,
      lockfiles.some((item) => item === "bun.lock" || item === "bun.lockb") ? "bun" : null,
    ].filter((value): value is string => Boolean(value));
  }

  private npmLockfileOutOfSync(packageJson: Record<string, any> | null, lockfile: Record<string, any> | null) {
    const root = lockfile?.packages?.[""];
    if (!packageJson || !root || typeof root !== "object") return false;
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      const declared = packageJson[section] && typeof packageJson[section] === "object" ? packageJson[section] : {};
      const locked = root[section] && typeof root[section] === "object" ? root[section] : {};
      for (const [name, version] of Object.entries(declared)) if (locked[name] !== version) return true;
    }
    return false;
  }

  private pythonInstallCommand(files: Set<string>, appPath: string) {
    if (files.has("Pipfile")) return `pip install --no-cache-dir pipenv && pipenv install --system${files.has("Pipfile.lock") ? " --deploy" : ""}`;
    const pyproject = this.safeRead(join(appPath, "pyproject.toml"));
    if (files.has("pyproject.toml") && /\[tool\.poetry\]/.test(pyproject)) return "pip install --no-cache-dir poetry && poetry config virtualenvs.create false && poetry install --only main --no-root";
    if (files.has("requirements.txt")) return "pip install --no-cache-dir -r requirements.txt";
    return "pip install --no-cache-dir .";
  }

  private generatedPythonRuntimeInstallCommand(profile: RuntimeProfile, dependencyText: string) {
    if (profile.hasDockerfile) return null;
    const executable = profile.startCommand?.trim().match(/^(?:exec\s+)?(gunicorn|uvicorn)(?:\s|$)/)?.[1] as keyof typeof GENERATED_PYTHON_RUNTIME_PINS | undefined;
    if (!executable || this.pythonDependencyProvidesRuntime(dependencyText, executable)) return null;
    return `python -m pip install --no-cache-dir ${GENERATED_PYTHON_RUNTIME_PINS[executable]}`;
  }

  private pythonDependencyProvidesRuntime(dependencyText: string, executable: keyof typeof GENERATED_PYTHON_RUNTIME_PINS) {
    const declarations = dependencyText.split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, "")).join("\n");
    return new RegExp(`(?:^|[\\s"'[,])${executable}(?:\\[standard\\])?(?=\\s*(?:[<>=!~,"'\\]})]|$))`, "im").test(declarations);
  }

  private nodeOutputDirectory(appPath: string, profile: RuntimeProfile, scripts: Record<string, unknown>) {
    if (!profile.staticOutput) return null;
    const viteConfig = ["vite.config.js", "vite.config.mjs", "vite.config.ts"].map((name) => this.safeRead(join(appPath, name))).join("\n");
    const configured = viteConfig.match(/outDir\s*:\s*['"]([^'"]+)['"]/)?.[1];
    if (configured) return configured;
    const buildScript = String(scripts.build || "");
    const scripted = buildScript.match(/(?:--outDir|-o)\s+([^\s&]+)/)?.[1];
    if (scripted) return scripted.replace(/["']/g, "");
    const webpackConfig = ["webpack.config.js", "webpack.config.cjs", "webpack.config.mjs", "webpack.config.ts"]
      .map((name) => this.safeRead(join(appPath, name))).join("\n");
    const webpackOutput = deriveWebpackOutputDirectory(webpackConfig);
    if (webpackOutput) return webpackOutput;
    if (profile.framework === "vite-react") return "dist";
    if (profile.framework === "vite-vue" || profile.framework === "astro") return "dist";
    if (profile.framework === "create-react-app") return "build";
    if (profile.framework === "nextjs") return "out";
    if (profile.framework === "nuxt") return ".output/public";
    if (profile.framework === "sveltekit") return "build";
    if (profile.framework === "angular") {
      try {
        const angular = JSON.parse(this.safeRead(join(appPath, "angular.json")));
        const project = angular.defaultProject || Object.keys(angular.projects || {}).sort()[0];
        const options = angular.projects?.[project]?.architect?.build?.options || angular.projects?.[project]?.targets?.build?.options;
        return typeof options?.outputPath === "string" ? options.outputPath : options?.outputPath?.base ? `${options.outputPath.base}${options.outputPath.browser ? `/${options.outputPath.browser}` : ""}` : null;
      } catch { return null; }
    }
    return null;
  }

  private validateDjango(framework: string | null, source: Array<{ file: string; text: string }>, env: EnvEvidence[], blockers: string[]) {
    if (framework !== "django") return;
    const settings = source.filter((item) => /settings(?:\/|\\|\.)?.*\.py$|settings\.py$/.test(item.file)).map((item) => item.text).join("\n");
    if (/\bDEBUG\s*=\s*True\b/.test(settings)) blockers.push("Django DEBUG=True is unsafe for deployment. Read DEBUG from configuration and default it to false.");
    if (/ALLOWED_HOSTS\s*=\s*\[\s*\]/.test(settings) || /ALLOWED_HOSTS\s*=\s*\[\s*['"](?:localhost|127\.0\.0\.1)['"]\s*\]/.test(settings)) blockers.push("Django ALLOWED_HOSTS does not permit the deployed ALB hostname.");
    const literalSecret = settings.match(/SECRET_KEY\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    if (literalSecret) blockers.push("Django SECRET_KEY is hard-coded. Load it from a required runtime environment variable.");
    if (!/SECRET_KEY\s*=/.test(settings)) this.upsertEnv(env, "SECRET_KEY", true, "runtime", "Django settings");
  }

  private validateDockerfile(appPath: string, port: number | null, blockers: string[]) {
    const dockerfile = this.safeRead(join(appPath, "Dockerfile"));
    if (!dockerfile.trim()) { blockers.push("Docker strategy is custom, but Dockerfile is empty or unreadable."); return; }
    if (!/^(?:CMD|ENTRYPOINT)\b/m.test(dockerfile)) blockers.push("The custom Dockerfile has no CMD or ENTRYPOINT.");
    if (!/^EXPOSE\s+\d+/m.test(dockerfile) && !port) blockers.push("The custom Dockerfile does not expose a detectable application port.");
    if (/^\s*ARG\s+\w*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)\w*/im.test(dockerfile)) blockers.push("The custom Dockerfile declares a secret-like build argument; secrets must be injected only at runtime.");
    if (/^\s*ENV\s+\w*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)\w*\s*=\s*\S+/im.test(dockerfile)) blockers.push("The custom Dockerfile embeds a secret-like environment value in the image.");
  }

  private dockerfileImages(appPath: string, blockers: string[]) {
    const dockerfile = this.safeRead(join(appPath, "Dockerfile"));
    const aliases = new Map<string, string>();
    const images = Array.from(dockerfile.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?([^\s]+)(?:\s+AS\s+(\S+))?/gim), (match) => {
      const image = aliases.get(match[1].toLowerCase()) || match[1];
      if (match[2]) aliases.set(match[2].toLowerCase(), image);
      return image;
    });
    if (images.some((image) => image.includes("$") || image === "scratch")) blockers.push("The custom Dockerfile runtime image cannot be resolved to an immutable architecture safely.");
    if (images.some((image) => !image.includes("@sha256:") && (!image.includes(":") || /:latest$/i.test(image)))) blockers.push("Every custom Dockerfile base image must use an explicit version tag or digest.");
    return images;
  }

  private nodePrivateRegistry(appPath: string) {
    const files = [".npmrc", ".yarnrc", ".yarnrc.yml"];
    return files.find((name) => {
      const text = this.safeRead(join(appPath, name));
      return /[_-]authToken|npmAuthToken/i.test(text) || /registry\s*[:=].*https?:\/\/(?!registry\.npmjs\.org)/i.test(text);
    }) || null;
  }

  private pythonPrivateRegistry(appPath: string, dependencyText: string) {
    const config = ["pip.conf", ".pypirc"].find((name) => /index-url|repository\s*=/.test(this.safeRead(join(appPath, name))));
    return config || (/--(?:extra-)?index-url\s+https?:\/\/(?!pypi\.org)|git\+ssh:|https?:\/\/[^\s/@]+@/i.test(dependencyText) ? "Python dependency manifest" : null);
  }

  private nodeDatabaseEvidence(packageJson: Record<string, any> | null, source: string) {
    const dependencies = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    const names = Object.keys(dependencies);
    return names.some((name) => ["pg", "postgres", "typeorm", "prisma", "sequelize", "mysql", "mysql2", "mongoose", "mongodb", "redis", "ioredis", "better-sqlite3", "sqlite3"].includes(name)) || /DATABASE_URL|MONGODB_URI|createConnection\(|new PrismaClient/.test(source);
  }

  private nodeDatabaseEngine(packageJson: Record<string, any> | null, source: string): ManagedDatabaseEngine | "unsupported" | null {
    const dependencies = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    const names = Object.keys(dependencies);
    if (names.some((name) => ["mongoose", "mongodb"].includes(name)) || /MONGODB_URI|mongodb(?:\+srv)?:\/\//i.test(source)) return "mongodb";
    if (names.some((name) => ["mysql", "mysql2"].includes(name)) || /dialect\s*:\s*['"]mysql/i.test(source)) return "mysql";
    if (names.some((name) => ["pg", "postgres"].includes(name)) || /dialect\s*:\s*['"]postgres/i.test(source)) return "postgres";
    if (names.some((name) => ["typeorm", "prisma", "sequelize"].includes(name)) || /DATABASE_URL/.test(source)) return "postgres";
    if (names.some((name) => ["redis", "ioredis", "better-sqlite3", "sqlite3"].includes(name))) return "unsupported";
    return null;
  }

  private pythonDatabaseEvidence(dependencies: string, source: string) {
    return /psycopg|asyncpg|pymongo|redis|mysqlclient|mysql-connector|pymysql|sqlalchemy/.test(dependencies)
      || /DATABASE_URL|MONGODB_URI|REDIS_URL|django\.db\.backends\.(?:postgresql|mysql)|create_engine\(/.test(source);
  }

  private pythonDatabaseEngine(dependencies: string, source: string): ManagedDatabaseEngine | "unsupported" | null {
    if (/pymongo|motor(?:\W|$)/.test(dependencies) || /MONGODB_URI|mongodb(?:\+srv)?:\/\//i.test(source)) return "mongodb";
    if (/mysqlclient|mysql-connector|pymysql/.test(dependencies) || /django\.db\.backends\.mysql|mysql\+/.test(source)) return "mysql";
    if (/psycopg|asyncpg|sqlalchemy/.test(dependencies) || /django\.db\.backends\.postgresql|postgres(?:ql)?\+|DATABASE_URL/.test(source)) return "postgres";
    if (/redis|sqlite/.test(dependencies) || /REDIS_URL|sqlite/.test(source)) return "unsupported";
    return null;
  }

  private localDatabaseSources(source: Array<{ file: string; text: string }>, appPath: string) {
    const patterns = [
      /(?:DB_HOST|PGHOST|MYSQL_HOST|MONGO_HOST|MONGODB_HOST)\s*[:=]\s*['"]?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)/i,
      /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s'"@]*@(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(?::\d+)?/i,
      /host\s*[:=]\s*['"](?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)['"]/i,
    ];
    const matches = source.filter((item) => patterns.some((pattern) => pattern.test(item.text))).map((item) => item.file);
    for (const name of [".env.example", ".env.sample", "sample.env"]) {
      const text = this.safeRead(join(appPath, name));
      if (patterns.some((pattern) => pattern.test(text))) matches.push(name);
    }
    return [...new Set(matches)].sort();
  }

  private detectPersistentStorage(source: string, files: Set<string>) {
    if (Array.from(files).some((name) => /^(?:uploads?|media|storage)$|\.(?:sqlite|sqlite3|db)$/.test(name))) return true;
    return /multer|UPLOAD_FOLDER|MEDIA_ROOT|FileSystemStorage|sqlite3\.connect|writeFile(?:Sync)?\(|open\([^\n]+['"][wa+]['"]/.test(source);
  }

  private requirementsArePinned(text: string) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    if (lines.some((line) => /^-(?:r|c)\s|^--(?:requirement|constraint)\s/.test(line))) return false;
    const requirements = lines.filter((line) => !line.startsWith("-") && !/^https?:|^git\+/.test(line));
    return requirements.length > 0 && requirements.every((line) => /===?[^=\s]+(?:\s*;.*)?$/.test(line));
  }

  private usesPlatformPort(text: string) {
    return /\$\{?PORT/.test(text) ||
      /process\.env(?:\?\.)?\.PORT|process\.env\[['"]PORT['"]\]/.test(text) ||
      /os\.(?:getenv|environ\.get)\(\s*['"]PORT['"]|os\.environ\[['"]PORT['"]\]/.test(text) ||
      /env(?:\.\w+)?\(\s*['"]PORT['"]/.test(text);
  }

  private detectPort(text: string) {
    const match = text.match(/(?:process\.env(?:\?\.)?\.PORT|process\.env\[['"]PORT['"]\]|os\.(?:getenv|environ\.get)\(\s*['"]PORT['"]\s*,?)\s*(?:\|\||\?\?|,)?\s*['"]?(\d{2,5})/) || text.match(/--(?:server\.)?port(?:=|\s+)(\d{2,5})|\bPORT=(\d{2,5})|\bEXPOSE\s+(\d{2,5})/i);
    const value = match ? Number(match[1] || match[2] || match[3]) : null;
    return value && value <= 65535 ? value : null;
  }

  private detectBindHost(text: string, framework: string | null) {
    if (/(?:listen|run)\s*\([^)]*(?:host\s*[:=]\s*)?['"](?:127\.0\.0\.1|localhost)['"]|--host(?:=|\s+)(?:127\.0\.0\.1|localhost)|--server\.address(?:=|\s+)(?:127\.0\.0\.1|localhost)/i.test(text)) return "localhost";
    if (/(?:listen|run)\s*\([^)]*(?:host\s*[:=]\s*)?['"]0\.0\.0\.0['"]|host\s*:\s*['"]0\.0\.0\.0['"]|\bHOST(?:NAME)?=0\.0\.0\.0|--host(?:=|\s+)0\.0\.0\.0|-H\s+0\.0\.0\.0|--server\.address(?:=|\s+)0\.0\.0\.0|--bind\s+0\.0\.0\.0/i.test(text)) return "0.0.0.0";
    if (["express", "nestjs"].includes(framework || "") && /\.listen\s*\(/.test(text)) return "0.0.0.0";
    return null;
  }

  private upsertEnv(target: Map<string, EnvEvidence> | EnvEvidence[], key: string, required: boolean, phase: "build" | "runtime", source: string, requirement: EnvEvidence["requirement"] = required ? "unknown" : "optional") {
    const map = target instanceof Map ? target : new Map(target.map((item) => [item.key, item]));
    const current = map.get(key);
    const platformProvided = PLATFORM_VARIABLES.has(key);
    const value: EnvEvidence = current || { key, required, phase, public: BUILD_VARIABLE.test(key), secret: SECRET_VARIABLE.test(key), database: DATABASE_VARIABLE.test(key), platformProvided, ownership: platformProvided ? "platform" : "user", component: platformProvided ? "platform" : "backend", exposure: "private", requirement, sources: [] };
    if (value.ownership === "user") {
      const rank = { optional: 0, unknown: 1, required: 2 } as const;
      if (rank[requirement] > rank[value.requirement]) value.requirement = requirement;
      value.required = value.requirement !== "optional";
    }
    if (phase === "build") value.phase = "build";
    if (!value.sources.includes(source)) value.sources.push(source);
    map.set(key, value);
    if (Array.isArray(target) && !current) target.push(value);
  }

  private matches(text: string, pattern: RegExp) { return Array.from(text.matchAll(pattern), (match) => match[1]); }
  private envMatches(text: string, pattern: RegExp, functionCall = false) {
    return Array.from(text.matchAll(pattern), (match) => {
      const tail = text.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 70);
      const optional = functionCall ? /^\s*,|\bdefault\s*=/.test(tail) : /^\s*(?:\?\?|\|\|)/.test(tail);
      return { key: match[1], optional };
    });
  }

  private detectHealthPath(text: string) {
    const candidates = ["/health", "/healthz", "/api/health", "/status", "/ready", "/readiness", "/live", "/liveness"];
    return candidates.find((path) => new RegExp(`[\\'\"]${path.replace(/\//g, "\\/")}[\\'\"]`).test(text)) || null;
  }

  private safeRead(path: string) { try { return existsSync(path) && statSync(path).size <= 1_000_000 ? readFileSync(path, "utf8") : ""; } catch { return ""; } }
  private readJson(path: string): Record<string, any> | null { try { return JSON.parse(this.safeRead(path)); } catch { return null; } }
}
