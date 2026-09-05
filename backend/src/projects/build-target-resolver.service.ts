import { Injectable } from "@nestjs/common";
import { Dirent } from "fs";
import { lstat, readdir, readFile, realpath } from "fs/promises";
import { basename, dirname, join, relative, resolve } from "path";
import { BUILD_TARGET_RESOLVER_VERSION, BuildTargetExecution, CanonicalBuildTarget, assertBuildTargetOverride, canonicalBuildTarget } from "./build-target";
import { normalizeServiceDirectory } from "./deployable-service-path";

export class BuildTargetResolutionError extends Error {
  constructor(readonly code: "DG_BUILD_TARGET_UNRESOLVED" | "DG_BUILD_TARGET_AMBIGUOUS" | "DG_BUILD_TARGET_UNSUPPORTED" | "DG_BUILD_TARGET_INVALID" | "DG_DEPLOYMENT_CONTRACT_UNSUPPORTED", readonly serviceId: string, message: string, readonly evidence: Record<string, unknown> = {}) { super(message); }
  safeDetail() { return `DG_FAILURE serviceId=${this.serviceId} code=${this.code} stage=${this.code === "DG_DEPLOYMENT_CONTRACT_UNSUPPORTED" ? "deployment_contract_admission" : "build_target_resolution"}`; }
}
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
type PackageManifest = { name?: string; workspaces?: string[] | { packages?: string[] }; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
type RootEvidence = { root: string; workspacePatterns: string[]; manager: PackageManager; markers: string[] };
type WorkspaceTopology = { owners: RootEvidence[]; declarations: RootEvidence[] };

const ignored = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "venv"]);
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const exists = async (path: string) => lstat(path).then(() => true).catch(() => false);
const json = async <T>(path: string): Promise<T | null> => { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; } };
const repositoryPath = (root: string, path: string) => {
  const value = relative(root, path).replace(/\\/g, "/") || ".";
  return normalizeServiceDirectory(value);
};
const matchesGlob = (path: string, pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`).test(path);
const inside = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);

@Injectable()
export class BuildTargetResolverService {
  async resolve(root: string, input: { serviceId: string; sourceSha: string; serviceDirectory: string; override?: unknown }): Promise<CanonicalBuildTarget> {
    const canonicalRoot = await realpath(root);
    const serviceDirectory = normalizeServiceDirectory(input.serviceDirectory);
    const servicePath = await this.containedDirectory(canonicalRoot, serviceDirectory, input.serviceId);
    this.override(input.override, input.serviceId);
    const topology = await this.workspaceTopology(canonicalRoot, servicePath);
    const owner = topology.owners.sort((a, b) => b.root.length - a.root.length)[0] || null;
    const servicePackage = await json<PackageManifest>(join(servicePath, "package.json"));
    const python = await this.pythonEvidence(servicePath);
    if (!owner && topology.declarations.length) throw this.unsupported(input.serviceId, "Workspace ownership could not be determined for the selected service.", { workspaceRoots: topology.declarations.map((item) => repositoryPath(canonicalRoot, item.root)) });
    if (owner && !servicePackage) throw this.unsupported(input.serviceId, "A declared JavaScript workspace member must contain package.json.", { workspaceRoot: repositoryPath(canonicalRoot, owner.root) });
    const workspacePackages = owner ? await this.workspacePackages(owner, input.serviceId) : [];
    const dependencies = await this.localDependencies(canonicalRoot, servicePath, servicePackage, python.paths, workspacePackages, input.serviceId);
    if (servicePackage && owner) {
      const execution = this.workspaceExecution(owner, servicePackage, servicePath, workspacePackages, input.serviceId);
      const workspaceRoot = repositoryPath(canonicalRoot, owner.root);
      return this.target({ sourceSha: input.sourceSha, serviceDirectory, workspaceRoot, buildRoot: workspaceRoot, installRoot: workspaceRoot, packageIdentity: execution.packageTarget, contract: "JS_WORKSPACE_MEMBER", execution, dependencyPaths: dependencies.map((path) => repositoryPath(canonicalRoot, path)), strategy: "workspace", evidence: { serviceManifest: true, python: null, workspace: { root: workspaceRoot, manager: owner.manager, markers: owner.markers, patterns: owner.workspacePatterns }, dependencyCount: dependencies.length } });
    }
    if (servicePackage) {
      if (dependencies.length) throw this.unsupported(input.serviceId, "A standalone JavaScript service may not depend on a local sibling outside its selected service boundary.", { dependencyPaths: dependencies.map((path) => repositoryPath(canonicalRoot, path)) });
      return this.target({ sourceSha: input.sourceSha, serviceDirectory, workspaceRoot: serviceDirectory, buildRoot: serviceDirectory, installRoot: serviceDirectory, packageIdentity: servicePackage.name || null, contract: "JS_STANDALONE", execution: { packageTarget: null, packageManager: null, buildCommand: null, startCommand: null }, dependencyPaths: [], strategy: "isolated", evidence: { serviceManifest: true, python: null, workspace: null, dependencyCount: 0 } });
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
  private async containedDirectory(root: string, directory: string, serviceId: string) {
    const path = directory === "." ? root : join(root, ...directory.split("/"));
    try { const entry = await lstat(path); const actual = await realpath(path); if (!entry.isDirectory() || (actual !== root && !actual.startsWith(`${root}/`))) throw new Error(); return actual; }
    catch { throw new BuildTargetResolutionError("DG_BUILD_TARGET_INVALID", serviceId, `Build target path '${directory}' is missing or escapes the repository.`); }
  }
  private async workspaceTopology(root: string, servicePath: string): Promise<WorkspaceTopology> {
    const candidates: string[] = []; let cursor = servicePath;
    while (true) { candidates.push(cursor); if (cursor === root) break; cursor = dirname(cursor); }
    const owners: RootEvidence[] = []; const declarations: RootEvidence[] = [];
    for (const candidate of candidates) {
      const manifest = await json<PackageManifest>(join(candidate, "package.json")); const pnpmWorkspace = join(candidate, "pnpm-workspace.yaml"); const pnpm = await this.pnpmPatterns(pnpmWorkspace);
      const manifestPatterns = [...(Array.isArray(manifest?.workspaces) ? manifest.workspaces : manifest?.workspaces?.packages || [])].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      const patterns = [...new Set([...manifestPatterns, ...pnpm])].sort();
      const hasDeclaration = manifestPatterns.length > 0 || await exists(pnpmWorkspace);
      if (!hasDeclaration) continue;
      const markers = [await exists(pnpmWorkspace) && "pnpm-workspace.yaml"].filter(Boolean) as string[];
      const evidence = { root: candidate, workspacePatterns: patterns, manager: await this.workspaceManager(candidate, Boolean(markers.length)), markers };
      declarations.push(evidence);
      const relativeService = repositoryPath(candidate, servicePath);
      if (patterns.some((pattern) => matchesGlob(relativeService, pattern) || matchesGlob(relativeService, `${pattern}/**`))) owners.push(evidence);
    }
    return { owners, declarations };
  }
  private async workspaceManager(root: string, pnpmWorkspace: boolean): Promise<PackageManager> { if (pnpmWorkspace || await exists(join(root, "pnpm-lock.yaml"))) return "pnpm"; if (await exists(join(root, "yarn.lock"))) return "yarn"; if (await exists(join(root, "bun.lockb")) || await exists(join(root, "bun.lock"))) return "bun"; return "npm"; }
  private async pnpmPatterns(path: string) { try { const data = await readFile(path, "utf8"); const section = data.match(/^packages:\s*\n((?:\s+-\s+[^\n]+\n?)+)/m)?.[1] || ""; return [...section.matchAll(/^\s+-\s+['\"]?([^'\"\n]+)['\"]?\s*$/gm)].map((match) => match[1].trim()); } catch { return []; } }
  private async workspacePackages(evidence: RootEvidence, serviceId: string) {
    const manifests = await this.manifests(evidence.root); const packages: Array<{ name: string; path: string }> = [];
    for (const path of manifests) { const relativePath = repositoryPath(evidence.root, dirname(path)); const manifest = await json<PackageManifest>(path); if (manifest?.name && evidence.workspacePatterns.some((pattern) => matchesGlob(relativePath, pattern))) packages.push({ name: manifest.name, path: dirname(path) }); }
    const duplicates = packages.filter((item, index) => packages.findIndex((candidate) => candidate.name === item.name) !== index);
    if (duplicates.length) throw this.unsupported(serviceId, `Workspace contains duplicate package identities: ${[...new Set(duplicates.map((item) => item.name))].join(", ")}.`);
    return packages;
  }
  private workspaceExecution(owner: RootEvidence, manifest: PackageManifest, servicePath: string, packages: Array<{ name: string; path: string }>, serviceId: string): BuildTargetExecution {
    const target = manifest.name || "";
    if (!packageName.test(target) || !packages.some((item) => item.name === target && item.path === servicePath)) throw this.unsupported(serviceId, "Workspace package identity is missing, invalid, or ambiguous.", { workspaceRoot: owner.root });
    if (!manifest.scripts?.build?.trim() || !manifest.scripts?.start?.trim()) throw this.unsupported(serviceId, "A workspace service requires package-specific build and start scripts.", { packageTarget: target });
    const commands = owner.manager === "pnpm" ? { build: `pnpm --filter ${target} run build`, start: `pnpm --filter ${target} run start` }
      : owner.manager === "yarn" ? { build: `yarn workspace ${target} run build`, start: `yarn workspace ${target} run start` }
        : owner.manager === "bun" ? { build: `bun --filter ${target} run build`, start: `bun --filter ${target} run start` }
          : { build: `npm --workspace ${target} run build`, start: `npm --workspace ${target} run start` };
    return { packageTarget: target, packageManager: owner.manager, buildCommand: commands.build, startCommand: commands.start };
  }
  private async manifests(root: string) {
    const values: string[] = []; const visit = async (path: string, depth: number): Promise<void> => { if (depth > 8) return; let entries: Dirent[]; try { entries = await readdir(path, { withFileTypes: true }); } catch { return; } for (const entry of entries) { if (ignored.has(entry.name)) continue; const next = join(path, entry.name); if (entry.isFile() && entry.name === "package.json") values.push(next); if (entry.isDirectory()) await visit(next, depth + 1); } }; await visit(root, 0); return values;
  }
  private async pythonEvidence(path: string) { const pyproject = await readFile(join(path, "pyproject.toml"), "utf8").catch(() => ""); const requirements = await readFile(join(path, "requirements.txt"), "utf8").catch(() => ""); const kind = /\[tool\.poetry\]/.test(pyproject) ? "poetry" : /\[tool\.uv\]/.test(pyproject) ? "uv" : /\[tool\.pdm\]/.test(pyproject) ? "pdm" : await exists(join(path, "Pipfile")) ? "pipenv" : requirements ? "pip" : pyproject ? "pyproject" : null; const name = pyproject.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] || null; const paths = [...pyproject.matchAll(/path\s*=\s*["']([^"']+)["']/g), ...requirements.matchAll(/(?:-e\s+|\.\.?\/)([^\s#]+)/g)].map((match) => match[1]).filter(Boolean); return { kind, name, paths }; }
  private async localDependencies(root: string, servicePath: string, manifest: PackageManifest | null, pythonPaths: string[], packages: Array<{ name: string; path: string }>, serviceId: string) {
    const paths: string[] = []; const byName = new Map(packages.map((item) => [item.name, item.path]));
    for (const deps of [manifest?.dependencies, manifest?.devDependencies, manifest?.peerDependencies]) for (const [name, version] of Object.entries(deps || {})) {
      if (version.startsWith("workspace:")) { const destination = byName.get(name); if (!destination) throw this.unsupported(serviceId, `Workspace dependency '${name}' has no unique local package.`, { dependency: name }); paths.push(destination); }
      if (/^(file:|link:|\.\.?\/)/.test(version)) paths.push(resolve(servicePath, version.replace(/^(file:|link:)/, "")));
    }
    for (const local of pythonPaths) paths.push(resolve(servicePath, local));
    const resolved: string[] = []; for (const path of paths) { try { const actual = await realpath(path); if (!inside(root, actual)) throw new Error(); resolved.push(actual); } catch { throw this.unsupported(serviceId, "A declared local dependency is missing or outside the repository.", { dependencyPath: path }); } }
    return [...new Set(resolved)].sort();
  }
}
