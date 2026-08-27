import { Injectable } from "@nestjs/common";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, extname, join, relative, resolve } from "path";
import { ManagedDatabaseEngine } from "../managed-database-engine";
import { isPublicFrontendConfigurationKey, isSecretConfigurationKey } from "../configuration-ownership";
import { applicationFilesystemEphemeralWarning, APPLICATION_FILESYSTEM_EPHEMERAL_MESSAGE, type ReadinessWarningDetail } from "../readiness-warning";

const IGNORED = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "vendor", "__pycache__", ".venv", "venv", "__tests__", "tests", "test", "examples"]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py"]);
const PLATFORM_VARIABLES = new Set(["PORT", "HOST", "NODE_ENV", "PYTHONUNBUFFERED"]);
const DATABASE_VARIABLE = /^(?:DATABASE_(?:URL|HOST|PORT|NAME|USER|PASSWORD)|DB_(?:HOST|PORT|NAME|USER|PASSWORD)|POSTGRES(?:QL)?_(?:URL|HOST|PORT|USER|PASSWORD|DB)|PG(?:HOST|PORT|USER|PASSWORD|DATABASE)|MYSQL_(?:URL|HOST|PORT|USER|PASSWORD|DATABASE)|MONGO(?:DB)?_(?:URI|URL|HOST|PORT|USER|PASSWORD|DB|DATABASE))$/;
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
  rawProfile?: Record<string, unknown>;
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
  productionRelevant: boolean;
  sources: string[];
  detectedDefault?: string;
};

@Injectable()
export class RepoDeployabilityScannerService {
  scan(appPath: string, profile: RuntimeProfile) {
    const blockers: string[] = [];
    const warnings: string[] = [];
    const warningDetails: ReadinessWarningDetail[] = [];
    const sourceScan = this.sourceFiles(appPath);
    const sourceFiles = sourceScan.files;
    const source = sourceFiles.map((file) => ({ file: relative(appPath, file).replace(/\\/g, "/"), text: this.safeRead(file) }));
    const combined = source.map((item) => item.text).join("\n");
    const rootFiles = new Set(readdirSync(appPath));
    const env = this.environmentEvidence(appPath, source, profile);
    const composeLocalSources = this.dockerComposeEvidence(appPath, env, blockers);
    const runtimeType = profile.staticOutput ? "static" : "server";
    const detectedHealthPath = this.detectHealthPath(combined);
    const bindingEvidence = `${combined}\n${profile.startCommand || ""}`;
    const sourcePorts = this.detectPorts(bindingEvidence);
    const dockerfilePath = this.stringValue(profile.rawProfile?.dockerfilePath) || "Dockerfile";
    const dockerfileText = profile.hasDockerfile ? this.safeRead(join(appPath, dockerfilePath)) : "";
    const dockerfilePorts = profile.hasDockerfile ? this.detectPorts(dockerfileText) : [];
    const provenPorts = [...new Set([...sourcePorts, ...dockerfilePorts])];
    const sourcePort = sourcePorts.length === 1 ? sourcePorts[0] : null;
    const dockerfilePort = dockerfilePorts.length === 1 ? dockerfilePorts[0] : null;
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
    const databaseEngines = new Set<ManagedDatabaseEngine | "unsupported">();
    const filesystem = this.detectFilesystemBehavior(combined, rootFiles, profile);
    const persistentStorageRequired = filesystem.durableMountRequired;
    if (filesystem.ephemeralWritesDetected && !filesystem.durableMountRequired) {
      warnings.push(APPLICATION_FILESYSTEM_EPHEMERAL_MESSAGE);
      warningDetails.push(applicationFilesystemEphemeralWarning());
    }
    const dockerfileImages = profile.hasDockerfile ? this.dockerfileImages(dockerfileText, blockers) : [];

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
      for (const engine of this.nodeDatabaseEngines(packageJson, combined)) databaseEngines.add(engine);
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
      for (const engine of this.pythonDatabaseEngines(dependencyText, combined)) databaseEngines.add(engine);
      const registry = this.pythonPrivateRegistry(appPath, dependencyText);
      if (registry) {
        privateRegistryRequired = true;
        this.upsertEnv(env, "PYPI_TOKEN", true, "build", registry, "required");
        warnings.push("Private Python package registry configuration detected; PYPI_TOKEN must be configured as a build secret.");
      }
    } else {
      blockers.push("Only JavaScript and Python web applications are supported.");
    }

    const overridePort = Number((profile.rawProfile?.deploymentOverrides as Record<string, unknown> | undefined)?.port || 0);
    const generatedPort = runtimeType === "server" && bindsToPortEnv && profile.expectedPort ? profile.expectedPort : null;
    if (overridePort >= 1 && overridePort <= 65535) provenPorts.push(overridePort);
    const uniqueProvenPorts = [...new Set(provenPorts)];
    if (uniqueProvenPorts.length > 1) blockers.push(`PORT_IDENTITY_AMBIGUOUS: Conflicting proven server ports were found: ${uniqueProvenPorts.sort((a, b) => a - b).join(", ")}. Configure one authoritative deployment port.`);
    const detectedPort = uniqueProvenPorts.length === 1 ? uniqueProvenPorts[0] : uniqueProvenPorts.length === 0 ? generatedPort : null;
    if (runtimeType === "server" && !detectedPort) blockers.push("A container port could not be proven from repository evidence, an explicit override, or a generated PORT-binding contract.");
    const privateFrontendBuildVariables = env
      .filter((item) => item.productionRelevant && item.component === "frontend" && item.phase === "build" && item.exposure === "private" && item.secret && item.ownership === "user")
      .map((item) => item.key);
    if (privateFrontendBuildVariables.length) blockers.push(`Private configuration cannot enter a frontend browser build: ${privateFrontendBuildVariables.join(", ")}. Move it to a backend runtime or use an explicitly public frontend variable.`);
    if (runtimeType === "server" && bindHost === null && !["express", "nestjs"].includes(profile.framework || "")) blockers.push("The server bind host could not be proven safe for ECS.");
    const healthPath = detectedHealthPath || profile.healthCheckPath || null;
    const databaseEvidenceKeys = env.filter((item) => item.productionRelevant && item.database).map((item) => item.key);
    databaseRequired = databaseRequired || databaseEvidenceKeys.length > 0;
    if (databaseEvidenceKeys.some((key) => /MONGO/.test(key))) databaseEngines.add("mongodb");
    if (databaseEvidenceKeys.some((key) => /MYSQL/.test(key))) databaseEngines.add("mysql");
    if (databaseEvidenceKeys.some((key) => /POSTGRES|PG(?:HOST|PORT|USER|PASSWORD|DATABASE)/.test(key))) databaseEngines.add("postgres");
    if (databaseEngines.size > 1) {
      blockers.push(`DATABASE_ENGINE_AMBIGUOUS: Conflicting database engine evidence was found: ${[...databaseEngines].sort().join(", ")}. Select one supported engine and remove conflicting provider evidence.`);
      databaseEngine = null;
    } else {
      databaseEngine = [...databaseEngines][0] || null;
    }
    if (databaseRequired && !databaseEngine) blockers.push("DATABASE_ENGINE_AMBIGUOUS: Database usage is proven, but PostgreSQL, MySQL, or MongoDB cannot be determined safely from provider evidence.");
    const localDatabaseSources = databaseRequired ? [...new Set([...this.localDatabaseSources(source, appPath), ...composeLocalSources])] : [];
    if (databaseRequired && databaseEvidenceKeys.length === 0) {
      blockers.push("A database dependency was detected, but repository evidence does not show which runtime database variables the application consumes.");
    }
    if (databaseRequired && databaseEngine === "unsupported") blockers.push("The repository requires a database engine outside DeployGuard's managed PostgreSQL, MySQL, and MongoDB profiles.");

    const dockerfileRuntimeCommand = profile.hasDockerfile
      ? this.validateDockerfile(dockerfileText, profile.expectedPort || detectedPort, blockers)
      : null;
    if (profile.ecosystem === "node" && !this.readJson(join(appPath, "package.json"))?.engines?.node && !rootFiles.has(".nvmrc") && !rootFiles.has(".node-version")) warnings.push("No Node.js version is pinned in package.json, .nvmrc, or .node-version.");
    if (profile.ecosystem === "python" && !rootFiles.has("runtime.txt") && !rootFiles.has(".python-version") && !/requires-python\s*=/.test(this.safeRead(join(appPath, "pyproject.toml")))) warnings.push("No Python version is pinned in runtime.txt, .python-version, or pyproject.toml.");

    const requiredEnvironmentVariables = env.filter((item) => item.productionRelevant && item.required && item.ownership === "user").map((item) => item.key).sort();
    const optionalEnvironmentVariables = env.filter((item) => item.productionRelevant && !item.required && item.ownership === "user").map((item) => item.key).sort();
    return {
      runtimeType,
      bindsToPortEnv,
      bindHost,
      detectedPort,
      portSource: runtimeType === "static" ? "template_default" : overridePort ? "override" : sourcePort ? "source" : dockerfilePort ? "dockerfile_expose" : generatedPort ? "platform_generated" : null,
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
      dockerfilePath: profile.hasDockerfile ? dockerfilePath : null,
      dockerfileRuntimeCommand,
      deployabilityBlockers: [...new Set(blockers)],
      deployabilityWarnings: [...new Set(warnings)],
      deployabilityWarningDetails: warningDetails,
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
    const developmentOnlyEnvironmentKeys = this.developmentOnlyEnvironmentKeys(source);
    for (const item of source) {
      // A direct environment read is an unresolved production input unless the
      // repository proves a fallback or only compares/coerces it.  Do not let
      // the later evidence-normalization pass silently downgrade it to
      // "unknown", otherwise a browser build can ship with an absent API URL.
      this.envMatches(item.text, /process\.env(?:\?\.)?\.([A-Z][A-Z0-9_]*)/g).forEach(({ key, optional }) => this.upsertEnv(values, key, !optional, BUILD_VARIABLE.test(key) ? "build" : "runtime", item.file, optional ? "optional" : "required"));
      this.envMatches(item.text, /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g).forEach(({ key, optional }) => this.upsertEnv(values, key, !optional, BUILD_VARIABLE.test(key) ? "build" : "runtime", item.file, optional ? "optional" : "required"));
      this.matches(item.text, /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\.env/g).flatMap((group) => group.split(",")).map((key) => key.split(/[=:]/)[0].trim()).filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key)).forEach((key) => this.upsertEnv(values, key, true, BUILD_VARIABLE.test(key) ? "build" : "runtime", item.file, "required"));
      this.envMatches(item.text, /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g).forEach(({ key, optional }) => this.upsertEnv(values, key, !optional, "build", item.file, optional ? "optional" : "required"));
      this.envMatches(item.text, /(?:configService|config)\.get(?:<[^>]+>)?\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g, true).forEach(({ key }) => this.upsertEnv(values, key, false, "runtime", item.file));
      this.envMatches(item.text, /(?:configService|config)\.getOrThrow(?:<[^>]+>)?\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g).forEach(({ key }) => this.upsertEnv(values, key, true, "runtime", item.file, "required"));
      this.envMatches(item.text, /os\.environ\[['"]([A-Z][A-Z0-9_]*)['"]\]/g).forEach(({ key }) => this.upsertEnv(values, key, true, "runtime", item.file, "required"));
      this.envMatches(item.text, /(?:os\.getenv|os\.environ\.get|config|env(?:\.\w+)?)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g, true).forEach(({ key }) => this.upsertEnv(values, key, false, "runtime", item.file));
      for (const key of this.explicitlyRequiredEnvironmentKeys(item.text)) {
        this.upsertEnv(values, key, true, BUILD_VARIABLE.test(key) ? "build" : "runtime", item.file, "required");
      }
      for (const helper of this.provenRequiredEnvironmentHelpers(item.text)) {
        const call = new RegExp(`\\b${this.escapeRegExp(helper)}\\s*\\(\\s*['\"]([A-Z][A-Z0-9_]*)['\"]`, "g");
        for (const match of item.text.matchAll(call)) {
          this.upsertEnv(values, match[1], true, BUILD_VARIABLE.test(match[1]) ? "build" : "runtime", item.file, "required");
        }
      }
      this.pydanticSettingsEvidence(values, item);
    }
    for (const name of [".env.example", ".env.sample", "sample.env"]) {
      this.environmentFileEvidence(values, join(appPath, name), name, "template");
    }
    this.environmentFileEvidence(values, join(appPath, ".env"), ".env", "repository");
    this.environmentFileEvidence(values, join(appPath, ".env.production"), ".env.production", "production");
    this.environmentFileEvidence(values, join(appPath, ".env.local"), ".env.local", "development");
    this.readmeEnvironmentEvidence(values, appPath);
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
      if (developmentOnlyEnvironmentKeys.has(evidence.key)) {
        evidence.required = false;
        evidence.requirement = "optional";
        evidence.productionRelevant = false;
        evidence.component = "frontend";
        evidence.phase = "build";
        evidence.exposure = "private";
        evidence.public = false;
        continue;
      }
      if (evidence.ownership === "platform") {
        evidence.component = "platform";
        evidence.exposure = "private";
        continue;
      }
      const frontendReference = isPublicFrontendConfigurationKey(evidence.key) && evidence.phase === "build";
      evidence.component = profile.staticOutput || frontendReference ? "frontend" : "backend";
      if (profile.staticOutput || frontendReference) evidence.phase = "build";
      evidence.exposure = evidence.component === "frontend" && isPublicFrontendConfigurationKey(evidence.key) ? "public" : "private";
      evidence.public = evidence.exposure === "public";
      evidence.secret = evidence.exposure === "private" && isSecretConfigurationKey(evidence.key);
      evidence.required = evidence.requirement === "required";
    }
    return Array.from(values.values());
  }

  private explicitlyRequiredEnvironmentKeys(text: string) {
    const keys = new Set<string>();
    const fatal = String.raw`(?:throw\b|process\.exit\s*\()`;
    for (const match of text.matchAll(new RegExp(String.raw`if\s*\(\s*!\s*(?:process\.env(?:\?\.)?\.|process\.env\[['"]|import\.meta\.env\.)([A-Z][A-Z0-9_]*)['"]?\]?\s*\)\s*(?:\{\s*)?${fatal}`, "gi"))) keys.add(match[1].toUpperCase());
    for (const match of text.matchAll(new RegExp(String.raw`if\s*\(\s*(?:process\.env(?:\?\.)?\.|process\.env\[['"])([A-Z][A-Z0-9_]*)['"]?\]?\s*(?:===|==)\s*(?:undefined|null)\s*\)\s*(?:\{\s*)?${fatal}`, "gi"))) keys.add(match[1].toUpperCase());
    for (const match of text.matchAll(new RegExp(String.raw`if\s*\(\s*typeof\s+(?:process\.env(?:\?\.)?\.|process\.env\[['"])([A-Z][A-Z0-9_]*)['"]?\]?\s*(?:===|==)\s*['"]undefined['"]\s*\)\s*(?:\{\s*)?${fatal}`, "gi"))) keys.add(match[1].toUpperCase());
    for (const match of text.matchAll(/(?:mongoose\.connect|MongoClient|createConnection|createPool)\s*\(\s*(?:process\.env(?:\?\.)?\.|process\.env\[['"])([A-Z][A-Z0-9_]*)/g)) keys.add(match[1].toUpperCase());
    if (/\b(?:z|zod)\.object\s*\(/.test(text) && /\.parse\s*\(\s*process\.env\s*\)/.test(text)) {
      for (const match of text.matchAll(/\b([A-Z][A-Z0-9_]*)\s*:\s*(?:z|zod)\.(?:string|number|boolean|enum|nativeEnum)\s*\([^)]*\)((?:\s*\.[A-Za-z]+\s*\([^)]*\))*)/g)) {
        if (!/\.(?:optional|default|catch|nullish)\s*\(/.test(match[2])) keys.add(match[1]);
      }
    }
    for (const match of text.matchAll(/\b([A-Z][A-Z0-9_]*)\s*:\s*Joi\.[A-Za-z]+\s*\([^)]*\)(?:\s*\.[A-Za-z]+\s*\([^)]*\))*\s*\.required\s*\(/g)) keys.add(match[1]);
    return keys;
  }

  private provenRequiredEnvironmentHelpers(text: string) {
    const helpers = new Set<string>();
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const definition = lines[index].match(/^(\s*)def\s+([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)[^)]*\)\s*:/);
      if (!definition) continue;
      const indentation = definition[1].length;
      const body: string[] = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (!lines[cursor].trim()) { body.push(lines[cursor]); continue; }
        const bodyIndentation = lines[cursor].match(/^\s*/)?.[0].length || 0;
        if (bodyIndentation <= indentation) break;
        body.push(lines[cursor]);
      }
      const parameter = this.escapeRegExp(definition[3]);
      const source = body.join("\n");
      const readsEnvironment = new RegExp(`(?:os\\.getenv|os\\.environ\\.get)\\(\\s*${parameter}\\b|os\\.environ\\[\\s*${parameter}\\s*\\]`).test(source);
      if (readsEnvironment && /\braise\b|\bsys\.exit\s*\(/.test(source)) helpers.add(definition[2]);
    }

    const javascriptDefinitions = [
      /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{/g,
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)[^)=]*\)?\s*=>\s*\{/g,
    ];
    for (const pattern of javascriptDefinitions) {
      for (const definition of text.matchAll(pattern)) {
        const openingBrace = (definition.index || 0) + definition[0].lastIndexOf("{");
        const closingBrace = this.closingBrace(text, openingBrace);
        if (closingBrace < 0) continue;
        const parameter = this.escapeRegExp(definition[2]);
        const body = text.slice(openingBrace + 1, closingBrace);
        const readsEnvironment = new RegExp(`process\\.env(?:\\?\\.)?\\[\\s*${parameter}\\s*\\]`).test(body);
        if (readsEnvironment && /\bthrow\b|\bprocess\.exit\s*\(/.test(body)) helpers.add(definition[1]);
      }
    }
    return helpers;
  }

  private developmentOnlyEnvironmentKeys(source: Array<{ file: string; text: string }>) {
    const usage = new Map<string, { development: boolean; production: boolean }>();
    const reference = /process\.env(?:\?\.)?\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]|import\.meta\.env\.([A-Z][A-Z0-9_]*)/g;
    for (const item of source) {
      const developmentRanges = /^vite\.config\.[cm]?[jt]s$/i.test(item.file)
        ? this.objectPropertyRanges(item.text, "server")
        : [];
      for (const match of item.text.matchAll(reference)) {
        const key = match[1] || match[2] || match[3];
        const record = usage.get(key) || { development: false, production: false };
        const index = match.index || 0;
        if (developmentRanges.some(([start, end]) => index >= start && index <= end)) record.development = true;
        else record.production = true;
        usage.set(key, record);
      }
    }
    return new Set([...usage].filter(([, record]) => record.development && !record.production).map(([key]) => key));
  }

  private objectPropertyRanges(text: string, property: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    const pattern = new RegExp(`\\b${property}\\s*:\\s*\\{`, "g");
    for (const match of text.matchAll(pattern)) {
      const start = (match.index || 0) + match[0].lastIndexOf("{");
      let depth = 0;
      let quote = "";
      let escaped = false;
      for (let index = start; index < text.length; index += 1) {
        const character = text[index];
        if (quote) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === quote) quote = "";
          continue;
        }
        if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
        if (character === "{") depth += 1;
        if (character === "}" && --depth === 0) { ranges.push([start, index]); break; }
      }
    }
    return ranges;
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

  private dockerComposeEvidence(appPath: string, values: EnvEvidence[], blockers: string[]) {
    const localSources: string[] = [];
    const repositoryRoot = this.repositoryRoot(appPath);
    const roots = repositoryRoot === resolve(appPath) ? [resolve(appPath)] : [resolve(appPath), repositoryRoot];
    for (const root of roots) for (const name of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
      const completeText = this.safeRead(join(root, name));
      if (!completeText) continue;
      const applicationBlocks = this.composeApplicationBlocks(completeText, root, appPath);
      const evidenceBlocks = applicationBlocks.length ? applicationBlocks : root === resolve(appPath) ? [{ service: "application", text: completeText }] : [];
      if (!evidenceBlocks.length) continue;
      const serviceNames = new Set(Array.from(completeText.matchAll(/^\s{2}([a-zA-Z0-9_.-]+):\s*$/gm), (match) => match[1]));
      for (const block of evidenceBlocks) {
        for (const envFile of this.composeEnvFiles(block.text)) {
          const envFilePath = resolve(root, envFile);
          const evidenceSource = `${root === resolve(appPath) ? name : relative(repositoryRoot, join(root, name))}:${block.service}:env_file:${envFile}`;
          if (!existsSync(envFilePath)) {
            blockers.push(`COMPOSE_ENV_FILE_MISSING: ${evidenceSource} is required by the application service but does not exist.`);
            continue;
          }
          const envMap = new Map(values.map((item) => [item.key, item]));
          this.environmentFileEvidence(envMap, envFilePath, evidenceSource, "compose");
          for (const evidence of envMap.values()) if (!values.some((item) => item.key === evidence.key)) values.push(evidence);
        }
        for (const match of block.text.matchAll(/^\s*(?:-\s*)?([A-Z][A-Z0-9_]*)\s*(?:=|:)\s*([^#\n]*)/gm)) {
          const key = match[1];
          const raw = match[2].trim().replace(/^['"]|['"]$/g, "");
          const unresolved = !raw || /^\$\{[^}:]+(?::-[^}]*)?\}$/.test(raw);
          const evidenceSource = root === resolve(appPath) ? name : `${relative(repositoryRoot, join(root, name))}:${block.service}`;
          this.upsertEnv(values, key, unresolved, BUILD_VARIABLE.test(key) ? "build" : "runtime", evidenceSource, unresolved ? "unknown" : "optional");
          if (!unresolved) this.setSafeDetectedDefault(new Map(values.map((item) => [item.key, item])), key, raw);
          if (serviceAliasLikeHost(key) && serviceNames.has(raw)) localSources.push(`${evidenceSource}:${key}`);
        }
      }
    }
    return localSources;
  }

  private composeEnvFiles(block: string) {
    const files: string[] = [];
    const scalar = block.match(/^ {4}env_file:\s*([^#\n]+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    if (scalar) files.push(scalar);
    const list = block.match(/^ {4}env_file:\s*$([\s\S]*?)(?=^ {4}[A-Za-z0-9_.-]+:\s*|(?![\s\S]))/m)?.[1] || "";
    for (const match of list.matchAll(/^ {6}-\s*([^#\n]+)$/gm)) files.push(match[1].trim().replace(/^['"]|['"]$/g, ""));
    return files.filter((file) => file && !file.includes("${") && !file.startsWith("/"));
  }

  private environmentFileEvidence(
    target: Map<string, EnvEvidence>,
    path: string,
    source: string,
    policy: "template" | "repository" | "production" | "development" | "compose",
  ) {
    const text = this.safeRead(path);
    if (!text) return;
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*([^#]*)/);
      if (!match) continue;
      const value = match[2].trim().replace(/^['"]|['"]$/g, "");
      const placeholder = !value || /^(?:<.+>|\$\{.+\}|change[-_]?me|replace[-_]?me|your[-_].+|xxx+)$/i.test(value);
      const requirement: EnvEvidence["requirement"] = placeholder
        ? policy === "template" ? "required" : "unknown"
        : "optional";
      this.upsertEnv(target, match[1], false, BUILD_VARIABLE.test(match[1]) ? "build" : "runtime", source, requirement);
      const evidence = target.get(match[1]);
      if (evidence && policy === "development" && evidence.sources.length === 1) evidence.productionRelevant = false;
      if (!placeholder && policy !== "development" && policy !== "repository") this.setSafeDetectedDefault(target, match[1], value);
    }
  }

  private readmeEnvironmentEvidence(values: Map<string, EnvEvidence>, appPath: string) {
    const readmeName = readdirSync(appPath).find((name) => /^readme(?:\.[a-z0-9]+)?$/i.test(name));
    if (!readmeName) return;
    const text = this.safeRead(join(appPath, readmeName));
    const sections = Array.from(text.matchAll(/^(?:#{1,4}\s*)?(?:required\s+)?(?:environment|configuration)\s+variables?\s*:?[ \t]*$([\s\S]*?)(?=^#{1,4}\s|\n\s*\n\s*\n|(?![\s\S]))/gim));
    for (const section of sections) {
      for (const match of section[1].matchAll(/^(?:\s*[-*]\s*)?`?([A-Z][A-Z0-9_]*)`?(?:\s*[:=-]|\s*$)/gm)) {
        this.upsertEnv(values, match[1], false, BUILD_VARIABLE.test(match[1]) ? "build" : "runtime", `${readmeName} (supporting evidence)`, "unknown");
      }
    }
  }

  private pydanticSettingsEvidence(values: Map<string, EnvEvidence>, item: { file: string; text: string }) {
    if (!/\bBaseSettings\b/.test(item.text)) return;
    const classes = Array.from(item.text.matchAll(/^class\s+[A-Za-z_]\w*\s*\([^)]*BaseSettings[^)]*\)\s*:\s*$([\s\S]*?)(?=^class\s|(?![\s\S]))/gm));
    for (const candidate of classes) {
      for (const field of candidate[1].matchAll(/^\s{4,}([A-Z][A-Z0-9_]*)\s*:\s*([^=\n#]+?)(?:\s*=\s*([^#\n]+))?\s*$/gm)) {
        const type = field[2].trim();
        const defaultValue = field[3]?.trim();
        const optional = defaultValue !== undefined || /\bOptional\s*\[|\|\s*None\b/.test(type);
        this.upsertEnv(values, field[1], !optional, BUILD_VARIABLE.test(field[1]) ? "build" : "runtime", item.file, optional ? "optional" : "required");
      }
    }
  }

  private repositoryRoot(appPath: string) {
    let current = resolve(appPath);
    for (let depth = 0; depth <= 8; depth += 1) {
      if (existsSync(join(current, ".git"))) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return resolve(appPath);
  }

  private composeApplicationBlocks(text: string, composeRoot: string, appPath: string) {
    const services = Array.from(text.matchAll(/^ {2}([a-zA-Z0-9_.-]+):\s*$/gm));
    return services.flatMap((match, index) => {
      const start = match.index || 0;
      const end = services[index + 1]?.index ?? text.length;
      const block = text.slice(start, end);
      const scalarBuild = block.match(/^ {4}build:[ \t]+([^#\n]+)[ \t]*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
      const nestedBuild = block.match(/^ {4}build:[ \t]*$[\s\S]*?^ {6}context:[ \t]*([^#\n]+)[ \t]*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
      const context = scalarBuild || nestedBuild;
      return context && resolve(composeRoot, context) === resolve(appPath)
        ? [{ service: match[1], text: block }]
        : [];
    });
  }

  private closingBrace(text: string, openingBrace: number) {
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let index = openingBrace; index < text.length; index += 1) {
      const character = text[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
      if (character === "{") depth += 1;
      if (character === "}" && --depth === 0) return index;
    }
    return -1;
  }

  private escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  private nodeOutputDirectory(_appPath: string, profile: RuntimeProfile, _scripts: Record<string, unknown>) {
    if (!profile.staticOutput) return null;
    // Framework resolution is the canonical producer of an output directory.
    // Re-parsing project config here previously allowed downstream fallbacks to
    // overwrite an unresolved Angular selection with the alphabetically first
    // project.  A legacy profile without this fact must be re-analysed instead.
    const canonical = this.stringValue(profile.rawProfile?.outputDirectory);
    if (canonical) return canonical;
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

  private validateDockerfile(dockerfile: string, port: number | null, blockers: string[]) {
    if (!dockerfile.trim()) { blockers.push("Docker strategy is custom, but Dockerfile is empty or unreadable."); return; }
    const stages = dockerfile.split(/^\s*FROM\s+/gim).slice(1);
    const finalStage = stages[stages.length - 1] || "";
    const entrypoint = Array.from(finalStage.matchAll(/^\s*ENTRYPOINT\s+(.+)$/gim)).at(-1)?.[1]?.trim() || null;
    const command = Array.from(finalStage.matchAll(/^\s*CMD\s+(.+)$/gim)).at(-1)?.[1]?.trim() || null;
    if (!entrypoint && !command) blockers.push("The custom Dockerfile final runtime stage has no CMD or ENTRYPOINT.");
    if (!/^\s*EXPOSE\s+\d+/im.test(finalStage) && !port) blockers.push("The custom Dockerfile final runtime stage does not expose a detectable application port.");
    const runtimeUser = Array.from(finalStage.matchAll(/^\s*USER\s+([^\s#]+).*$/gim)).at(-1)?.[1]?.trim() || null;
    if (!runtimeUser || /^(?:0|root)(?::(?:0|root))?$/i.test(runtimeUser)) blockers.push("The custom Dockerfile final runtime stage must declare a non-root USER.");
    if (/^\s*ARG\s+\w*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)\w*/im.test(dockerfile)) blockers.push("The custom Dockerfile declares a secret-like build argument; secrets must be injected only at runtime.");
    if (/^\s*ENV\s+\w*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)\w*\s*=\s*\S+/im.test(dockerfile)) blockers.push("The custom Dockerfile embeds a secret-like environment value in the image.");
    return this.dockerRuntimeCommand(entrypoint, command);
  }

  private dockerfileImages(dockerfile: string, blockers: string[]) {
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

  private dockerRuntimeCommand(entrypoint: string | null, command: string | null) {
    const tokens = (value: string | null) => {
      if (!value) return [] as string[];
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
      } catch { /* Shell form is retained as authoritative text. */ }
      return [value];
    };
    const parts = [...tokens(entrypoint), ...tokens(command)];
    return parts.length ? parts.join(" ") : null;
  }

  private stringValue(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
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
    return names.some((name) => ["pg", "postgres", "typeorm", "prisma", "sequelize", "mysql", "mysql2", "mongoose", "mongodb"].includes(name)) || /DATABASE_URL|MONGODB_URI|createConnection\(|new PrismaClient/.test(source);
  }

  private nodeDatabaseEngines(packageJson: Record<string, any> | null, source: string) {
    const dependencies = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    const names = Object.keys(dependencies);
    const engines = new Set<ManagedDatabaseEngine | "unsupported">();
    if (names.some((name) => ["mongoose", "mongodb"].includes(name)) || /MONGODB_URI|mongodb(?:\+srv)?:\/\//i.test(source)) engines.add("mongodb");
    if (names.some((name) => ["mysql", "mysql2"].includes(name)) || /dialect\s*:\s*['"]mysql/i.test(source)) engines.add("mysql");
    if (names.some((name) => ["pg", "postgres"].includes(name)) || /dialect\s*:\s*['"]postgres/i.test(source)) engines.add("postgres");
    return engines;
  }

  private pythonDatabaseEvidence(dependencies: string, source: string) {
    return /psycopg|asyncpg|pymongo|mysqlclient|mysql-connector|pymysql|sqlalchemy/.test(dependencies)
      || /DATABASE_URL|MONGODB_URI|django\.db\.backends\.(?:postgresql|mysql)|create_engine\(/.test(source);
  }

  private pythonDatabaseEngines(dependencies: string, source: string) {
    const engines = new Set<ManagedDatabaseEngine | "unsupported">();
    if (/pymongo|motor(?:\W|$)/.test(dependencies) || /MONGODB_URI|mongodb(?:\+srv)?:\/\//i.test(source)) engines.add("mongodb");
    if (/mysqlclient|mysql-connector|pymysql/.test(dependencies) || /django\.db\.backends\.mysql|mysql\+/.test(source)) engines.add("mysql");
    if (/psycopg|asyncpg/.test(dependencies) || /django\.db\.backends\.postgresql|postgres(?:ql)?\+/.test(source)) engines.add("postgres");
    return engines;
  }

  private localDatabaseSources(source: Array<{ file: string; text: string }>, appPath: string) {
    const patterns = [
      /(?:DB_HOST|PGHOST|MYSQL_HOST|MONGO_HOST|MONGODB_HOST)\s*[:=]\s*['"]?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)/i,
      /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s'"@]*@(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(?::\d+)?/i,
      /(?:create(?:Connection|Pool)|new\s+(?:Pool|Client)|DATABASES|database)\s*(?:\([^{}]*)?\{[^}]{0,500}?\b(?:host|HOST)\s*[:=]\s*['"](?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)['"]/i,
    ];
    const matches = source.filter((item) => patterns.some((pattern) => pattern.test(item.text))).map((item) => item.file);
    for (const name of [".env.example", ".env.sample", "sample.env"]) {
      const text = this.safeRead(join(appPath, name));
      if (patterns.some((pattern) => pattern.test(text))) matches.push(name);
    }
    return [...new Set(matches)].sort();
  }

  private detectFilesystemBehavior(source: string, files: Set<string>, profile: RuntimeProfile) {
    const filesystemEvidence = profile.rawProfile?.filesystemPersistenceDetected === true
      || Array.from(files).some((name) => /^(?:uploads?|media|storage|cache|tmp|logs?)$|\.(?:sqlite|sqlite3|db)$/.test(name))
      || /multer|UPLOAD_FOLDER|MEDIA_ROOT|FileSystemStorage|sqlite3\.connect|writeFile(?:Sync)?\(|appendFile(?:Sync)?\(|open\([^\n]+['"][wa+]['"]/.test(source);
    const mandatoryDurabilityEvidence = /(?:persistent|durable|shared)\s*(?:filesystem|file system|storage|volume|mount).{0,100}(?:required|mandatory|must|cannot start|fatal)/i.test(source)
      || /(?:required|mandatory|must|cannot start|fatal).{0,100}(?:persistent|durable|shared)\s*(?:filesystem|file system|storage|volume|mount)/i.test(source)
      || /(?:\bPersistentVolumeClaim\b|\bReadWriteMany\b|\bhostPath\b|\bmountpoint\b|\bstatfs\b|docker\.sock|\/dev\/|nfs:\/\/)/i.test(source);
    return {
      ephemeralWritesDetected: filesystemEvidence,
      durableMountRequired: profile.requiresPersistentStorage || mandatoryDurabilityEvidence,
    };
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

  private detectPorts(text: string) {
    const ports = new Set<number>();
    const patterns = [
      /(?:process\.env(?:\?\.)?\.PORT|process\.env\[['"]PORT['"]\]|os\.(?:getenv|environ\.get)\(\s*['"]PORT['"]\s*,?)\s*(?:\|\||\?\?|,)?\s*['"]?(\d{2,5})/gi,
      /--(?:server\.)?port(?:=|\s+)(\d{2,5})/gi,
      /\bPORT=(\d{2,5})/g,
      /\$\{PORT:-(\d{2,5})\}/g,
      /\bEXPOSE\s+(\d{2,5})/gi,
      /\.listen\s*\(\s*(\d{2,5})\b/g,
    ];
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (value >= 1 && value <= 65535) ports.add(value);
    }
    return [...ports];
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
    const value: EnvEvidence = current || { key, required, phase, public: BUILD_VARIABLE.test(key), secret: isSecretConfigurationKey(key), database: DATABASE_VARIABLE.test(key), platformProvided, ownership: platformProvided ? "platform" : "user", component: platformProvided ? "platform" : "backend", exposure: "private", requirement, productionRelevant: true, sources: [] };
    if (value.ownership === "user") {
      const rank = { optional: 0, unknown: 1, required: 2 } as const;
      if (rank[requirement] > rank[value.requirement]) value.requirement = requirement;
      value.required = value.requirement === "required";
    }
    if (phase === "build") value.phase = "build";
    if (!value.sources.includes(source)) value.sources.push(source);
    map.set(key, value);
    if (Array.isArray(target) && !current) target.push(value);
  }

  private matches(text: string, pattern: RegExp) { return Array.from(text.matchAll(pattern), (match) => match[1]); }
  private envMatches(text: string, pattern: RegExp, functionCall = false) {
    return Array.from(text.matchAll(pattern), (match) => {
      const index = match.index || 0;
      const head = text.slice(Math.max(0, index - 80), index);
      const tail = text.slice(index + match[0].length, index + match[0].length + 80);
      const deterministicComparison = /^\s*(?:===|!==|==|!=)\s*(?:['"`][^'"`]*['"`]|true|false|null|undefined|-?\d+(?:\.\d+)?)/.test(tail)
        || /(?:['"`][^'"`]*['"`]|true|false|null|undefined|-?\d+(?:\.\d+)?)\s*(?:===|!==|==|!=)\s*$/.test(head);
      const booleanCoercion = /(?:Boolean\s*\(|!!\s*)$/.test(head) && /^\s*\)?/.test(tail);
      const optional = functionCall ? /^\s*,|\bdefault\s*=/.test(tail) : /^\s*(?:\?\?|\|\|)/.test(tail) || deterministicComparison || booleanCoercion;
      return { key: match[1], optional };
    });
  }

  private detectHealthPath(text: string) {
    const candidates = ["/health", "/healthz", "/api/health", "/status", "/ready", "/readiness", "/live", "/liveness"];
    return candidates.find((path) => {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const djangoPath = path.replace(/^\//, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return [
        new RegExp(`@?(?:[A-Za-z_$][\\w$]*\\.)+(?:get|head|route)\\s*\\(\\s*['\"]${escaped}['\"]`),
        new RegExp(`@(Get|Head)\\s*\\(\\s*['\"]${escaped}['\"]`),
        new RegExp(`\\b(?:path|re_path|url)\\s*\\(\\s*(?:r|f|rf|fr)?['\"](?:\\^)?${djangoPath}/?(?:\\$)?['\"]\\s*,`),
      ].some((pattern) => pattern.test(text));
    }) || null;
  }

  private safeRead(path: string) { try { return existsSync(path) && statSync(path).size <= 1_000_000 ? readFileSync(path, "utf8") : ""; } catch { return ""; } }
  private readJson(path: string): Record<string, any> | null { try { return JSON.parse(this.safeRead(path)); } catch { return null; } }
}
