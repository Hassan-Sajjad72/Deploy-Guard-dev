import { Injectable, Logger } from "@nestjs/common";
import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { TemplateMatchingService } from "./template-matching.service";
import { RepoDeployabilityScannerService } from "./repo-deployability-scanner.service";
import { ProjectDeploymentOverrides } from "../project.entity";
import { FrameworkDetectorResult } from "./framework-detector";
import { MainstreamDetectorResolverService } from "./mainstream-detector-resolver.service";
import { DeployGuardBuildProvider } from "./build-provider.service";
import { ApplicationUnitDiscoveryService } from "./application-unit-discovery.service";
import { RelationshipInferenceService } from "./relationship-inference.service";
import type { RepositoryEvidence } from "./repository-evidence.types";
import { TOPOLOGY_ANALYZER_VERSION, TOPOLOGY_SCHEMA_VERSION, type CanonicalTopology, type TopologyComponent, type TopologyEnvironmentVariable } from "./topology.types";
import { PLATFORM_BACKEND_MOUNT } from "../service-binding";

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

export type DetectedApplicationComponent = TopologyComponent;
export type DetectedApplicationTopology = CanonicalTopology;

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
  private readonly unitDiscovery = new ApplicationUnitDiscoveryService();
  private readonly relationshipInference = new RelationshipInferenceService();
  private readonly buildProvider: DeployGuardBuildProvider;

  constructor(
    private readonly templateMatchingService: TemplateMatchingService,
    private readonly deployabilityScanner: RepoDeployabilityScannerService,
    private readonly detectorResolver: MainstreamDetectorResolverService = new MainstreamDetectorResolverService(),
  ) { this.buildProvider = new DeployGuardBuildProvider(this.detectorResolver); }

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
        const detection = this.buildProvider.resolve(appPath, appFiles);
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
      errors.push("No known stack manifests were found within scan depth 5.");
    }

    this.applyOverrides(profile, overrides, appPath, errors);
    // A repository Dockerfile is evidence, not the containerization decision.
    // Only the explicit custom override authorizes custom-Dockerfile analysis.
    const customDockerfileSelected = overrides.dockerfileMode === "custom";
    const deployability = this.deployabilityScanner.scan(appPath, { ...profile, hasDockerfile: customDockerfileSelected && profile.hasDockerfile });
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
    if (customDockerfileSelected && typeof deployability.dockerfileRuntimeCommand === "string") profile.startCommand = deployability.dockerfileRuntimeCommand;
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
      if (!errors.includes(template.unsupportedReason)) errors.push(template.unsupportedReason);
    } else if (profile.selectedTemplate === "custom-dockerfile-required") {
      errors.push("No safe automatic template was found.");
    }
    profile.confidence = profile.framework && profile.framework !== "unknown"
      ? "high"
      : profile.ecosystem !== "unknown" ? "medium" : "low";

    if (includeTopology && repositoryEntries.length > 0) {
      const topology = this.detectTopology(workspacePath, commitSha, candidates, overrides);
      if (topology.status === "supported" && topology.components.length === 1) {
        const canonical = topology.components[0].profile;
        const repositoryDiagnostics = profile.rawProfile;
        profile = {
          ...canonical,
          warnings: [...new Set([...canonical.warnings, ...profile.warnings])],
          errors: [...new Set(canonical.errors)],
          rawProfile: { ...repositoryDiagnostics, ...canonical.rawProfile },
        };
      }
      profile.rawProfile.componentTopology = topology;
      profile.rawProfile.components = topology.components.map(({ profile: _profile, ...component }) => component);
      profile.rawProfile.topologyStatus = topology.status;
      profile.rawProfile.topologyShape = topology.shape;
      profile.rawProfile.topologyAnalysisState = topology.analysisState;
      profile.rawProfile.topologyBlockers = topology.blockers;
      if (topology.components.length > 1) {
        const ambiguousIndex = profile.errors.indexOf(ambiguousRootMessage);
        if (ambiguousIndex >= 0) profile.errors.splice(ambiguousIndex, 1);
        profile.rawProfile.appRootConfidence = topology.status === "supported" ? "high" : "low";
        profile.rawProfile.appRootReason = "A bounded application component topology was analyzed instead of selecting one root.";
      }
      for (const blocker of topology.blockers) if (!profile.errors.includes(blocker)) profile.errors.push(blocker);
      if (topology.status === "blocked") {
        profile.errors = [...topology.blockers];
        profile.detectionStatus = "manual_input_required";
      }
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
    const candidateEvidence = manifestCandidates.map((candidate) => {
      const root = relative(repositoryRoot, candidate.directory).replace(/\\/g, "/") || ".";
      const exhaustive = this.buildProvider.resolveAll(candidate.directory, candidate.files);
      return {
        root,
        absoluteRoot: candidate.directory,
        files: candidate.files,
        manifests: Array.from(candidate.files).filter((name) => MANIFEST_NAMES.has(name)),
        matches: exhaustive.matches.map((item) => item.result),
      };
    });
    const units = this.unitDiscovery.discover(repositoryRoot, candidateEvidence);
    const components: DetectedApplicationComponent[] = [];
    const relationships: DetectedApplicationTopology["relationships"] = [];
    const serviceBindings: DetectedApplicationTopology["serviceBindings"] = [];
    const requiredUserInputs: string[] = [];
    const artifacts: DetectedApplicationTopology["artifacts"] = [];
    const evidence: RepositoryEvidence[] = units.flatMap((unit) => unit.evidence);
    const unresolvedEvidence: RepositoryEvidence[] = [];
    const blockers: string[] = [];
    const warnings: string[] = [];
    let shape: DetectedApplicationTopology["shape"] | null = null;
    // A server-rendered web service is the public frontend when the same
    // repository also contains a distinct backend service.  A lone SSR
    // service remains an application/runtime owner.  This is role assignment
    // from the already-detected service inventory, not framework inference.
    const hasSeparateBackendService = units.some((unit) => unit.deployable
      && unit.matches.some((match) => this.backendFramework(match.framework) && !match.unsupportedReasons.length));

    for (const unit of units.filter((item) => item.deployable)) {
      const unsupportedRuntime = unit.matches.find((match) => match.confidence >= 0.9 && match.unsupportedReasons.length > 0);
      if (unsupportedRuntime) {
        blockers.push(...unsupportedRuntime.unsupportedReasons);
        shape = "UNSUPPORTED";
        continue;
      }
      const frontendMatches = unit.matches.filter((match) => match.partialBuildPlan.runtimeType === "static" && !match.unsupportedReasons.length);
      const backendMatches = unit.matches.filter((match) => this.backendFramework(match.framework) && !match.unsupportedReasons.length);
      const ssrMatches = unit.matches.filter((match) => match.partialBuildPlan.runtimeType === "server" && !this.backendFramework(match.framework) && !match.unsupportedReasons.length);
      if (backendMatches.length > 1) {
        blockers.push(`Application unit '${unit.root}' has multiple competing backend runtimes: ${backendMatches.map((item) => item.framework).join(", ")}.`);
        continue;
      }
      if (ssrMatches.length === 1 && backendMatches.length === 1) {
        const source = this.readFrontendSource(unit.absoluteRoot);
        const customServerProven = /\bnext\s*\(\s*\{|\b(?:getRequestHandler|handle)\s*\(/.test(source)
          && /\.(?:listen)\s*\(/.test(source);
        if (!customServerProven) {
          blockers.push(`Application unit '${unit.root}' contains both an SSR runtime and a backend runtime, but custom-server ownership is not proven.`);
          unresolvedEvidence.push(...unit.evidence.filter((item) => item.kind === "framework"));
          continue;
        }
        const backend = backendMatches[0];
        const profile = this.profileForDetector(repositoryRoot, unit.absoluteRoot, unit.files, commitSha, overrides, backend);
        profile.buildCommand = ssrMatches[0].partialBuildPlan.buildCommand;
        profile.rawProfile.runtimeFiles = ssrMatches[0].partialBuildPlan.runtimeFiles;
        const component = this.topologyComponent("application", unit.root, profile, ["custom-server", "ssr-runtime"], unit.evidence);
        components.push(component);
        relationships.push({
          kind: "SHARES_ROOT",
          from: `capability:${unit.id}:custom-server`,
          to: `capability:${unit.id}:ssr-runtime`,
          evidence: unit.evidence.filter((item) => item.kind === "framework" || item.kind === "entrypoint"),
        });
        shape = "CUSTOM_SERVER_SSR";
        continue;
      }
      if (frontendMatches.length && backendMatches.length === 1) {
        const frontend = frontendMatches[0];
        const backend = backendMatches[0];
        const serving = this.relationshipInference.inferStaticServing(unit.absoluteRoot, unit.root);
        evidence.push(...serving.evidence);
        const output = frontend.partialBuildPlan.outputDirectory;
        if (serving.status === "proven" && output && serving.path === output.replace(/^\.\//, "")) {
          const profile = this.profileForDetector(repositoryRoot, unit.absoluteRoot, unit.files, commitSha, overrides, backend);
          profile.buildCommand = frontend.partialBuildPlan.buildCommand;
          profile.rawProfile.outputDirectory = output;
          profile.rawProfile.runtimeFiles = [...new Set([...(profile.rawProfile.runtimeFiles as string[] || []), output])];
          const component = this.topologyComponent("backend", unit.root, profile, ["backend-runtime", "frontend-build", "serves-static"], unit.evidence);
          components.push(component);
          relationships.push({
            kind: "SHARES_ROOT",
            from: `capability:${unit.id}:frontend-build`,
            to: `capability:${unit.id}:backend-runtime`,
            evidence: unit.evidence.filter((item) => item.kind === "framework" || item.kind === "manifest"),
          });
          const artifactId = `artifact:${unit.root}:${output}`;
          artifacts.push({ id: artifactId, root: unit.root, path: output, kind: "static-output", producedBy: component.id });
          relationships.push({ kind: "BUILDS_INTO", from: component.id, to: artifactId, evidence: unit.evidence.filter((item) => item.kind === "static-output") });
          relationships.push({ kind: "SERVES", from: component.id, to: artifactId, evidence: serving.evidence });
          shape = backend.language === "python" ? "PYTHON_SERVES_FRONTEND" : "MONOLITH_SERVES_FRONTEND";
        } else {
          const reason = serving.status === "unresolved"
            ? "the static-serving path is dynamic or resolves to multiple artifacts"
            : "no production static-serving relationship matches the frontend build artifact";
          blockers.push(`Application unit '${unit.root}' contains frontend-build and backend-runtime capabilities, but ${reason}.`);
          unresolvedEvidence.push(...unit.evidence.filter((item) => item.kind === "framework" || item.kind === "static-output"));
        }
        continue;
      }
      if (ssrMatches.length > 1) {
        blockers.push(`Application unit '${unit.root}' has multiple competing SSR runtimes: ${ssrMatches.map((item) => item.framework).join(", ")}.`);
        continue;
      }
      const selected = backendMatches[0] || ssrMatches[0] || frontendMatches[0];
      if (!selected) continue;
      const profile = this.profileForDetector(repositoryRoot, unit.absoluteRoot, unit.files, commitSha, overrides, selected);
      const role = backendMatches[0]
        ? "backend"
        : frontendMatches[0] ? "frontend"
          : hasSeparateBackendService ? "frontend" : "application";
      components.push(this.topologyComponent(role, unit.root, profile, [selected.partialBuildPlan.runtimeType === "static" ? "frontend-build" : "http-runtime"], unit.evidence));
      if (frontendMatches[0]?.partialBuildPlan.outputDirectory) {
        const output = frontendMatches[0].partialBuildPlan.outputDirectory!;
        const artifactId = `artifact:${unit.root}:${output}`;
        artifacts.push({ id: artifactId, root: unit.root, path: output, kind: "static-output", producedBy: role });
        relationships.push({ kind: "BUILDS_INTO", from: role, to: artifactId, evidence: unit.evidence.filter((item) => item.kind === "static-output") });
      }
      if (ssrMatches[0]) shape = "SSR_APPLICATION";
    }
    for (const root of this.findStaticWebRoots(repositoryRoot)) {
      if (components.some((component) => component.root === root)) continue;
      components.push(this.staticWebComponent(repositoryRoot, root, commitSha, overrides));
    }

    const frontends = components.filter((component) => component.role === "frontend");
    const backends = components.filter((component) => component.role === "backend");
    if (frontends.length > 1) blockers.push("The bounded full-stack contract supports exactly one frontend component; multiple frontends were detected.");
    // This is a developer-selectable service identity, not an application
    // routing defect. Preserve the candidates and require an explicit choice
    // before compiling a dispatchable two-service BuildPlan.
    if (backends.length > 1) requiredUserInputs.push("Choose which of these backend service roots should be deployed.");
    if (components.length === 0) blockers.push("No supported deployable application component was detected.");
    if (frontends.length === 1 && backends.length === 1 && frontends[0].profile.selectedTemplate === "custom-dockerfile") {
      blockers.push("A full-stack custom frontend Dockerfile cannot be selected until it proves the declared DeployGuard-managed frontend/backend proxy contract. Use DeployGuard-generated frontend containerization or provide a supported single-component custom deployment.");
    }

    if (frontends.length === 1 && backends.length === 1) {
      const relationship = this.frontendBackendRelationship(repositoryRoot, frontends[0], backends[0]);
      // Route discovery is optional evidence.  A runnable frontend and backend
      // are not unsafe merely because static analysis cannot reconstruct an
      // application's URL/rewrite semantics.
      if (relationship.value?.kind === "CALLS") {
        relationships.push(relationship.value);
      }
      const bindings = this.serviceBindings(frontends[0], backends[0]);
      serviceBindings.push(...bindings.values);
      requiredUserInputs.push(...bindings.requiredUserInputs);
    }
    if (!shape) {
      if (frontends.length === 1 && backends.length === 1) shape = units.length > 2 ? "BOUNDED_MONOREPO" : "DECOUPLED_FRONTEND_BACKEND";
      // A single frontend component may be either a static site or a complete
      // server-rendered application.  The latter is the runtime owner for its
      // managed database; treating every frontend as static loses that proven
      // ownership and incorrectly turns a supported SSR application into an
      // ambiguous database topology.
      else if (frontends.length === 1 && components.length === 1) shape = frontends[0].runtimeType === "static" ? "STATIC_FRONTEND" : "SSR_APPLICATION";
      else if (backends.length === 1 && components.length === 1) shape = "BACKEND_API";
      else if (components.length === 1 && components[0].role === "application") shape = "SSR_APPLICATION";
    }
    // Database ownership is a component fact established by repository
    // evidence.  Roles are presentation/topology labels and must not choose a
    // different consumer downstream.
    const databaseOwners = components.filter((component) => Boolean(component.databaseType));
    if (databaseOwners.length > 1) blockers.push("Multiple components require managed databases; choose a bounded database owner before deployment.");
    const runtimeOwner = databaseOwners.length === 1 ? databaseOwners[0] : null;
    for (const component of components) evidence.push(...component.evidence);
    const managedDatabase = runtimeOwner?.databaseType
      ? { engine: runtimeOwner.databaseType, ownerComponentId: runtimeOwner.id }
      : null;
    if (managedDatabase) relationships.push({ kind: "USES_DATABASE", from: managedDatabase.ownerComponentId, to: `database:${managedDatabase.engine}`, evidence: runtimeOwner?.evidence.filter((item) => item.kind === "database" || item.kind === "dependency") || [] });
    const workspaceRoot = units.find((unit) => unit.root === "." && unit.evidence.some((item) => item.kind === "workspace"));
    if (workspaceRoot) for (const member of units.filter((unit) => unit.root !== ".")) relationships.push({ kind: "WORKSPACE_MEMBER", from: workspaceRoot.id, to: member.id, evidence: workspaceRoot.evidence.filter((item) => item.kind === "workspace") });
    if (!runtimeOwner && components.some((component) => component.profile.requiresDatabase)) blockers.push("DATABASE_RUNTIME_OWNER_MISSING");
    if (components.some((component) => component.profile.rawProfile.databaseRequired === true && !component.databaseType)) blockers.push("DATABASE_ENGINE_AMBIGUOUS");
    if (this.requiredWorkerEvidence(repositoryRoot)) {
      blockers.push("A required worker process is outside the bounded deployment topology.");
      shape = "UNSUPPORTED";
    }
    const requiredTopologyInputs = components.some((component) => Array.isArray(component.profile.rawProfile.detectorRequiredInputs) && component.profile.rawProfile.detectorRequiredInputs.length > 0);
    if (!shape && manifestCandidates.length > 0 && components.length === 0 && blockers.length === 1) shape = "UNSUPPORTED";
    const analysisState = shape === "UNSUPPORTED" ? "UNSUPPORTED" : blockers.length ? "UNRESOLVED" : requiredTopologyInputs || requiredUserInputs.length ? "INPUT_REQUIRED" : "SUPPORTED";
    return {
      schemaVersion: TOPOLOGY_SCHEMA_VERSION,
      analyzerVersion: TOPOLOGY_ANALYZER_VERSION,
      shape: blockers.length && shape !== "UNSUPPORTED" ? "UNRESOLVED" : shape || "UNRESOLVED",
      analysisState,
      status: blockers.length ? "blocked" : "supported",
      confidence: blockers.length ? "unresolved" : relationships.some((item) => item.kind === "SERVES" || item.kind === "CALLS") ? "proven" : "bounded",
      evidence,
      applicationUnits: units.map((unit) => ({ id: unit.id, root: unit.root, manifests: unit.manifests, deployable: unit.deployable, detectorIds: unit.matches.map((item) => item.detectorId) })),
      components: components.sort((left, right) => (left.role === "frontend" ? -1 : 1) - (right.role === "frontend" ? -1 : 1)),
      managedDatabase,
      databases: managedDatabase ? [{ id: `database:${managedDatabase.engine}`, engine: managedDatabase.engine, ownerComponentId: managedDatabase.ownerComponentId }] : [],
      relationships,
      serviceBindings,
      requiredUserInputs: [...new Set(requiredUserInputs)].sort(),
      artifacts,
      unresolvedEvidence,
      blockers,
      warnings,
    };
  }

  private componentRole(profile: DeploymentProfileDraft): "frontend" | "backend" | null {
    if (profile.staticOutput) return "frontend";
    if (["express", "nestjs", "fastify", "flask", "fastapi", "django"].includes(profile.framework || "")) return "backend";
    if (["nextjs", "nuxt", "sveltekit", "astro", "remix", "streamlit"].includes(profile.framework || "")) return "frontend";
    return null;
  }

  private profileForDetector(
    repositoryRoot: string,
    appPath: string,
    appFiles: Set<string>,
    commitSha: string | null,
    overrides: ProjectDeploymentOverrides,
    detected: FrameworkDetectorResult,
  ) {
    const root = relative(repositoryRoot, appPath).replace(/\\/g, "/") || ".";
    const hasDockerfile = appFiles.has("Dockerfile");
    const warnings: string[] = [];
    const errors: string[] = [];
    const profile = this.applyDetectorResult(this.baseProfile(commitSha, hasDockerfile, warnings, errors, {
      appDirectory: root,
      appRootConfidence: "high",
      repositoryDockerfileDetected: hasDockerfile,
      deploymentOverrides: overrides,
    }), detected, appPath, repositoryRoot);
    const facts = this.buildProvider.extract(appPath, appFiles);
    if (profile.ecosystem === "node") {
      const database = this.detectNodeDatabase(facts.dependencies);
      profile.requiresDatabase = Boolean(database);
      profile.databaseType = database;
      this.detectPersistentStorage(appPath, appFiles, profile, facts.dependencies);
    } else {
      this.detectPythonPersistentStorage(appPath, appFiles, profile, facts.dependencyText.toLowerCase());
    }
    this.applyOverrides(profile, overrides, appPath, errors);
    const deployability = this.deployabilityScanner.scan(appPath, { ...profile, hasDockerfile: overrides.dockerfileMode === "custom" && profile.hasDockerfile });
    Object.assign(profile.rawProfile, deployability);
    if (typeof deployability.detectedPort === "number") profile.expectedPort = deployability.detectedPort;
    if (deployability.detectedHealthPath && !overrides.healthCheckPath) profile.healthCheckPath = deployability.detectedHealthPath;
    if (overrides.dockerfileMode === "custom" && typeof deployability.dockerfileRuntimeCommand === "string") profile.startCommand = deployability.dockerfileRuntimeCommand;
    if (deployability.databaseRequired) profile.requiresDatabase = true;
    if (["postgres", "mysql", "mongodb"].includes(String(deployability.databaseEngine || ""))) profile.databaseType = String(deployability.databaseEngine);
    warnings.push(...deployability.deployabilityWarnings);
    errors.push(...deployability.deployabilityBlockers);
    const template = this.templateMatchingService.selectTemplate({ ...profile, dockerfileMode: overrides.dockerfileMode || "generated" });
    profile.selectedTemplate = template.selectedTemplate;
    profile.dockerfileRequired = template.dockerfileRequired;
    profile.detectionStatus = errors.length ? "manual_input_required" : template.detectionStatus;
    profile.rawProfile.templateMatched = template.templateMatched;
    profile.rawProfile.containerizationSource = template.selectedTemplate === "custom-dockerfile" ? "repository" : "deployguard";
    profile.rawProfile.detected = true;
    profile.rawProfile.repositoryDockerfileIgnored = hasDockerfile && template.selectedTemplate !== "custom-dockerfile";
    return profile;
  }

  private topologyComponent(
    role: "frontend" | "backend" | "application",
    root: string,
    profile: DeploymentProfileDraft,
    capabilities: string[],
    evidence: RepositoryEvidence[],
  ): DetectedApplicationComponent {
    const databaseType = (role === "backend" || role === "application" || (role === "frontend" && !profile.staticOutput)) && ["postgres", "mysql", "mongodb"].includes(String(profile.databaseType || ""))
      ? profile.databaseType as "postgres" | "mysql" | "mongodb"
      : null;
    const rawEnvironment = Array.isArray(profile.rawProfile.environmentVariables)
      ? profile.rawProfile.environmentVariables as Array<Record<string, unknown>>
      : [];
    const environment: TopologyEnvironmentVariable[] = rawEnvironment.filter((item) => item.productionRelevant !== false).map((item): TopologyEnvironmentVariable => ({
      name: String(item.key || ""),
      componentId: item.component === "platform" ? "platform" : role,
      owner: item.component === "platform" ? "platform" : item.database === true ? "database" : role === "frontend" ? "frontend" : "backend",
      phase: item.phase === "build" ? "build" : "runtime",
      exposure: item.exposure === "public" ? "public" : "private",
      requirement: item.requirement === "required" || item.requirement === "optional" ? item.requirement : "unknown",
      management: item.ownership === "platform" || item.database === true ? "DeployGuard-managed" : item.ownership === "repository_build" ? "repository-default" : "user-supplied",
      provenance: Array.isArray(item.sources) ? item.sources.map(String) : [],
    })).filter((item) => /^[A-Z][A-Z0-9_]*$/.test(item.name));
    const componentEvidence = [...evidence];
    for (const variable of environment) componentEvidence.push({ kind: "env-reference", file: variable.provenance[0] || root, root, value: variable.name, confidence: "direct", references: variable.provenance });
    if (databaseType) componentEvidence.push({ kind: "database", technology: databaseType, file: root, root, value: databaseType, confidence: "strong" });
    const portSource = String(profile.rawProfile.portSource || "");
    if (profile.expectedPort && ["source", "dockerfile_expose", "override", "platform_generated", "template_default"].includes(portSource)) {
      componentEvidence.push({ kind: "port", file: root, root, value: String(profile.expectedPort), confidence: portSource === "source" ? "direct" : "strong" });
    }
    const explicitHealthPath = profile.staticOutput
      ? "/"
      : typeof profile.rawProfile.detectedHealthPath === "string"
        ? profile.rawProfile.detectedHealthPath
        : typeof (profile.rawProfile.deploymentOverrides as ProjectDeploymentOverrides | undefined)?.healthCheckPath === "string"
          ? (profile.rawProfile.deploymentOverrides as ProjectDeploymentOverrides).healthCheckPath!
          : profile.framework === "streamlit" && profile.healthCheckPath === "/_stcore/health"
            ? "/_stcore/health"
          : null;
    if (explicitHealthPath) componentEvidence.push({ kind: "health-route", file: root, root, value: explicitHealthPath, confidence: profile.staticOutput ? "strong" : "direct" });
    return {
      id: role,
      role,
      root,
      buildContext: root,
      framework: profile.framework || "unknown",
      frameworkVariant: profile.frameworkVariant || profile.selectedTemplate || "unknown",
      runtimeType: profile.staticOutput ? "static" : "server",
      port: profile.expectedPort || (profile.staticOutput ? 8080 : 0),
      healthCheckPath: explicitHealthPath,
      healthCheckMode: explicitHealthPath ? "http" : "tcp",
      databaseType,
      capabilities,
      evidence: componentEvidence,
      environment,
      profile,
    };
  }

  private backendFramework(framework: string) {
    return ["express", "nestjs", "fastify", "flask", "fastapi", "django"].includes(framework);
  }

  private requiredWorkerEvidence(repositoryRoot: string) {
    const visit = (directory: string, depth: number): boolean => {
      if (depth > 5) return false;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (visit(path, depth + 1)) return true;
          continue;
        }
        if (entry.name === "Procfile") {
          const procfile = this.readOptionalFile(directory, entry.name) || "";
          if (/^\s*(?:worker|queue|consumer|scheduler|clock|beat|cron)\s*:/im.test(procfile)) return true;
        }
        if (entry.name === "package.json") {
          const scripts = this.readJsonFile(path)?.scripts;
          if (scripts && typeof scripts === "object" && Object.entries(scripts as Record<string, unknown>).some(([name, command]) =>
            /^(?:worker|queue|consumer|scheduler|cron|beat)(?::[\w-]+)?$/i.test(name) && typeof command === "string" && command.trim(),
          )) return true;
        }
        // A dedicated worker/consumer source that instantiates a queue worker is
        // process evidence even when its package script lives in a workspace.
        if (/\.(?:[cm]?[jt]s|py)$/i.test(entry.name) && /(?:worker|consumer|scheduler|cron|tasks?)\b/i.test(entry.name)) {
          const source = this.readOptionalFile(directory, entry.name) || "";
          if (/\b(?:BullMQ|bullmq|\bbull\b|Celery|celery|Dramatiq|dramatiq|\brq\b|Queue\s*\(|new\s+Worker\s*\()/i.test(source)) return true;
        }
      }
      return false;
    };
    return visit(repositoryRoot, 0);
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
        const assetEvidence = /<(?:script|link)\b[^>]*(?:src|href)=["'][^"']+/i.test(html)
          && (entries.some((entry) => entry.isDirectory() && /^(?:css|js|assets|images?)$/i.test(entry.name)) || /\.(?:css|js)(?:[?"'])/i.test(html));
        if (assetEvidence) found.push(root);
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
    return { id: "frontend", role: "frontend", root, buildContext: root, framework: "static-web", frameworkVariant: "static-web", runtimeType: "static", port: 8080, healthCheckPath: "/index.html", healthCheckMode: "http", databaseType: null, capabilities: ["frontend-build"], evidence: [{ kind: "entrypoint", file: root === "." ? "index.html" : `${root}/index.html`, root, value: "static web entrypoint", confidence: "direct" }], environment: [], profile };
  }

  private frontendBackendRelationship(repositoryRoot: string, frontend: DetectedApplicationComponent, backend: DetectedApplicationComponent): {
    value: DetectedApplicationTopology["relationships"][number] | null;
  } {
    const frontendRoot = frontend.root;
    const source = this.readFrontendSource(join(repositoryRoot, frontendRoot));
    const variable = source.match(/\b(?:VITE_|NEXT_PUBLIC_|REACT_APP_)[A-Z0-9_]*(?:API|BACKEND|SERVER)(?:_BASE)?_(?:URL|URI|ORIGIN|ENDPOINT|HOST)[A-Z0-9_]*\b/)?.[0] || null;
    const publicPaths = this.frontendRequestPaths(source);
    const variableEvidence = (frontend.profile.rawProfile.environmentVariables as Array<Record<string, unknown>> | undefined)
      ?.find((item) => item.key === variable);
    const configuredPrefix = this.developmentApiPathname(variableEvidence?.detectedDefault);
    const backendPaths = this.backendRoutePaths(join(repositoryRoot, backend.root));
    const backendGetPaths = this.backendGetRoutePaths(join(repositoryRoot, backend.root));
    if (configuredPrefix) {
      const joinedPaths = publicPaths.map((path) => path === configuredPrefix || path.startsWith(`${configuredPrefix}/`)
        ? path
        : `${configuredPrefix}${path === "/" ? "" : path}`);
      const preserves = backendPaths.some((path) => path === configuredPrefix || path.startsWith(`${configuredPrefix}/`));
      const strips = publicPaths.some((path) => backendPaths.includes(path));
      if (preserves && strips) {
        return { value: null };
      }
      if (preserves) {
        const verificationPath = joinedPaths.find((path) => path !== configuredPrefix && backendGetPaths.includes(path)) || null;
        return { value: { from: "frontend", to: "backend", kind: "CALLS", evidence: [{ kind: "proxy", file: frontendRoot, root: frontendRoot, value: configuredPrefix, confidence: "direct" }], mode: "same-origin", pathPrefix: configuredPrefix, stripPathPrefix: false, buildTimeVariable: variable, verificationPath } };
      }
      if (strips) {
        const verifiedBackendPath = publicPaths.find((path) => backendGetPaths.includes(path));
        const verificationPath = verifiedBackendPath ? `${configuredPrefix}${verifiedBackendPath === "/" ? "" : verifiedBackendPath}` : null;
        return { value: { from: "frontend", to: "backend", kind: "CALLS", evidence: [{ kind: "proxy", file: frontendRoot, root: frontendRoot, value: configuredPrefix, confidence: "direct" }], mode: "same-origin", pathPrefix: configuredPrefix, stripPathPrefix: true, buildTimeVariable: variable, verificationPath } };
      }
      return { value: null };
    }
    const preservedMatches = publicPaths.flatMap((publicPath) => backendPaths
      .filter((backendPath) => publicPath === backendPath || (backendPath !== "/" && publicPath.startsWith(`${backendPath}/`)))
      .map((backendPath) => ({ publicPath, backendPath })));
    const preserved = preservedMatches.sort((left, right) => right.backendPath.length - left.backendPath.length)[0] || null;
    const preservedPrefix = this.commonPathPrefix(preservedMatches.map((item) => item.publicPath));
    const stripped = publicPaths.flatMap((publicPath) => backendPaths
      .filter((backendPath) => backendPath !== "/" && publicPath.endsWith(backendPath) && publicPath !== backendPath)
      .map((backendPath) => ({ publicPath, backendPath, prefix: publicPath.slice(0, -backendPath.length).replace(/\/$/, "") || "/" })))
      .filter((item) => item.prefix !== "/")
      .sort((left, right) => right.prefix.length - left.prefix.length)[0] || null;
    const mode = variable && publicPaths.length === 0 ? "build-time-url" as const : "same-origin" as const;
    const buildTimeVariable = variable;
    const exactPreserved = preserved?.publicPath === preserved?.backendPath;
    if (preserved && stripped && !exactPreserved) {
      return { value: null };
    }
    if (preserved) {
      const verificationPath = publicPaths.find((path) => backendGetPaths.includes(path)) || null;
      const pathPrefix = preservedPrefix || preserved.backendPath;
      return { value: { from: "frontend", to: "backend", kind: "CALLS", evidence: [{ kind: "proxy", file: frontendRoot, root: frontendRoot, value: pathPrefix, confidence: "direct" }], mode, pathPrefix, stripPathPrefix: false, buildTimeVariable, verificationPath } };
    }
    if (stripped) {
      const verificationPath = backendGetPaths.includes(stripped.backendPath) ? stripped.publicPath : null;
      return { value: { from: "frontend", to: "backend", kind: "CALLS", evidence: [{ kind: "proxy", file: frontendRoot, root: frontendRoot, value: stripped.publicPath, confidence: "direct" }], mode, pathPrefix: stripped.prefix, stripPathPrefix: true, buildTimeVariable, verificationPath } };
    }
    if (publicPaths.length > 0) {
      return { value: null };
    }
    return { value: null };
  }

  /**
   * Bind only an explicitly public development URL that deterministically
   * identifies this repository's backend.  External URLs are intentionally
   * absent from the result and therefore remain untouched.
   */
  private serviceBindings(frontend: DetectedApplicationComponent, backend: DetectedApplicationComponent) {
    const values: DetectedApplicationTopology["serviceBindings"] = [];
    const requiredUserInputs: string[] = [];
    const variables = Array.isArray(frontend.profile.rawProfile.environmentVariables)
      ? frontend.profile.rawProfile.environmentVariables as Array<Record<string, unknown>>
      : [];
    for (const variable of variables) {
      const envAlias = typeof variable.key === "string" ? variable.key : "";
      if (!/^(?:VITE_|NEXT_PUBLIC_|REACT_APP_)[A-Z0-9_]*$/.test(envAlias)
        || !/(?:API|BACKEND|SERVER)(?:_BASE)?_(?:URL|URI|ORIGIN|ENDPOINT|HOST)/.test(envAlias)) continue;
      const value = typeof variable.detectedDefault === "string" ? variable.detectedDefault : null;
      const local = value ? this.localServiceUrl(value) : null;
      if (!local) continue; // no URL evidence, or an explicitly external URL
      if (local.port !== backend.port) {
        if (variable.required === true) requiredUserInputs.push(`Choose the backend service for ${envAlias}.`);
        continue;
      }
      values.push({
        sourceComponent: "frontend",
        envAlias,
        targetComponent: "backend",
        bindingMode: "platform-proxy",
        preservedPathname: local.pathname,
        platformPathPrefix: PLATFORM_BACKEND_MOUNT,
      });
    }
    return { values, requiredUserInputs };
  }

  private localServiceUrl(value: string): { port: number; pathname: string | null } | null {
    try {
      const url = new URL(value);
      if (!/^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/i.test(url.hostname) || !url.port) return null;
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      return { port: Number(url.port), pathname: pathname === "/" ? null : pathname };
    } catch {
      return null;
    }
  }

  private frontendRequestPaths(source: string) {
    const paths = [...source.matchAll(/(?:fetch|[A-Za-z_$][A-Za-z0-9_$]*\.(?:get|post|put|patch|delete))\s*\(\s*[`"'](\/?[A-Za-z0-9][A-Za-z0-9_./:-]*)/gi)]
      .map((match) => `/${match[1].replace(/^\//, "")}`.replace(/\/$/, "") || "/");
    return [...new Set(paths)];
  }

  private commonPathPrefix(paths: string[]) {
    const unique = [...new Set(paths)];
    if (!unique.length) return null;
    const segments = unique.map((path) => path.split("/").filter(Boolean));
    const common: string[] = [];
    for (let index = 0; index < segments[0].length; index += 1) {
      const value = segments[0][index];
      if (!segments.every((parts) => parts[index] === value)) break;
      common.push(value);
    }
    return common.length ? `/${common.join("/")}` : null;
  }

  private developmentApiPathname(value: unknown) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value);
      if (!/^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/i.test(url.hostname)) return null;
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      return pathname === "/" ? null : pathname;
    } catch {
      return null;
    }
  }

  private backendGetRoutePaths(root: string) {
    const source = this.readFrontendSource(root);
    const paths = [
      ...source.matchAll(/\b(?:app|router|server)\s*\.\s*get\s*\(\s*[`"'](\/[A-Za-z0-9_./:-]*)/gi),
      ...source.matchAll(/@(?:app|router)\.get\s*\(\s*[`"'](\/[A-Za-z0-9_./:-]*)/gi),
    ].map((match) => match[1].replace(/\/$/, "") || "/");
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
    paths.push(...this.djangoRoutePaths(root));
    return [...new Set(paths.map((path) => path.replace(/\/$/, "") || "/"))];
  }

  private djangoRoutePaths(root: string) {
    const modules = new Map<string, string>();
    const visit = (directory: string, depth: number) => {
      if (depth > 5) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) visit(absolute, depth + 1);
        } else if (entry.name === "urls.py") {
          const module = relative(root, absolute).replace(/\\/g, "/").replace(/\.py$/, "").replace(/\//g, ".");
          modules.set(module, readFileSync(absolute, "utf8").slice(0, 200_000));
        }
      }
    };
    visit(root, 0);
    if (!modules.size) return [];
    const source = this.readFrontendSource(root);
    const configuredRoot = source.match(/\bROOT_URLCONF\s*=\s*[`"']([A-Za-z0-9_.]+)[`"']/)?.[1] || null;
    const roots = configuredRoot && modules.has(configuredRoot)
      ? [configuredRoot]
      : [...modules.keys()].filter((module) => module.endsWith(".urls"));
    const paths: string[] = [];
    const normalize = (prefix: string, route: string) => {
      const value = `${prefix}/${route}`.replace(/\/+/, "/").replace(/^\/+|\/+$/g, "");
      return value && !/[<>]/.test(value) ? `/${value}` : value === "" ? "/" : null;
    };
    const walk = (module: string, prefix: string, ancestors: Set<string>) => {
      if (ancestors.has(module)) return;
      const text = modules.get(module);
      if (!text) return;
      const nextAncestors = new Set(ancestors).add(module);
      for (const match of text.matchAll(/\b(?:path|re_path)\s*\(\s*[`"']([^`"']*)[`"']\s*,\s*([^\n]+)/g)) {
        const route = match[1];
        const target = match[2].trim();
        const included = target.match(/^include\s*\(\s*[`"']([A-Za-z0-9_.]+)[`"']/)?.[1] || null;
        if (included) {
          const nestedPrefix = normalize(prefix, route);
          if (nestedPrefix) walk(included, nestedPrefix, nextAncestors);
          continue;
        }
        const path = normalize(prefix, route);
        if (path) paths.push(path);
      }
    };
    for (const module of roots) walk(module, "", new Set());
    return [...new Set(paths)];
  }

  private readFrontendSource(root: string) {
    const chunks: string[] = [];
    const visit = (directory: string, depth: number) => {
      if (depth > 5 || chunks.join("").length > 2_000_000) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) visit(join(directory, entry.name), depth + 1);
        } else if (/\.(?:html|js|jsx|mjs|cjs|ts|tsx|vue|svelte|py)$/i.test(entry.name)) {
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
      buildInitialization: plan.buildInitialization,
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
      const candidates = ["Dockerfile", "Dockerfile.prod", "docker/Dockerfile", "docker/backend.Dockerfile"]
        .filter((path) => existsSync(join(appPath, path)));
      profile.hasDockerfile = candidates.length === 1;
      if (candidates.length === 1) profile.rawProfile.dockerfilePath = candidates[0];
      if (candidates.length === 0) errors.push("Dockerfile mode is custom, but no supported Dockerfile path exists in the selected application directory.");
      if (candidates.length > 1) errors.push(`Dockerfile mode is custom, but multiple Dockerfile paths are plausible (${candidates.join(", ")}). Select an unambiguous application directory or retain one authoritative Dockerfile.`);
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
  private detectNodeDatabase(dependencies: Record<string, unknown>) { const names = Object.keys(dependencies); if (names.some((name) => ["mongoose", "mongodb"].includes(name))) return "mongodb"; if (names.some((name) => ["mysql", "mysql2"].includes(name))) return "mysql"; if (names.some((name) => ["pg", "postgres"].includes(name))) return "postgres"; return null; }
  private detectPersistentStorage(path: string, files: Set<string>, profile: DeploymentProfileDraft, dependencies: Record<string, unknown>) {
    const categories = [
      ...["uploads", "media", "storage"].filter((name) => files.has(name)).map(() => "writable-directory"),
      ...(dependencies.multer ? ["upload-library"] : []),
      ...(this.hasSqliteUsage(path, files) ? ["local-database-file"] : []),
    ];
    if (categories.length) {
      profile.rawProfile.filesystemPersistenceDetected = true;
      profile.rawProfile.filesystemPersistenceEvidence = [...new Set(categories)];
    }
  }
  private detectPythonPersistentStorage(_path: string, files: Set<string>, profile: DeploymentProfileDraft, dependencies: string) {
    const categories = [
      ...["uploads", "media", "storage"].filter((name) => files.has(name)).map(() => "writable-directory"),
      ...(/sqlite/.test(dependencies) ? ["local-database-file"] : []),
      ...(/upload/.test(dependencies) ? ["upload-library"] : []),
    ];
    if (categories.length) {
      profile.rawProfile.filesystemPersistenceDetected = true;
      profile.rawProfile.filesystemPersistenceEvidence = [...new Set(categories)];
    }
  }
  private hasSqliteUsage(path: string, files: Set<string>) { if (Array.from(files).some((file) => /\.(sqlite|sqlite3|db)$/.test(file))) return true; return ["package.json", "server.js", "app.js", "index.js"].some((file) => /sqlite/i.test(this.readOptionalFile(path, file) || "")); }
}
