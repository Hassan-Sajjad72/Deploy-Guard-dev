import { Injectable, Logger } from "@nestjs/common";
import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { TemplateMatchingService } from "./template-matching.service";
import { RepoDeployabilityScannerService } from "./repo-deployability-scanner.service";
import { ProjectDeploymentOverrides } from "../project.entity";
import { FrameworkDetectorResult } from "./framework-detector";
import { MainstreamDetectorResolverService } from "./mainstream-detector-resolver.service";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
]);
const MANIFEST_NAMES = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "setup.py",
  "setup.cfg",
  "manage.py",
  "app.py",
  "main.py",
  "wsgi.py",
  "asgi.py",
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

export type DetectedApplicationComponent = {
  id: "frontend" | "backend";
  role: "frontend" | "backend";
  root: string;
  buildContext: string;
  framework: string;
  frameworkVariant: string;
  runtimeType: "static" | "server";
  port: number;
  healthCheckPath: string;
  databaseType: "postgres" | "mysql" | "mongodb" | null;
  profile: DeploymentProfileDraft;
};

export type DetectedApplicationTopology = {
  schemaVersion: 1;
  status: "supported" | "blocked";
  components: DetectedApplicationComponent[];
  managedDatabase: null | {
    engine: "postgres" | "mysql" | "mongodb";
    ownerComponentId: "backend";
  };
  relationships: Array<{
    from: "frontend";
    to: "backend";
    kind: "http";
    mode: "same-origin" | "build-time-url";
    pathPrefix: string;
    stripPathPrefix: boolean;
    buildTimeVariable: string | null;
    verificationPath: string;
  }>;
  blockers: string[];
};

type Candidate = { directory: string; relativeDirectory: string; files: Set<string> };

const SUPPORTED_FRAMEWORKS = new Set([
  "nextjs",
  "vite-react",
  "create-react-app",
  "react",
  "vite-vue",
  "nuxt",
  "angular",
  "sveltekit",
  "astro",
  "remix",
  "express",
  "nestjs",
  "fastify",
  "flask",
  "fastapi",
  "django",
  "streamlit",
]);

@Injectable()
export class StackDetectionService {
  private readonly logger = new Logger(StackDetectionService.name);

  constructor(
    private readonly templateMatchingService: TemplateMatchingService,
    private readonly deployabilityScanner: RepoDeployabilityScannerService,
    private readonly detectorResolver: MainstreamDetectorResolverService = new MainstreamDetectorResolverService(),
  ) {}

  detect(
    workspacePath: string,
    commitSha: string | null,
    preferredAppDirectory?: string | null,
    overrides: ProjectDeploymentOverrides = {},
    includeTopology = true,
  ): DeploymentProfileDraft {
    const scanRoot = this.resolveScanRoot(workspacePath, preferredAppDirectory);
    const preferredDirectory = relative(workspacePath, scanRoot).replace(/\\/g, "/") || ".";
    const manifestFiles = this.findManifestFiles(scanRoot);
    const candidates = this.buildCandidates(scanRoot, manifestFiles);
    const selected = this.selectCandidate(candidates);
    const rankedCandidates = candidates.map((candidate) => ({ directory: candidate.relativeDirectory, score: this.candidateScore(candidate), files: Array.from(candidate.files).sort() })).sort((left, right) => right.score - left.score);
    const plausibleCandidates = rankedCandidates.filter((candidate) => candidate.score >= 100);
    const appRootAmbiguous = !preferredAppDirectory && plausibleCandidates.length > 1 && plausibleCandidates[0].score - plausibleCandidates[1].score < 20;
    const detectedDirectory = selected?.relativeDirectory || ".";
    const appDirectory = [preferredDirectory, detectedDirectory]
      .filter((directory) => directory !== ".")
      .join("/") || ".";
    const appPath = selected?.directory || scanRoot;
    const appFiles = selected?.files || new Set(readdirSync(scanRoot));
    const rootFiles = new Set(readdirSync(workspacePath));
    const repositoryEntries = Array.from(rootFiles).filter((name) => name !== ".git");
    const hasDockerfile = appFiles.has("Dockerfile");
    const warnings: string[] = [];
    const errors: string[] = [];
    const rawProfile: Record<string, unknown> = {
      rootFiles: Array.from(rootFiles).sort(),
      appDirectory,
      preferredAppDirectory: preferredAppDirectory || null,
      manifestFiles,
      cloneError: null,
      branchError: null,
      repositoryEmpty: repositoryEntries.length === 0,
      repositoryEntryCount: repositoryEntries.length,
      detectedCandidates: rankedCandidates,
      appRootConfidence: appRootAmbiguous ? "low" : selected ? "high" : "low",
      appRootReason: appRootAmbiguous ? "Multiple deployable application roots have similar confidence." : selected ? "Highest-scoring supported web application candidate." : "No supported web application candidate found.",
      repositoryDockerfileDetected: hasDockerfile,
      deploymentOverrides: overrides,
    };
    let profile = this.baseProfile(commitSha, hasDockerfile, warnings, errors, rawProfile);

    if (repositoryEntries.length === 0) {
      errors.push("The selected repository and branch are empty. Add application files before running stack detection.");
    }

    if (repositoryEntries.length === 0) {
      // Preserve an explicit unknown/failed profile; never infer a default stack.
    } else if (selected) {
      if (appFiles.has("package.json") || appFiles.has("manage.py") || this.hasPythonManifest(appFiles) || ["app.py", "main.py", "wsgi.py", "asgi.py"].some((name) => appFiles.has(name))) {
        const detection = this.detectorResolver.resolve(appPath, appFiles);
        if (detection.result) {
          profile = this.applyDetectorResult(profile, detection.result, appPath, workspacePath);
          if (detection.ambiguous.length) profile.errors.push(`${detection.result.language === "javascript" ? "Conflicting JavaScript framework evidence" : "Ambiguous detector results"}: ${[detection.result.detectorId, ...detection.ambiguous].join(", ")}.`);
          if (profile.ecosystem === "node") {
            const db = this.detectNodeDatabase(detection.facts.dependencies);
            profile.requiresDatabase = Boolean(db);
            profile.databaseType = db;
            this.detectPersistentStorage(appPath, appFiles, profile, detection.facts.dependencies);
          } else {
            this.detectPythonPersistentStorage(appPath, appFiles, profile, detection.facts.dependencyText.toLowerCase());
          }
        } else {
          profile.ecosystem = appFiles.has("package.json") ? "node" : "python";
          profile.language = profile.ecosystem === "node" ? "javascript" : "python";
          profile.framework = "unknown";
          profile.frameworkVariant = profile.ecosystem === "node" ? "generic-node" : "generic-python";
          profile.errors.push("No independent mainstream framework detector matched the repository evidence.");
        }
      } else if (appFiles.has("composer.json") || appFiles.has("artisan") || appFiles.has("index.php")) {
        profile = this.detectPhp(appPath, appFiles, profile);
      } else if (appFiles.has("Gemfile")) {
        profile = this.detectRuby(appPath, profile);
      }
    } else {
      warnings.push("No known stack manifests were found within scan depth 5.");
    }

    this.applyOverrides(profile, overrides, appPath, errors);
    // A repository Dockerfile is evidence, not the containerization decision.
    // Only the explicit custom override authorizes custom-Dockerfile analysis.
    const customDockerfileSelected = overrides.dockerfileMode === "custom";
    const deployability = this.deployabilityScanner.scan(appPath, { ...profile, hasDockerfile: customDockerfileSelected });
    Object.assign(profile.rawProfile, deployability);
    if (typeof deployability.detectedPort === "number") profile.expectedPort = deployability.detectedPort;
    if (deployability.databaseRequired) profile.requiresDatabase = true;
    if (["postgres", "mysql", "mongodb"].includes(String(deployability.databaseEngine || ""))) {
      profile.databaseType = String(deployability.databaseEngine);
    }
    if (deployability.persistentStorageRequired) profile.requiresPersistentStorage = true;
    if (overrides.installCommand) {
      const platformRuntimeInstallCommand = typeof deployability.platformRuntimeInstallCommand === "string" ? deployability.platformRuntimeInstallCommand : null;
      profile.rawProfile.installCommand = [overrides.installCommand.trim(), platformRuntimeInstallCommand].filter(Boolean).join(" && ");
    }
    if (overrides.outputDirectory) profile.rawProfile.outputDirectory = overrides.outputDirectory.trim();
    if (deployability.detectedHealthPath && !overrides.healthCheckPath) profile.healthCheckPath = deployability.detectedHealthPath;
    warnings.push(...deployability.deployabilityWarnings);
    errors.push(...deployability.deployabilityBlockers);
    const ambiguousRootMessage = `Multiple application roots are plausible (${plausibleCandidates.slice(0, 3).map((candidate) => candidate.directory).join(", ")}). Select an application directory in Project Settings.`;
    if (appRootAmbiguous) errors.push(ambiguousRootMessage);

    const template = this.templateMatchingService.selectTemplate({ ...profile, dockerfileMode: overrides.dockerfileMode || "generated" });
    profile.selectedTemplate = template.selectedTemplate;
    profile.dockerfileRequired = template.dockerfileRequired;
    profile.detectionStatus = template.detectionStatus;
    profile.rawProfile.templateMatched = template.templateMatched;
    profile.rawProfile.unsupportedReason = template.unsupportedReason;
    profile.rawProfile.containerizationSource = template.selectedTemplate === "custom-dockerfile" ? "repository" : "deployguard";
    profile.rawProfile.repositoryDockerfileIgnored = hasDockerfile && template.selectedTemplate !== "custom-dockerfile";
    profile.rawProfile.detected = profile.ecosystem !== "unknown";

    if (!["node", "python"].includes(profile.ecosystem)) {
      profile.detectionStatus = "manual_input_required";
      profile.rawProfile.templateMatched = false;
      profile.rawProfile.unsupportedReason = "Only JavaScript and Python web applications are supported.";
    } else if (!profile.framework || !SUPPORTED_FRAMEWORKS.has(profile.framework)) {
      errors.push("A supported JavaScript or Python web framework could not be identified without guessing.");
      profile.detectionStatus = "manual_input_required";
      profile.rawProfile.templateMatched = false;
      profile.rawProfile.unsupportedReason = "Only the documented JavaScript and Python web framework baseline is supported.";
    } else if (errors.length > 0) {
      profile.detectionStatus = "manual_input_required";
    }

    if (repositoryEntries.length === 0) {
      profile.selectedTemplate = null;
      profile.dockerfileRequired = false;
      profile.detectionStatus = "manual_input_required";
      profile.rawProfile.templateMatched = false;
      profile.rawProfile.unsupportedReason = "The selected repository and branch are empty.";
    }

    if (template.unsupportedReason) {
      warnings.push(template.unsupportedReason);
    } else if (profile.selectedTemplate === "custom-dockerfile-required") {
      warnings.push("No safe automatic template was found.");
    }
    profile.confidence = profile.framework && profile.framework !== "unknown"
      ? "high"
      : profile.ecosystem !== "unknown" ? "medium" : "low";

    if (includeTopology && !preferredAppDirectory && repositoryEntries.length > 0) {
      const topology = this.detectTopology(workspacePath, commitSha, candidates, overrides);
      profile.rawProfile.componentTopology = topology;
      profile.rawProfile.components = topology.components.map(({ profile: _profile, ...component }) => component);
      profile.rawProfile.topologyStatus = topology.status;
      profile.rawProfile.topologyBlockers = topology.blockers;
      if (topology.components.length > 1) {
        const ambiguousIndex = profile.errors.indexOf(ambiguousRootMessage);
        if (ambiguousIndex >= 0) profile.errors.splice(ambiguousIndex, 1);
        profile.rawProfile.appRootConfidence = topology.status === "supported" ? "high" : "low";
        profile.rawProfile.appRootReason = "A bounded application component topology was analyzed instead of selecting one root.";
      }
      for (const blocker of topology.blockers) if (!profile.errors.includes(blocker)) profile.errors.push(blocker);
      if (topology.status === "blocked") profile.detectionStatus = "manual_input_required";
      else if (topology.components.length > 1 && profile.errors.length === 0) profile.detectionStatus = "success";
    }

    this.logger.log(`Manifest files found: ${manifestFiles.join(", ") || "none"}`);
    this.logger.log(`Selected app directory: ${appDirectory}`);
    this.logger.log(
      `Final stack ecosystem=${profile.ecosystem} framework=${profile.framework} template=${
        profile.selectedTemplate
      } matched=${String(template.templateMatched)}`
    );
    return profile;
  }

  private detectTopology(
    repositoryRoot: string,
    commitSha: string | null,
    manifestCandidates: Candidate[],
    overrides: ProjectDeploymentOverrides,
  ): DetectedApplicationTopology {
    const components: DetectedApplicationComponent[] = [];
    for (const candidate of manifestCandidates) {
      const root = relative(repositoryRoot, candidate.directory).replace(/\\/g, "/") || ".";
      const componentProfile = this.detect(repositoryRoot, commitSha, root, overrides, false);
      const role = this.componentRole(componentProfile);
      if (!role || !componentProfile.framework || !SUPPORTED_FRAMEWORKS.has(componentProfile.framework)) continue;
      components.push({
        id: role,
        role,
        root,
        buildContext: root,
        framework: componentProfile.framework,
        frameworkVariant: componentProfile.frameworkVariant || componentProfile.selectedTemplate || "unknown",
        runtimeType: componentProfile.staticOutput ? "static" : "server",
        port: componentProfile.expectedPort || (componentProfile.staticOutput ? 8080 : 0),
        healthCheckPath: componentProfile.staticOutput ? "/" : componentProfile.healthCheckPath || "/",
        databaseType: role === "backend" && ["postgres", "mysql", "mongodb"].includes(String(componentProfile.databaseType || ""))
          ? componentProfile.databaseType as "postgres" | "mysql" | "mongodb"
          : null,
        profile: componentProfile,
      });
    }
    for (const root of this.findStaticWebRoots(repositoryRoot)) {
      if (components.some((component) => component.root === root)) continue;
      components.push(this.staticWebComponent(repositoryRoot, root, commitSha, overrides));
    }

    const frontends = components.filter((component) => component.role === "frontend");
    const backends = components.filter((component) => component.role === "backend");
    const blockers: string[] = [];
    if (frontends.length > 1) blockers.push("The bounded full-stack contract supports exactly one frontend component; multiple frontends were detected.");
    if (backends.length > 1) blockers.push("The bounded full-stack contract supports at most one backend component; multiple backends were detected.");
    if (components.length === 0) blockers.push("No supported deployable application component was detected.");
    if (frontends.length === 1 && backends.length === 1 && frontends[0].runtimeType !== "static") {
      blockers.push("This bounded full-stack release supports a static frontend with one backend; a server-rendered frontend plus backend is outside the current contract.");
    }
    if (frontends.length === 1 && backends.length === 1 && frontends[0].profile.selectedTemplate === "custom-dockerfile") {
      blockers.push("A full-stack custom frontend Dockerfile cannot be selected until it proves the DeployGuard-managed /api proxy contract. Use DeployGuard-generated frontend containerization or provide a supported single-component custom deployment.");
    }

    const relationships: DetectedApplicationTopology["relationships"] = [];
    if (frontends.length === 1 && backends.length === 1) {
      const relationship = this.frontendBackendRelationship(repositoryRoot, frontends[0].root, backends[0]);
      if (relationship.blocker) blockers.push(relationship.blocker);
      if (relationship.value) relationships.push(relationship.value);
    }
    const backend = backends.length === 1 ? backends[0] : null;
    const managedDatabase = backend?.databaseType
      ? { engine: backend.databaseType, ownerComponentId: "backend" as const }
      : null;
    return {
      schemaVersion: 1,
      status: blockers.length ? "blocked" : "supported",
      components: components.sort((left, right) => (left.role === "frontend" ? -1 : 1) - (right.role === "frontend" ? -1 : 1)),
      managedDatabase,
      relationships,
      blockers,
    };
  }

  private componentRole(profile: DeploymentProfileDraft): "frontend" | "backend" | null {
    if (profile.staticOutput) return "frontend";
    if (["express", "nestjs", "fastify", "flask", "fastapi", "django"].includes(profile.framework || "")) return "backend";
    if (["nextjs", "nuxt", "sveltekit", "astro", "remix", "streamlit"].includes(profile.framework || "")) return "frontend";
    return null;
  }

  private findStaticWebRoots(repositoryRoot: string) {
    const found: string[] = [];
    const visit = (directory: string, depth: number) => {
      if (depth > 5) return;
      const entries = readdirSync(directory, { withFileTypes: true });
      const names = new Set(entries.map((entry) => entry.name));
      if (names.has("index.html")) {
        const root = relative(repositoryRoot, directory).replace(/\\/g, "/") || ".";
        const html = this.readOptionalFile(directory, "index.html") || "";
        const strongName = /^(frontend|client|web|site|public)$/i.test(basename(directory));
        const assetEvidence = /<(?:script|link)\b[^>]*(?:src|href)=["'][^"']+/i.test(html)
          && (entries.some((entry) => entry.isDirectory() && /^(?:css|js|assets|images?)$/i.test(entry.name)) || /\.(?:css|js)(?:[?"'])/i.test(html));
        if (strongName && assetEvidence) found.push(root);
      }
      for (const entry of entries) if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) visit(join(directory, entry.name), depth + 1);
    };
    visit(repositoryRoot, 0);
    return found;
  }

  private staticWebComponent(repositoryRoot: string, root: string, commitSha: string | null, overrides: ProjectDeploymentOverrides): DetectedApplicationComponent {
    const repositoryDockerfile = existsSync(join(repositoryRoot, root, "Dockerfile"));
    const custom = overrides.dockerfileMode === "custom" && repositoryDockerfile;
    const rawProfile: Record<string, unknown> = {
      appDirectory: root,
      repositoryInstallRoot: root,
      detectorId: "static-web.strong-isolated-directory",
      detectorEvidence: [{ source: `${root}/index.html`, description: "Isolated static frontend entry point and local assets were found." }],
      runtimeType: "static",
      outputDirectory: ".",
      bindHost: null,
      bindsToPortEnv: false,
      installCommand: "true",
      dependencyFiles: ["index.html"],
      lockfiles: [],
      containerizationSource: custom ? "repository" : "deployguard",
    };
    const profile: DeploymentProfileDraft = {
      commitSha,
      ecosystem: "static-web",
      language: "javascript",
      framework: "static-web",
      frameworkVariant: "static-web",
      packageManager: "none",
      runtimeVersion: "static",
      buildCommand: null,
      startCommand: null,
      expectedPort: 8080,
      healthCheckPath: "/index.html",
      requiresDatabase: false,
      databaseType: null,
      requiresPersistentStorage: false,
      staticOutput: true,
      dockerfileRequired: true,
      hasDockerfile: repositoryDockerfile,
      selectedTemplate: custom ? "custom-dockerfile" : "static-web",
      confidence: "high",
      detectionStatus: "detected",
      warnings: [],
      errors: [],
      rawProfile,
    };
    return { id: "frontend", role: "frontend", root, buildContext: root, framework: "static-web", frameworkVariant: "static-web", runtimeType: "static", port: 8080, healthCheckPath: "/index.html", databaseType: null, profile };
  }

  private frontendBackendRelationship(repositoryRoot: string, frontendRoot: string, backend: DetectedApplicationComponent): {
    value: DetectedApplicationTopology["relationships"][number] | null;
    blocker: string | null;
  } {
    const source = this.readFrontendSource(join(repositoryRoot, frontendRoot));
    const external = [...source.matchAll(/https?:\/\/[^\s"'`)]+/gi)].map((match) => match[0]);
    const unsupported = external.find((url) => /(?:railway\.app|onrender\.com|vercel\.app|herokuapp\.com)/i.test(url));
    if (unsupported) {
      return { value: null, blocker: `Frontend component '${frontendRoot}' contains a hard-coded external backend URL (${unsupported}). Replace it with a relative API path or a supported public build-time API URL variable before deploying.` };
    }
    const variable = source.match(/\b(?:VITE_|NEXT_PUBLIC_|REACT_APP_)[A-Z0-9_]*(?:API|BACKEND|SERVER)(?:_BASE)?_(?:URL|URI|ORIGIN|ENDPOINT|HOST)[A-Z0-9_]*\b/)?.[0] || null;
    const publicPaths = this.frontendRequestPaths(source).filter((path) => path === "/api" || path.startsWith("/api/"));
    const backendPaths = this.backendRoutePaths(join(repositoryRoot, backend.root));
    const preservedMatches = publicPaths.filter((path) => backendPaths.includes(path));
    const preservedPath = preservedMatches.find((path) => /health|ready|status/i.test(path))
      || preservedMatches[0]
      || backendPaths.find((path) => (path === "/api" || path.startsWith("/api/")) && /health|ready|status/i.test(path))
      || backendPaths.find((path) => path === "/api" || path.startsWith("/api/"))
      || null;
    const strippedMatches = publicPaths.filter((path) => backendPaths.includes(path.slice("/api".length) || "/"));
    const strippedPath = strippedMatches.find((path) => /health|ready|status/i.test(path)) || strippedMatches[0] || null;
    const mode = variable ? "build-time-url" as const : "same-origin" as const;
    if (preservedPath) {
      return { value: { from: "frontend", to: "backend", kind: "http", mode, pathPrefix: "/api", stripPathPrefix: false, buildTimeVariable: variable, verificationPath: preservedPath }, blocker: null };
    }
    if (strippedPath) {
      return { value: { from: "frontend", to: "backend", kind: "http", mode, pathPrefix: "/api", stripPathPrefix: true, buildTimeVariable: variable, verificationPath: strippedPath }, blocker: null };
    }
    if (variable && backendPaths.includes(backend.healthCheckPath)) {
      return { value: { from: "frontend", to: "backend", kind: "http", mode, pathPrefix: "/api", stripPathPrefix: true, buildTimeVariable: variable, verificationPath: `/api${backend.healthCheckPath === "/" ? "" : backend.healthCheckPath}` }, blocker: null };
    }
    const relativeApi = publicPaths.length > 0;
    if (relativeApi) {
      return { value: null, blocker: `Frontend component '${frontendRoot}' uses /api routes, but repository evidence does not prove whether backend component '${backend.root}' owns or strips that prefix.` };
    }
    return { value: null, blocker: `Frontend component '${frontendRoot}' and backend were detected, but their API relationship could not be proven. Use relative /api requests or a supported public build-time API URL variable.` };
  }

  private frontendRequestPaths(source: string) {
    const paths = [...source.matchAll(/(?:fetch|axios(?:\.(?:get|post|put|patch|delete))?)\s*\(\s*[`"'](\/[A-Za-z0-9_./:-]*)/gi)]
      .map((match) => match[1].replace(/\/$/, "") || "/");
    return [...new Set(paths)];
  }

  private backendRoutePaths(root: string) {
    const source = this.readFrontendSource(root);
    const paths: string[] = [];
    const patterns = [
      /\b(?:app|router|server)\s*\.\s*(?:use|get|post|put|patch|delete|all)\s*\(\s*[`"'](\/[A-Za-z0-9_./:-]*)/gi,
      /@(?:app|router)\.(?:get|post|put|patch|delete|route)\s*\(\s*[`"'](\/[A-Za-z0-9_./:-]*)/gi,
      /\b(?:path|re_path)\s*\(\s*[`"'](\/?[A-Za-z0-9_./:-]+)/gi,
      /\b(?:APIRouter|FastAPI)\s*\([^)]*\bprefix\s*=\s*[`"'](\/[A-Za-z0-9_./:-]*)/gi,
      /@Controller\s*\(\s*[`"'](\/?[A-Za-z0-9_./:-]*)/gi,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) paths.push(match[1].startsWith("/") ? match[1] : `/${match[1]}`);
    }
    return [...new Set(paths.map((path) => path.replace(/\/$/, "") || "/"))];
  }

  private readFrontendSource(root: string) {
    const chunks: string[] = [];
    const visit = (directory: string, depth: number) => {
      if (depth > 5 || chunks.join("").length > 2_000_000) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) visit(join(directory, entry.name), depth + 1);
        } else if (/\.(?:html|js|jsx|ts|tsx|vue|svelte)$/i.test(entry.name)) {
          chunks.push(readFileSync(join(directory, entry.name), "utf8").slice(0, 200_000));
        }
      }
    };
    visit(root, 0);
    return chunks.join("\n");
  }

  private applyDetectorResult(profile: DeploymentProfileDraft, detected: FrameworkDetectorResult, appPath: string, repositoryRoot: string) {
    const plan = detected.partialBuildPlan;
    profile.ecosystem = detected.language === "javascript" ? "node" : "python";
    profile.language = detected.language;
    profile.framework = detected.framework;
    profile.frameworkVariant = detected.frameworkMode;
    profile.packageManager = plan.packageManager;
    profile.runtimeVersion = plan.runtimeVersion;
    profile.buildCommand = plan.buildCommand;
    profile.startCommand = plan.runCommand;
    profile.expectedPort = plan.port || null;
    profile.healthCheckPath = detected.framework === "streamlit" ? "/_stcore/health" : "/";
    profile.staticOutput = plan.runtimeType === "static";
    profile.confidence = detected.confidence >= 0.9 ? "high" : detected.confidence >= 0.75 ? "medium" : "low";
    profile.warnings.push(...detected.warnings);
    profile.errors.push(...detected.unsupportedReasons);
    Object.assign(profile.rawProfile, {
      detectorId: detected.detectorId,
      detectorConfidence: detected.confidence,
      detectorEvidence: detected.evidence,
      detectorRequiredInputs: detected.requiredUserInputs,
      unsupportedAdapterReasons: detected.unsupportedReasons,
      runtimeFiles: plan.runtimeFiles,
      resolvedBaseImage: plan.baseImage,
      resolvedRuntimeImage: plan.runtimeImage,
      releaseCommand: plan.releaseCommand,
      outputDirectory: plan.outputDirectory,
      buildSystemDependencies: plan.buildSystemDependencies,
      runtimeSystemDependencies: plan.runtimeSystemDependencies,
      bindHost: plan.bindHost,
      bindsToPortEnv: plan.bindsToPortEnv,
      detectorDockerTemplate: plan.dockerTemplate,
      repositoryInstallRoot: this.repositoryInstallRoot(repositoryRoot, appPath, detected.language),
    });
    if (detected.framework === "django") profile.rawProfile.djangoSettingsModule = this.detectDjangoSettingsModule(appPath);
    return profile;
  }

  private repositoryInstallRoot(repositoryRoot: string, appPath: string, language: "javascript" | "python") {
    const appRoot = relative(repositoryRoot, appPath).replace(/\\/g, "/") || ".";
    if (appRoot === ".") return ".";
    if (language === "javascript") {
      const rootPackage = this.readJsonFile(join(repositoryRoot, "package.json"));
      const hasWorkspaceLock = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"].some((name) => existsSync(join(repositoryRoot, name)));
      if (rootPackage?.workspaces && hasWorkspaceLock) return ".";
    }
    if (language === "python" && ["pyproject.toml", "uv.lock", "poetry.lock", "Pipfile.lock"].some((name) => existsSync(join(repositoryRoot, name)))) return ".";
    return appRoot;
  }

  private applyOverrides(profile: DeploymentProfileDraft, overrides: ProjectDeploymentOverrides, appPath: string, errors: string[]) {
    const detectedRuntimeType = profile.staticOutput ? "static" : "server";
    if (overrides.runtimeType && overrides.runtimeType !== detectedRuntimeType) {
      errors.push(`The runtimeType override '${overrides.runtimeType}' conflicts with detected '${detectedRuntimeType}' repository evidence.`);
    }
    if (overrides.startCommand && detectedRuntimeType === "static") {
      errors.push("A startCommand override conflicts with the detected static application runtime.");
    }
    if (overrides.outputDirectory && detectedRuntimeType === "server") {
      errors.push("An outputDirectory override conflicts with the detected server application runtime.");
    }
    if (overrides.installCommand && profile.packageManager && !this.commandUsesPackageManager(overrides.installCommand, profile.packageManager)) {
      errors.push(`The installCommand override conflicts with the detected ${profile.packageManager} package manager.`);
    }
    if (overrides.installCommand) profile.rawProfile.installCommand = overrides.installCommand.trim();
    if (overrides.buildCommand) profile.buildCommand = overrides.buildCommand.trim();
    if (overrides.startCommand) profile.startCommand = overrides.startCommand.trim();
    if (overrides.outputDirectory) profile.rawProfile.outputDirectory = overrides.outputDirectory.trim();
    if (overrides.port) profile.expectedPort = overrides.port;
    if (overrides.healthCheckPath) profile.healthCheckPath = overrides.healthCheckPath;
    if (overrides.runtimeType) profile.staticOutput = overrides.runtimeType === "static";
    if (overrides.dockerfileMode === "custom") {
      profile.hasDockerfile = existsSync(join(appPath, "Dockerfile"));
      if (!profile.hasDockerfile) errors.push("Dockerfile mode is custom, but no Dockerfile exists in the selected application directory.");
    }
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
          if (depth < 5 && !IGNORED_DIRECTORIES.has(entry.name)) {
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
    if (candidate.files.has("manage.py")) score += 50;
    if (candidate.files.has("package.json")) {
      const packageJson = this.readJsonFile(join(candidate.directory, "package.json"));
      const dependencies = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
      if (["react", "vite", "next", "express", "@nestjs/core", "fastify"].some((name) => dependencies[name])) score += 40;
      if (packageJson?.scripts?.build || packageJson?.scripts?.start || packageJson?.scripts?.["start:prod"]) score += 10;
      if (packageJson?.workspaces) score -= 30;
    }
    const pythonManifest = ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg"]
      .map((name) => this.readOptionalFile(candidate.directory, name) || "").join("\n").toLowerCase();
    if (/django|flask|fastapi|streamlit/.test(pythonManifest)) score += 40;
    if (["server.js", "app.js", "index.js", "main.py", "app.py"].some((name) => candidate.files.has(name))) score += 20;
    if (["frontend", "backend", "client", "server", "api", "web", "app"].includes(basename(candidate.relativeDirectory))) score += 5;
    if (["example", "examples", "sample", "samples", "test", "tests", "docs"].includes(basename(candidate.relativeDirectory))) score -= 35;
    return score;
  }

  private detectPython(path: string, files: Set<string>, profile: DeploymentProfileDraft) {
    const dependencyText = ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg"]
      .map((name) => this.readOptionalFile(path, name)).filter(Boolean).join("\n").toLowerCase();
    profile.ecosystem = "python";
    profile.language = "python";
    const pyproject = this.readOptionalFile(path, "pyproject.toml") || "";
    profile.packageManager = files.has("Pipfile") ? "pipenv" : files.has("pyproject.toml") && /\[tool\.poetry\]/.test(pyproject) ? "poetry" : "pip";
    const pyprojectVersion = pyproject.match(/requires-python\s*=\s*["']([^"']+)["']/i)?.[1] || null;
    const requiredPythonVersion = this.readOptionalFile(path, "runtime.txt")?.trim() || this.readOptionalFile(path, ".python-version")?.trim() || pyprojectVersion;
    profile.runtimeVersion = requiredPythonVersion || "python-3.11";
    profile.rawProfile.requiredPythonVersion = requiredPythonVersion;
    profile.healthCheckPath = "/";
    profile.rawProfile.healthCheckDetected = false;
    profile.warnings.push(
      "Verify that the Python application exposes /health before an AWS launch test."
    );
    this.detectPythonPersistentStorage(path, files, profile, dependencyText);
    const pythonSource = ["app.py", "main.py", "wsgi.py", "asgi.py", join("app", "main.py")].map((name) => this.readOptionalFile(path, name)).filter(Boolean).join("\n");
    const pythonFrameworks = [
      dependencyText.includes("django") ? "Django" : null,
      dependencyText.includes("fastapi") || /FastAPI\s*\(/.test(pythonSource) ? "FastAPI" : null,
      dependencyText.includes("flask") || /Flask\s*\(/.test(pythonSource) ? "Flask" : null,
      dependencyText.includes("streamlit") ? "Streamlit" : null,
    ].filter((value): value is string => Boolean(value));
    if (pythonFrameworks.length > 1) {
      profile.errors.push(`Conflicting Python framework evidence was found: ${pythonFrameworks.join(", ")}.`);
    }
    if (files.has("manage.py") || dependencyText.includes("django")) {
      profile.framework = "django";
      profile.frameworkVariant = "django-wsgi";
      profile.expectedPort = 8000;
      const wsgiModule = this.detectDjangoWsgiModule(path);
      profile.startCommand = wsgiModule ? `gunicorn ${wsgiModule}:application --bind 0.0.0.0:\${PORT:-8000}` : null;
      const settingsModule = this.detectDjangoSettingsModule(path);
      profile.rawProfile.djangoSettingsModule = settingsModule;
      const settings = settingsModule ? this.readOptionalFile(path, settingsModule.replace(/\./g, "/") + ".py") || "" : "";
      profile.requiresDatabase = /DATABASES/.test(settings) && /(postgres|psycopg2|dj_database_url)/i.test(settings);
      profile.databaseType = profile.requiresDatabase ? "postgres" : null;
    } else if (dependencyText.includes("fastapi") || /FastAPI\s*\(/.test(pythonSource)) {
      profile.framework = "fastapi";
      profile.frameworkVariant = "fastapi-asgi";
      profile.expectedPort = 8000;
      const fastApiModule = existsSync(join(path, "app", "main.py")) ? "app.main" : existsSync(join(path, "main.py")) ? "main" : null;
      const fastApiSource = fastApiModule ? this.readOptionalFile(path, fastApiModule.replace(/\./g, "/") + ".py") || "" : "";
      const fastApiFactory = /def\s+create_app\s*\(/.test(fastApiSource);
      profile.rawProfile.applicationFactory = fastApiFactory ? `${fastApiModule}:create_app` : null;
      profile.startCommand = fastApiModule ? `uvicorn ${fastApiModule}:${fastApiFactory ? "create_app --factory" : "app"} --host 0.0.0.0 --port \${PORT:-8000}` : null;
    } else if (dependencyText.includes("flask") || /Flask\s*\(/.test(pythonSource)) {
      profile.framework = "flask";
      profile.frameworkVariant = "flask-wsgi";
      profile.expectedPort = 5000;
      const flaskTarget = this.detectFlaskTarget(path, files);
      profile.rawProfile.applicationFactory = flaskTarget?.factory ? `${flaskTarget.module}:create_app` : null;
      profile.startCommand = flaskTarget
        ? `gunicorn '${flaskTarget.module}:${flaskTarget.factory ? "create_app()" : "app"}' --bind 0.0.0.0:\${PORT:-5000}`
        : null;
    } else if (dependencyText.includes("streamlit") && (files.has("app.py") || files.has("main.py"))) {
      profile.framework = "streamlit";
      profile.frameworkVariant = "streamlit-server";
      profile.expectedPort = 8000;
      profile.healthCheckPath = "/_stcore/health";
      profile.rawProfile.healthCheckDetected = true;
      profile.startCommand = `streamlit run ${files.has("app.py") ? "app.py" : "main.py"} --server.address 0.0.0.0 --server.port \${PORT:-8000}`;
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

  private hasPythonManifest(files: Set<string>) { return ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg"].some((file) => files.has(file)); }
  private readJson(path: string, profile: DeploymentProfileDraft) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { profile.errors.push("package.json could not be parsed."); return null; } }
  private readJsonFile(path: string) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
  private readOptionalText(path: string, names: string[]) { const name = names.find((candidate) => existsSync(join(path, candidate))); return name ? this.readOptionalFile(path, name) : null; }
  private readOptionalFile(path: string, name: string) { const file = join(path, name); return existsSync(file) ? readFileSync(file, "utf8") : null; }
  private detectDjangoProjectName(path: string) { const module = this.detectDjangoWsgiModule(path); return module?.split(".")[0] || "app"; }
  private detectDjangoWsgiModule(path: string) { return this.findPythonModule(path, "wsgi.py"); }
  private detectDjangoSettingsModule(path: string) {
    const found: string[] = [];
    const visit = (directory: string, depth: number) => {
      if (depth > 4) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) visit(join(directory, entry.name), depth + 1);
        } else if (entry.name === "settings.py" || (basename(directory) === "settings" && entry.name.endsWith(".py") && entry.name !== "__init__.py")) {
          found.push(relative(path, join(directory, entry.name)).replace(/\\/g, "/").replace(/\.py$/, "").replace(/\//g, "."));
        }
      }
    };
    visit(path, 0);
    return found.sort((left, right) => Number(/\.production$/.test(right)) - Number(/\.production$/.test(left)) || left.localeCompare(right))[0] || null;
  }
  private detectFlaskTarget(path: string, files: Set<string>) {
    const candidates = [
      files.has("wsgi.py") ? { module: "wsgi", file: "wsgi.py" } : null,
      files.has("app.py") ? { module: "app", file: "app.py" } : null,
      existsSync(join(path, "app", "__init__.py")) ? { module: "app", file: join("app", "__init__.py") } : null,
    ].filter((value): value is { module: string; file: string } => Boolean(value));
    const selected = candidates.find((candidate) => /def\s+create_app\s*\(/.test(this.readOptionalFile(path, candidate.file) || "")) || candidates[0];
    return selected ? { module: selected.module, factory: /def\s+create_app\s*\(/.test(this.readOptionalFile(path, selected.file) || "") } : null;
  }
  private findPythonModule(path: string, filename: string) {
    const found: string[] = [];
    const visit = (directory: string, depth: number) => {
      if (depth > 4) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) visit(join(directory, entry.name), depth + 1);
        } else if (entry.name === filename) {
          found.push(relative(path, join(directory, entry.name)).replace(/\\/g, "/").replace(/\.py$/, "").replace(/\//g, "."));
        }
      }
    };
    visit(path, 0);
    return found.sort()[0] || null;
  }
  private commandUsesPackageManager(command: string, packageManager: string) { return new RegExp(`^\\s*${packageManager.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(command); }
  private detectNodeDatabase(dependencies: Record<string, unknown>) { const names = Object.keys(dependencies); if (names.some((name) => ["mongoose", "mongodb"].includes(name))) return "mongodb"; if (names.some((name) => ["mysql", "mysql2"].includes(name))) return "mysql"; if (names.some((name) => ["pg", "postgres"].includes(name))) return "postgres"; if (names.some((name) => ["typeorm", "prisma", "sequelize"].includes(name))) return "postgres"; if (names.some((name) => ["redis", "ioredis"].includes(name))) return "redis"; return null; }
  private detectPersistentStorage(path: string, files: Set<string>, profile: DeploymentProfileDraft, dependencies: Record<string, unknown>) { const dirs = ["uploads", "media", "storage"].filter((name) => files.has(name)); if (dirs.length || dependencies.multer || this.hasSqliteUsage(path, files)) { profile.requiresPersistentStorage = true; profile.rawProfile.persistentStorageReason = dirs[0] || (dependencies.multer ? "multer dependency detected." : "sqlite file usage detected."); } }
  private detectPythonPersistentStorage(_path: string, files: Set<string>, profile: DeploymentProfileDraft, dependencies: string) { const dirs = ["uploads", "media", "storage"].filter((name) => files.has(name)); if (dirs.length || /sqlite|upload/.test(dependencies)) { profile.requiresPersistentStorage = true; profile.rawProfile.persistentStorageReason = dirs[0] || "sqlite/upload usage detected."; } }
  private hasSqliteUsage(path: string, files: Set<string>) { if (Array.from(files).some((file) => /\.(sqlite|sqlite3|db)$/.test(file))) return true; return ["package.json", "server.js", "app.js", "index.js"].some((file) => /sqlite/i.test(this.readOptionalFile(path, file) || "")); }
}
