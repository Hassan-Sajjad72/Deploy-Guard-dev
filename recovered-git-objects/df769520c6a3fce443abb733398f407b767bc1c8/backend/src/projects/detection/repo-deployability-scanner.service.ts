import { Injectable } from "@nestjs/common";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { extname, join, relative } from "path";

const IGNORED = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "vendor", "__pycache__", ".venv", "venv", "__tests__", "tests", "test", "examples"]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py"]);
const PLATFORM_VARIABLES = new Set(["PORT", "HOST", "NODE_ENV", "PYTHONUNBUFFERED"]);
const DATABASE_VARIABLE = /^(?:DATABASE_(?:URL|HOST|PORT|NAME|USER|PASSWORD)|DB_(?:HOST|PORT|NAME|USER|PASSWORD)|POSTGRES(?:QL)?_(?:URL|HOST|PORT|USER|PASSWORD|DB)|PG(?:HOST|PORT|USER|PASSWORD|DATABASE)|MYSQL_(?:URL|HOST|PORT|USER|PASSWORD|DATABASE)|MONGO(?:DB)?_(?:URI|URL|HOST|PORT|USER|PASSWORD|DB|DATABASE))$/;
const SECRET_VARIABLE = /(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|DATABASE_URL|CREDENTIAL|AUTH_KEY)/;
const BUILD_VARIABLE = /^(VITE_|NEXT_PUBLIC_|REACT_APP_)/;
const JS_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];
const PYTHON_LOCKFILES = ["poetry.lock", "Pipfile.lock", "uv.lock", "pdm.lock"];
const PYTHON_MANIFESTS = ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg"];
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
    const env = this.environmentEvidence(appPath, source);
    const composeLocalSources = this.dockerComposeEvidence(appPath, env);
    const runtimeType = profile.staticOutput ? "static" : "server";
    const detectedHealthPath = this.detectHealthPath(combined);
    const bindingEvidence = `${combined}\n${profile.startCommand || ""}`;
    const detectedPort = this.detectPort(bindingEvidence);
    const bindsToPortEnv = runtimeType === "server" && this.usesPlatformPort(bindingEvidence);
    const bindHost = this.detectBindHost(profile.startCommand || "", profile.framework) || this.detectBindHost(combined, profile.framework);
    let dependencyFiles: string[] = [];
    let lockfiles: string[] = [];
    let installCommand: string | null = null;
    let outputDirectory: string | null = null;
    let privateRegistryRequired = false;
    let databaseRequired = profile.requiresDatabase;
    let databaseEngine: "postgres" | "mysql" | "unsupported" | null = null;
    let persistentStorageRequired = profile.requiresPersistentStorage || this.detectPersistentStorage(combined, rootFiles);

    if (rootFiles.has(".env")) blockers.push("A real .env file is present in the repository. DeployGuard does not read its values; remove it from source control and configure required secrets securely.");

    if (sourceScan.truncated) blockers.push("Repository source scan reached its safety limit. Select a narrower application directory before deployment.");

    if (profile.ecosystem === "node") {
      dependencyFiles = rootFiles.has("package.json") ? ["package.json"] : [];
      lockfiles = JS_LOCKFILES.filter((name) => rootFiles.has(name));
      const packageJson = this.readJson(join(appPath, "package.json"));
      const scripts = (packageJson?.scripts || {}) as Record<string, unknown>;
      if (!packageJson) blockers.push("A valid package.json dependency manifest is required for JavaScript deployment.");
      if (lockfiles.length > 1) blockers.push(`Conflicting JavaScript lockfiles found: ${lockfiles.join(", ")}. Keep only the lockfile for the selected package manager.`);
      if (!lockfiles.length) warnings.push("No JavaScript lockfile was found; dependency installation may not be reproducible.");
      installCommand = this.nodeInstallCommand(profile.packageManager, lockfiles);
      outputDirectory = this.nodeOutputDirectory(appPath, profile, scripts);
      if (profile.staticOutput && !scripts.build && !profile.buildCommand) blockers.push("Static JavaScript applications require a production build script.");
      if (profile.staticOutput && !outputDirectory) blockers.push("Static build output directory could not be inferred safely.");
      if (!profile.staticOutput && !profile.startCommand) blockers.push("A safe production start command could not be inferred for this JavaScript server.");
      const effectiveStartScript = String(scripts["start:prod"] || scripts.start || "");
      if (!profile.staticOutput && /\b(?:nodemon|ts-node-dev|vite\s+(?:dev|serve)|next\s+dev|react-scripts\s+start)\b|nest\s+start[^\n]*--watch/i.test(effectiveStartScript)) {
        blockers.push("The inferred start script launches a development server. Configure a production start command.");
      }
      if (!profile.staticOutput && ["express", "nestjs", "fastify", "nextjs"].includes(profile.framework || "") && !bindsToPortEnv) {
        blockers.push("Server does not appear to read PORT from the environment. Bind the public server to the platform PORT value.");
      }
      if (bindHost === "localhost") blockers.push("Server appears to bind only to localhost. Bind the public server to 0.0.0.0.");
      if (profile.framework === "fastify" && bindHost !== "0.0.0.0") blockers.push("Fastify must explicitly bind to 0.0.0.0; its default host is not externally reachable.");
      databaseRequired = databaseRequired || this.nodeDatabaseEvidence(packageJson, combined);
      databaseEngine = this.nodeDatabaseEngine(packageJson, combined);
      const registry = this.nodePrivateRegistry(appPath);
      if (registry) {
        privateRegistryRequired = true;
        this.upsertEnv(env, "NPM_TOKEN", true, "build", registry);
        warnings.push("Private npm registry configuration detected; NPM_TOKEN must be configured as a build secret.");
      }
    } else if (profile.ecosystem === "python") {
      dependencyFiles = PYTHON_MANIFESTS.filter((name) => rootFiles.has(name));
      lockfiles = PYTHON_LOCKFILES.filter((name) => rootFiles.has(name));
      const dependencyText = dependencyFiles.map((name) => this.safeRead(join(appPath, name))).join("\n").toLowerCase();
      if (rootFiles.has("requirements.txt") && this.requirementsArePinned(this.safeRead(join(appPath, "requirements.txt")))) lockfiles.push("requirements.txt");
      if (!dependencyFiles.length) blockers.push("Python deployment requires requirements.txt, pyproject.toml, Pipfile, setup.py, or setup.cfg.");
      if (lockfiles.length > 1) blockers.push(`Conflicting Python lockfiles found: ${lockfiles.join(", ")}. Keep only the lockfile for the selected package manager.`);
      if (!lockfiles.length) warnings.push("No Python lockfile was found; dependency installation may not be reproducible.");
      if (lockfiles.includes("uv.lock") || lockfiles.includes("pdm.lock")) blockers.push("uv.lock and pdm.lock projects are detected, but their locked environments are not yet supported safely by generated Docker templates.");
      installCommand = this.pythonInstallCommand(rootFiles, appPath);
      if (!profile.startCommand) blockers.push("A safe Python web application target and production start command could not be inferred.");
      if (["django", "flask"].includes(profile.framework || "") && !/\bgunicorn\b/.test(dependencyText)) blockers.push(`${profile.framework === "django" ? "Django" : "Flask"} deployment requires gunicorn in the dependency manifest.`);
      if (profile.framework === "fastapi" && !/\buvicorn(?:\[standard\])?\b/.test(dependencyText)) blockers.push("FastAPI deployment requires uvicorn in the dependency manifest.");
      if (profile.framework === "streamlit" && !/\bstreamlit\b/.test(dependencyText)) blockers.push("Streamlit deployment requires streamlit in the dependency manifest.");
      if (!bindsToPortEnv) blockers.push("Python server does not prove that it accepts the platform PORT value.");
      if (bindHost === "localhost") blockers.push("Python server binds only to localhost. Bind it to 0.0.0.0.");
      this.validateDjango(profile.framework, source, env, blockers);
      databaseRequired = databaseRequired || this.pythonDatabaseEvidence(dependencyText, combined);
      databaseEngine = this.pythonDatabaseEngine(dependencyText, combined);
      const registry = this.pythonPrivateRegistry(appPath, dependencyText);
      if (registry) {
        privateRegistryRequired = true;
        this.upsertEnv(env, "PYPI_TOKEN", true, "build", registry);
        warnings.push("Private Python package registry configuration detected; PYPI_TOKEN must be configured as a build secret.");
      }
    } else {
      blockers.push("Only JavaScript and Python web applications are supported.");
    }

    if (runtimeType === "server" && !profile.expectedPort && !detectedPort) blockers.push("A container port could not be inferred safely.");
    if (runtimeType === "server" && bindHost === null && !["express", "nestjs"].includes(profile.framework || "")) blockers.push("The server bind host could not be proven safe for ECS.");
    if (!profile.healthCheckPath && !detectedHealthPath) blockers.push("A health-check path could not be inferred. Configure a public health path before deployment.");
    const healthPath = detectedHealthPath || profile.healthCheckPath || null;
    if (healthPath === "/") warnings.push("No explicit health endpoint was detected; the root path will be used for ALB health checks.");
    if (runtimeType === "server" && !detectedPort) warnings.push(`Using framework default port ${profile.expectedPort}; configure an explicit PORT fallback if the application uses another port.`);
    const databaseEvidenceKeys = env.filter((item) => item.database).map((item) => item.key);
    databaseRequired = databaseRequired || databaseEvidenceKeys.length > 0;
    if (!databaseEngine && databaseEvidenceKeys.some((key) => /MYSQL/.test(key))) databaseEngine = "mysql";
    if (!databaseEngine && databaseEvidenceKeys.some((key) => /POSTGRES|PG(?:HOST|PORT|USER|PASSWORD|DATABASE)|^DB_|^DATABASE_/.test(key))) databaseEngine = "postgres";
    if (!databaseEngine && databaseEvidenceKeys.some((key) => /MONGO/.test(key))) databaseEngine = "unsupported";
    const localDatabaseSources = databaseRequired ? [...new Set([...this.localDatabaseSources(source, appPath), ...composeLocalSources])] : [];
    if (databaseRequired && !env.some((item) => item.database && item.required)) {
      blockers.push("A database dependency was detected, but repository evidence does not show which runtime database variables the application consumes.");
    }
    if (databaseRequired && databaseEngine === "unsupported") blockers.push("The repository requires a database engine that DeployGuard cannot provision. Configure a reachable external PostgreSQL or MySQL database.");

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
      portSource: runtimeType === "static" ? "template_default" : detectedPort ? "source" : profile.expectedPort ? "framework_default" : null,
      detectedHealthPath,
      installCommand,
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

  private environmentEvidence(appPath: string, source: Array<{ file: string; text: string }>) {
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
    }
    for (const name of [".env.example", ".env.sample", "sample.env"]) {
      const text = this.safeRead(join(appPath, name));
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*([^#]*)/);
        if (!match) continue;
        const value = match[2].trim().replace(/^['"]|['"]$/g, "");
        const required = !value || /^(?:<.+>|\$\{.+\}|change[-_]?me|replace[-_]?me|your[-_].+|xxx+)$/i.test(value);
        this.upsertEnv(values, match[1], required, BUILD_VARIABLE.test(match[1]) ? "build" : "runtime", name);
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
      for (const source of assignmentSources) if (!evidence.sources.includes(source)) evidence.sources.push(source);
    }
    return Array.from(values.values());
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
    if (!item || item.secret || !value || value.length > 255 || /\r|\n/.test(value)) return;
    item.detectedDefault = value;
  }

  private nodeInstallCommand(packageManager: string | null, lockfiles: string[]) {
    if (packageManager === "pnpm") return lockfiles.includes("pnpm-lock.yaml") ? "pnpm install --frozen-lockfile" : "pnpm install";
    if (packageManager === "yarn") return lockfiles.includes("yarn.lock") ? "yarn install --frozen-lockfile" : "yarn install";
    if (packageManager === "bun") return lockfiles.some((item) => item.startsWith("bun.lock")) ? "bun install --frozen-lockfile" : "bun install";
    return lockfiles.some((item) => ["package-lock.json", "npm-shrinkwrap.json"].includes(item)) ? "npm ci" : "npm install";
  }

  private pythonInstallCommand(files: Set<string>, appPath: string) {
    if (files.has("Pipfile")) return "pip install --no-cache-dir pipenv && pipenv install --system --deploy";
    const pyproject = this.safeRead(join(appPath, "pyproject.toml"));
    if (files.has("pyproject.toml") && /\[tool\.poetry\]/.test(pyproject)) return "pip install --no-cache-dir poetry && poetry config virtualenvs.create false && poetry install --only main --no-root";
    if (files.has("requirements.txt")) return "pip install --no-cache-dir -r requirements.txt";
    return "pip install --no-cache-dir .";
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
    const webpackOutput = webpackConfig.match(/output\s*:\s*\{[\s\S]{0,1200}?path\s*:\s*(?:path\.(?:join|resolve)\(\s*__dirname\s*,\s*|__dirname\s*\+\s*)["']([^"']+)["']/)?.[1]
      ?.replace(/^\/+|\/+$/g, "");
    if (webpackOutput && !webpackOutput.split("/").includes("..") && /^[A-Za-z0-9._/-]+$/.test(webpackOutput)) return webpackOutput;
    if (profile.framework === "vite-react") return "dist";
    if (profile.framework === "react") return "build";
    if (profile.framework === "nextjs") return "out";
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

  private nodeDatabaseEngine(packageJson: Record<string, any> | null, source: string): "postgres" | "mysql" | "unsupported" | null {
    const dependencies = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    const names = Object.keys(dependencies);
    if (names.some((name) => ["mysql", "mysql2"].includes(name)) || /dialect\s*:\s*['"]mysql/i.test(source)) return "mysql";
    if (names.some((name) => ["pg", "postgres"].includes(name)) || /dialect\s*:\s*['"]postgres/i.test(source)) return "postgres";
    if (names.some((name) => ["typeorm", "prisma", "sequelize"].includes(name)) || /DATABASE_URL/.test(source)) return "postgres";
    if (names.some((name) => ["mongoose", "mongodb", "redis", "ioredis", "better-sqlite3", "sqlite3"].includes(name))) return "unsupported";
    return null;
  }

  private pythonDatabaseEvidence(dependencies: string, source: string) {
    return /psycopg|asyncpg|pymongo|redis|mysqlclient|mysql-connector|pymysql|sqlalchemy/.test(dependencies)
      || /DATABASE_URL|MONGODB_URI|REDIS_URL|django\.db\.backends\.(?:postgresql|mysql)|create_engine\(/.test(source);
  }

  private pythonDatabaseEngine(dependencies: string, source: string): "postgres" | "mysql" | "unsupported" | null {
    if (/mysqlclient|mysql-connector|pymysql/.test(dependencies) || /django\.db\.backends\.mysql|mysql\+/.test(source)) return "mysql";
    if (/psycopg|asyncpg|sqlalchemy/.test(dependencies) || /django\.db\.backends\.postgresql|postgres(?:ql)?\+|DATABASE_URL/.test(source)) return "postgres";
    if (/pymongo|redis|sqlite/.test(dependencies) || /MONGODB_URI|REDIS_URL|sqlite/.test(source)) return "unsupported";
    return null;
  }

  private localDatabaseSources(source: Array<{ file: string; text: string }>, appPath: string) {
    const patterns = [
      /(?:DB_HOST|PGHOST|MYSQL_HOST)\s*[:=]\s*['"]?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)/i,
      /(?:postgres(?:ql)?|mysql):\/\/[^\s'"@]*@(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(?::\d+)?/i,
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
    if (/(?:listen|run)\s*\([^)]*(?:host\s*[:=]\s*)?['"]0\.0\.0\.0['"]|host\s*:\s*['"]0\.0\.0\.0['"]|--host(?:=|\s+)0\.0\.0\.0|-H\s+0\.0\.0\.0|--server\.address(?:=|\s+)0\.0\.0\.0|--bind\s+0\.0\.0\.0/i.test(text)) return "0.0.0.0";
    if (["express", "nestjs"].includes(framework || "") && /\.listen\s*\(/.test(text)) return "0.0.0.0";
    return null;
  }

  private upsertEnv(target: Map<string, EnvEvidence> | EnvEvidence[], key: string, required: boolean, phase: "build" | "runtime", source: string) {
    const map = target instanceof Map ? target : new Map(target.map((item) => [item.key, item]));
    const current = map.get(key);
    const platformProvided = PLATFORM_VARIABLES.has(key);
    const value: EnvEvidence = current || { key, required, phase, public: BUILD_VARIABLE.test(key), secret: SECRET_VARIABLE.test(key), database: DATABASE_VARIABLE.test(key), platformProvided, ownership: platformProvided ? "platform" : "user", sources: [] };
    if (value.ownership === "user") value.required = value.required || required;
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
