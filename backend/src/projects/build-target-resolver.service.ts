import { Injectable } from "@nestjs/common";
import { Dirent } from "fs";
import { lstat, readdir, readFile, realpath } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import { parseDocument } from "yaml";
import { BUILD_TARGET_RESOLVER_VERSION, BuildTargetExecution, CanonicalBuildTarget, assertBuildTargetOverride, canonicalBuildTarget } from "./build-target";
import { normalizeServiceDirectory } from "./deployable-service-path";

export class BuildTargetResolutionError extends Error {
  constructor(readonly code: "DG_BUILD_TARGET_UNRESOLVED" | "DG_BUILD_TARGET_AMBIGUOUS" | "DG_BUILD_TARGET_UNSUPPORTED" | "DG_BUILD_TARGET_INVALID" | "DG_DEPLOYMENT_CONTRACT_UNSUPPORTED", readonly serviceId: string, message: string, readonly evidence: Record<string, unknown> = {}) { super(message); }
  safeDetail() { return `DG_FAILURE serviceId=${this.serviceId} code=${this.code} stage=${this.code === "DG_DEPLOYMENT_CONTRACT_UNSUPPORTED" ? "deployment_contract_admission" : "build_target_resolution"}`; }
}
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
type PackageManifest = { name?: string; packageManager?: string; workspaces?: string[] | { packages?: string[] }; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
type RootEvidence = { root: string; workspacePatterns: string[]; manager: PackageManager; markers: string[] };
type PythonEvidence = { kind: "poetry" | "uv" | "pdm" | "pipenv" | "pip" | "pyproject" | null; name: string | null; paths: string[]; workspace: boolean };

const ignored = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "venv"]);
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const exists = async (path: string) => lstat(path).then(() => true).catch(() => false);
const json = async <T>(path: string): Promise<T | null> => { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; } };
const repositoryPath = (root: string, path: string) => normalizeServiceDirectory(relative(root, path).replace(/\\/g, "/") || ".");
const inside = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);

const matchesGlob = (path: string, value: string) => {
  const pattern = value.trim().replace(/^\.\//, "").replace(/\/$/, "");
  if (!pattern) return false;
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") { index += 1; if (pattern[index + 1] === "/") { expression += "(?:.*/)?"; index += 1; } else expression += ".*"; }
    else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(path);
};
const workspaceMember = (path: string, patterns: string[]) => {
  const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negative = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  return positive.some((pattern) => matchesGlob(path, pattern)) && !negative.some((pattern) => matchesGlob(path, pattern));
};

@Injectable()
export class BuildTargetResolverService {
  async resolve(root: string, input: { serviceId: string; sourceSha: string; serviceDirectory: string; override?: unknown }): Promise<CanonicalBuildTarget> {
    const canonicalRoot = await realpath(root);
    const serviceDirectory = normalizeServiceDirectory(input.serviceDirectory);
    const servicePath = await this.containedDirectory(canonicalRoot, serviceDirectory, input.serviceId);
    this.override(input.override, input.serviceId);
    const owner = (await this.workspaceOwners(canonicalRoot, servicePath, input.serviceId)).sort((a, b) => b.root.length - a.root.length)[0] || null;
    const servicePackage = await json<PackageManifest>(join(servicePath, "package.json"));
    const python = await this.pythonEvidence(canonicalRoot, servicePath);
    if (owner && !servicePackage) throw this.unsupported(input.serviceId, "A declared JavaScript workspace member must contain package.json.", { workspaceRoot: repositoryPath(canonicalRoot, owner.root) });
    if (python.workspace) throw this.unsupported(input.serviceId, "A Python workspace member is outside the DeployGuard v1 Python standalone contract.", { serviceDirectory });
    const packages = owner ? await this.workspacePackages(owner, input.serviceId) : [];
    const dependencies = await this.localDependencies(canonicalRoot, owner?.root || servicePath, servicePath, servicePackage, python.paths, packages, input.serviceId);
    if (servicePackage && owner) {
      const execution = this.workspaceExecution(owner, servicePackage, servicePath, packages, input.serviceId);
      const workspaceRoot = repositoryPath(canonicalRoot, owner.root);
      return this.target({ sourceSha: input.sourceSha, serviceDirectory, workspaceRoot, buildRoot: workspaceRoot, installRoot: workspaceRoot, packageIdentity: execution.packageTarget, contract: "JS_WORKSPACE_MEMBER", execution, dependencyPaths: dependencies.map((path) => repositoryPath(canonicalRoot, path)), strategy: "workspace", evidence: { serviceManifest: true, python: null, workspace: { root: workspaceRoot, manager: owner.manager, markers: owner.markers, patterns: owner.workspacePatterns }, dependencyCount: dependencies.length } });
    }
    if (servicePackage) {
      if (dependencies.length) throw this.unsupported(input.serviceId, "A standalone JavaScript service may not depend on a local sibling outside its selected service boundary.", { dependencyPaths: dependencies.map((path) => repositoryPath(canonicalRoot, path)) });
      const packageManager = await this.packageManager(servicePath, servicePackage, false, input.serviceId);
      return this.target({ sourceSha: input.sourceSha, serviceDirectory, workspaceRoot: serviceDirectory, buildRoot: serviceDirectory, installRoot: serviceDirectory, packageIdentity: servicePackage.name || null, contract: "JS_STANDALONE", execution: { packageTarget: null, packageManager, buildCommand: null, startCommand: null }, dependencyPaths: [], strategy: "isolated", evidence: { serviceManifest: true, python: null, workspace: null, packageManager, packageManagerMarkers: await this.packageManagerMarkers(servicePath, servicePackage), dependencyCount: 0 } });
    }
    if (python.kind) {
      const external = dependencies.filter((path) => !inside(servicePath, path));
      if (external.length) throw this.unsupported(input.serviceId, "A Python service may not depend on a sibling path outside its selected service boundary.", { dependencyPaths: external.map((path) => repositoryPath(canonicalRoot, path)) });
      return this.target({ sourceSha: input.sourceSha, serviceDirectory, workspaceRoot: serviceDirectory, buildRoot: serviceDirectory, installRoot: serviceDirectory, packageIdentity: python.name, contract: "PYTHON_STANDALONE", execution: { packageTarget: null, packageManager: null, buildCommand: null, startCommand: null }, dependencyPaths: dependencies.map((path) => repositoryPath(canonicalRoot, path)), strategy: "python_local", evidence: { serviceManifest: false, python: python.kind, workspace: null, dependencyCount: dependencies.length } });
    }
    throw this.unsupported(input.serviceId, "The selected service does not satisfy a supported DeployGuard v1 JavaScript or Python deployment contract.", { serviceDirectory });
  }

  private target(value: Omit<CanonicalBuildTarget, "resolverVersion" | "status" | "override" | "fingerprint">) { return canonicalBuildTarget({ resolverVersion: BUILD_TARGET_RESOLVER_VERSION, ...value, status: "resolved", override: null }); }
  private unsupported(serviceId: string, message: string, evidence: Record<string, unknown> = {}) { return new BuildTargetResolutionError("DG_DEPLOYMENT_CONTRACT_UNSUPPORTED", serviceId, message, evidence); }
  private override(value: unknown, serviceId: string) { try { assertBuildTargetOverride(value); } catch (error) { throw this.unsupported(serviceId, error instanceof Error ? error.message : "Build-target overrides are unsupported by the DeployGuard v1 deployment contract."); } }
  private async containedDirectory(root: string, directory: string, serviceId: string) { const path = directory === "." ? root : join(root, ...directory.split("/")); try { const entry = await lstat(path); const actual = await realpath(path); if (!entry.isDirectory() || (actual !== root && !actual.startsWith(`${root}/`))) throw new Error(); return actual; } catch { throw new BuildTargetResolutionError("DG_BUILD_TARGET_INVALID", serviceId, `Build target path '${directory}' is missing or escapes the repository.`); } }

  private async workspaceOwners(root: string, servicePath: string, serviceId: string) {
    const candidates: string[] = []; let cursor = servicePath; while (true) { candidates.push(cursor); if (cursor === root) break; cursor = dirname(cursor); }
    const owners: RootEvidence[] = [];
    for (const candidate of candidates) {
      const manifest = await json<PackageManifest>(join(candidate, "package.json")); const manifestWorkspace = this.manifestWorkspacePatterns(manifest); const pnpm = await this.pnpmWorkspacePatterns(join(candidate, "pnpm-workspace.yaml"));
      if (!manifestWorkspace.declared && !pnpm.exists) continue;
      if (!manifestWorkspace.valid || !pnpm.valid) throw this.unsupported(serviceId, "Workspace ownership is uncertain because its declaration cannot be parsed.", { workspaceRoot: repositoryPath(root, candidate) });
      const patterns = [...new Set([...manifestWorkspace.patterns, ...pnpm.patterns])].sort();
      const markers = [pnpm.exists && "pnpm-workspace.yaml", ...(await this.packageManagerMarkers(candidate, manifest))].filter(Boolean) as string[];
      const evidence: RootEvidence = { root: candidate, workspacePatterns: patterns, manager: await this.packageManager(candidate, manifest, pnpm.exists, serviceId), markers: [...new Set(markers)].sort() };
      const serviceRelative = repositoryPath(candidate, servicePath);
      if ((serviceRelative === "." && Boolean(manifest?.name)) || workspaceMember(serviceRelative, patterns)) owners.push(evidence);
    }
    return owners;
  }
  private manifestWorkspacePatterns(manifest: PackageManifest | null) {
    if (!manifest || !("workspaces" in manifest)) return { declared: false, valid: true, patterns: [] as string[] };
    const value = manifest.workspaces; const patterns = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray(value.packages) ? value.packages : null;
    return patterns === null || patterns.some((item) => typeof item !== "string" || !item.trim()) ? { declared: true, valid: false, patterns: [] as string[] } : { declared: true, valid: true, patterns: patterns.map((item) => item.trim()) };
  }
  private async pnpmWorkspacePatterns(path: string) {
    if (!await exists(path)) return { exists: false, valid: true, patterns: [] as string[] };
    try { const document = parseDocument(await readFile(path, "utf8")); const value = document.toJS() as { packages?: unknown }; if (document.errors.length || !Array.isArray(value?.packages) || value.packages.some((item) => typeof item !== "string" || !item.trim())) return { exists: true, valid: false, patterns: [] as string[] }; return { exists: true, valid: true, patterns: value.packages.map((item) => (item as string).trim()) }; } catch { return { exists: true, valid: false, patterns: [] as string[] }; }
  }
  private async lockfileMarkers(root: string) { const markers: string[] = []; for (const name of ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) if (await exists(join(root, name))) markers.push(name); return markers; }
  private async packageManagerMarkers(root: string, manifest: PackageManifest | null) { return [manifest?.packageManager && "packageManager", ...(await this.lockfileMarkers(root))].filter(Boolean) as string[]; }
  private async packageManager(root: string, manifest: PackageManifest | null, pnpmWorkspace: boolean, serviceId: string): Promise<PackageManager> {
    const evidence = new Set<PackageManager>(); const declared = String(manifest?.packageManager || "").trim().match(/^(npm|pnpm|yarn|bun)@/i)?.[1]?.toLowerCase() as PackageManager | undefined;
    if (manifest?.packageManager && !declared) throw this.unsupported(serviceId, "The packageManager declaration is unsupported or invalid.", { packageManagerRoot: root });
    if (declared) evidence.add(declared); if (pnpmWorkspace) evidence.add("pnpm");
    const locks = await this.lockfileMarkers(root); if (locks.some((name) => name === "package-lock.json" || name === "npm-shrinkwrap.json")) evidence.add("npm"); if (locks.includes("pnpm-lock.yaml")) evidence.add("pnpm"); if (locks.includes("yarn.lock")) evidence.add("yarn"); if (locks.some((name) => name === "bun.lock" || name === "bun.lockb")) evidence.add("bun");
    if (evidence.size > 1) throw this.unsupported(serviceId, "Repository package-manager evidence conflicts.", { packageManagerRoot: root, managers: [...evidence].sort() }); return [...evidence][0] || "npm";
  }
  private async workspacePackages(evidence: RootEvidence, serviceId: string) {
    const packages: Array<{ name: string; path: string }> = []; for (const path of await this.manifests(evidence.root)) { const packagePath = dirname(path); const manifest = await json<PackageManifest>(path); if (manifest?.name && (repositoryPath(evidence.root, packagePath) === "." || workspaceMember(repositoryPath(evidence.root, packagePath), evidence.workspacePatterns))) packages.push({ name: manifest.name, path: packagePath }); }
    const duplicates = packages.filter((item, index) => packages.findIndex((candidate) => candidate.name === item.name) !== index); if (duplicates.length) throw this.unsupported(serviceId, `Workspace contains duplicate package identities: ${[...new Set(duplicates.map((item) => item.name))].join(", ")}.`); return packages;
  }
  private workspaceExecution(owner: RootEvidence, manifest: PackageManifest, servicePath: string, packages: Array<{ name: string; path: string }>, serviceId: string): BuildTargetExecution {
    const target = manifest.name || ""; if (!packageName.test(target) || !packages.some((item) => item.name === target && item.path === servicePath)) throw this.unsupported(serviceId, "Workspace package identity is missing, invalid, or ambiguous.", { workspaceRoot: owner.root }); if (!manifest.scripts?.build?.trim()) throw this.unsupported(serviceId, "A workspace service requires a package-specific build script.", { packageTarget: target }); if (!manifest.scripts.start?.trim() && !this.staticApplication(manifest)) throw this.unsupported(serviceId, "A workspace service requires a package-specific start script unless it is a supported static application.", { packageTarget: target });
    const commands = owner.manager === "pnpm" ? { build: `pnpm --filter ${target} run build`, start: `pnpm --filter ${target} run start` } : owner.manager === "yarn" ? { build: `yarn workspace ${target} run build`, start: `yarn workspace ${target} run start` } : owner.manager === "bun" ? { build: `bun --filter ${target} run build`, start: `bun --filter ${target} run start` } : { build: `npm --workspace ${target} run build`, start: `npm --workspace ${target} run start` };
    return { packageTarget: target, packageManager: owner.manager, buildCommand: commands.build, startCommand: manifest.scripts.start?.trim() ? commands.start : null };
  }
  private staticApplication(manifest: PackageManifest) { const dependencies = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) }; return Boolean(dependencies.vite || dependencies["@vitejs/plugin-react"] || dependencies["react-scripts"]); }
  private async manifests(root: string) { const values: string[] = []; const visit = async (path: string, depth: number): Promise<void> => { if (depth > 8) return; let entries: Dirent[]; try { entries = await readdir(path, { withFileTypes: true }); } catch { return; } for (const entry of entries) { if (ignored.has(entry.name)) continue; const next = join(path, entry.name); if (entry.isFile() && entry.name === "package.json") values.push(next); if (entry.isDirectory()) await visit(next, depth + 1); } }; await visit(root, 0); return values; }
  private async pythonEvidence(root: string, servicePath: string): Promise<PythonEvidence> {
    const pyprojectPath = join(servicePath, "pyproject.toml"); const requirementsPath = join(servicePath, "requirements.txt"); const pyprojectExists = await exists(pyprojectPath); const requirementsExists = await exists(requirementsPath); const pipfileExists = await exists(join(servicePath, "Pipfile")); const pyproject = pyprojectExists ? await readFile(pyprojectPath, "utf8") : ""; const requirements = requirementsExists ? await readFile(requirementsPath, "utf8") : "";
    const kind = /\[tool\.poetry\]/.test(pyproject) ? "poetry" : /\[tool\.uv\]/.test(pyproject) ? "uv" : /\[tool\.pdm\]/.test(pyproject) ? "pdm" : pipfileExists ? "pipenv" : requirementsExists ? "pip" : pyprojectExists ? "pyproject" : null;
    const paths = [...pyproject.matchAll(/\bpath\s*=\s*["']([^"']+)["']/g), ...pyproject.matchAll(/\b(?:url|file)\s*=\s*["']file:\/\/([^"']+)["']/g), ...pyproject.matchAll(/\s@\s*(?:file:\/\/)?([^\s"']*(?:\.\.\/|\.\/)[^\s"']*)/g), ...requirements.matchAll(/(?:^|\s)(?:-e\s+)?((?:file:\/\/)?(?:\.\.\/|\.\/)[^\s#]+)/gm), ...requirements.matchAll(/\s@\s*(?:file:\/\/)?([^\s#]*(?:\.\.\/|\.\/)[^\s#]*)/g)].map((match) => match[1]).filter(Boolean);
    let workspace = /\bworkspace\s*=\s*true\b/.test(pyproject); let cursor = servicePath;
    while (true) { const ancestor = join(cursor, "pyproject.toml"); if (await exists(ancestor)) { const content = await readFile(ancestor, "utf8"); if (/\[tool\.uv\.workspace\]/.test(content)) { const relativeService = repositoryPath(cursor, servicePath); const members = this.tomlArray(content, "members"); if (relativeService === "." || members === null || workspaceMember(relativeService, members)) workspace = true; } } if (cursor === root) break; cursor = dirname(cursor); }
    return { kind, name: pyproject.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] || null, paths, workspace };
  }
  private tomlArray(content: string, key: string) { const value = content.match(new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m")); if (!value) return null; const entries = [...value[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]); return entries.length ? entries : null; }
  private async localDependencies(root: string, boundary: string, servicePath: string, manifest: PackageManifest | null, pythonPaths: string[], packages: Array<{ name: string; path: string }>, serviceId: string) {
    const paths: string[] = []; const byName = new Map(packages.map((item) => [item.name, item.path])); for (const deps of [manifest?.dependencies, manifest?.devDependencies, manifest?.peerDependencies]) for (const [name, version] of Object.entries(deps || {})) { if (version.startsWith("workspace:")) { const destination = byName.get(name); if (!destination) throw this.unsupported(serviceId, `Workspace dependency '${name}' has no unique local package.`, { dependency: name }); paths.push(destination); } if (/^(file:|link:|\.\.?(?:\/|$))/.test(version)) paths.push(resolve(servicePath, version.replace(/^(file:|link:)/, ""))); }
    for (const local of pythonPaths) paths.push(resolve(servicePath, local.replace(/^file:\/\//, ""))); const resolved: string[] = []; for (const path of paths) { try { const actual = await realpath(path); if (!inside(root, actual) || !inside(boundary, actual)) throw new Error(); resolved.push(actual); } catch { throw this.unsupported(serviceId, "A declared local dependency is missing or outside the canonical build root.", { dependencyPath: path, buildRoot: repositoryPath(root, boundary) }); } } return [...new Set(resolved)].sort();
  }
}
