import { Injectable } from "@nestjs/common";
import { Dirent } from "fs";
import { lstat, readdir, readFile, realpath } from "fs/promises";
import { basename, dirname, join, relative, resolve } from "path";
import { BuildTargetOverride, BUILD_TARGET_RESOLVER_VERSION, CanonicalBuildTarget, assertBuildTargetOverride, canonicalBuildTarget } from "./build-target";
import { normalizeServiceDirectory } from "./deployable-service-path";

export class BuildTargetResolutionError extends Error {
  constructor(readonly code: "DG_BUILD_TARGET_UNRESOLVED" | "DG_BUILD_TARGET_AMBIGUOUS" | "DG_BUILD_TARGET_UNSUPPORTED" | "DG_BUILD_TARGET_INVALID", readonly serviceId: string, message: string, readonly evidence: Record<string, unknown> = {}) { super(message); }
  safeDetail() { return `DG_FAILURE serviceId=${this.serviceId} code=${this.code} stage=build_target_resolution`; }
}
type PackageManifest = { name?: string; workspaces?: string[] | { packages?: string[] }; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
type RootEvidence = { root: string; workspacePatterns: string[]; manager: string | null; markers: string[] };

const ignored = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "venv"]);
const exists = async (path: string) => lstat(path).then(() => true).catch(() => false);
const json = async <T>(path: string): Promise<T | null> => { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; } };
const repositoryPath = (root: string, path: string) => {
  const value = relative(root, path).replace(/\\/g, "/") || ".";
  return normalizeServiceDirectory(value);
};
const matchesGlob = (path: string, pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`).test(path);

@Injectable()
export class BuildTargetResolverService {
  async resolve(root: string, input: { serviceId: string; sourceSha: string; serviceDirectory: string; override?: unknown }): Promise<CanonicalBuildTarget> {
    const canonicalRoot = await realpath(root);
    const serviceDirectory = normalizeServiceDirectory(input.serviceDirectory);
    const servicePath = await this.containedDirectory(canonicalRoot, serviceDirectory, input.serviceId);
    const override = this.override(input.override, input.serviceId);
    const roots = await this.workspaceRoots(canonicalRoot, servicePath);
    const owner = roots.length ? roots.sort((a, b) => b.root.length - a.root.length)[0] : null;
    const servicePackage = await json<PackageManifest>(join(servicePath, "package.json"));
    const python = await this.pythonEvidence(servicePath);
    const workspacePackages = owner ? await this.workspacePackages(canonicalRoot, owner, input.serviceId) : [];
    const packageIdentity = servicePackage?.name || python.name || null;
    if (owner && !servicePackage && !python.kind) throw new BuildTargetResolutionError("DG_BUILD_TARGET_UNSUPPORTED", input.serviceId, "The selected workspace member has no supported JavaScript or Python project manifest.", { workspaceRoot: repositoryPath(canonicalRoot, owner.root) });
    const dependencies = await this.localDependencies(canonicalRoot, servicePath, servicePackage, python.paths, workspacePackages, input.serviceId);
    // A declared JavaScript workspace owns installation and build topology even
    // when the selected package has no explicit local sibling dependency.
    const workspaceRequired = Boolean(owner && servicePackage);
    let workspaceRoot = owner ? repositoryPath(canonicalRoot, owner.root) : serviceDirectory;
    let buildRoot = workspaceRequired ? workspaceRoot : serviceDirectory;
    let installRoot = buildRoot;
    let strategy: CanonicalBuildTarget["strategy"] = python.paths.length ? "python_local" : workspaceRequired ? "workspace" : "isolated";
    if (override) {
      workspaceRoot = override.workspaceRoot || workspaceRoot; buildRoot = override.buildRoot || buildRoot; installRoot = override.installRoot || buildRoot; strategy = "override";
      await Promise.all([this.containedDirectory(canonicalRoot, workspaceRoot, input.serviceId), this.containedDirectory(canonicalRoot, buildRoot, input.serviceId), this.containedDirectory(canonicalRoot, installRoot, input.serviceId)]);
    }
    const target = canonicalBuildTarget({
      resolverVersion: BUILD_TARGET_RESOLVER_VERSION, sourceSha: input.sourceSha.toLowerCase(), serviceDirectory, workspaceRoot, buildRoot, installRoot,
      packageIdentity: override?.selectedPackage || packageIdentity, dependencyPaths: dependencies.map((path) => repositoryPath(canonicalRoot, path)), strategy, status: "resolved", override,
      evidence: { serviceManifest: Boolean(servicePackage), python: python.kind, workspace: owner ? { root: workspaceRoot, manager: owner.manager, markers: owner.markers, patterns: owner.workspacePatterns } : null, dependencyCount: dependencies.length },
    });
    return target;
  }

  private override(value: unknown, serviceId: string) { try { return assertBuildTargetOverride(value); } catch (error) { throw new BuildTargetResolutionError("DG_BUILD_TARGET_INVALID", serviceId, error instanceof Error ? error.message : "Build-target override is invalid."); } }
  private async containedDirectory(root: string, directory: string, serviceId: string) {
    const path = directory === "." ? root : join(root, ...directory.split("/"));
    try { const entry = await lstat(path); const actual = await realpath(path); if (!entry.isDirectory() || (actual !== root && !actual.startsWith(`${root}/`))) throw new Error(); return actual; }
    catch { throw new BuildTargetResolutionError("DG_BUILD_TARGET_INVALID", serviceId, `Build target path '${directory}' is missing or escapes the repository.`); }
  }
  private async workspaceRoots(root: string, servicePath: string): Promise<RootEvidence[]> {
    const candidates: string[] = []; let cursor = servicePath;
    while (true) { candidates.push(cursor); if (cursor === root) break; cursor = dirname(cursor); }
    const values: RootEvidence[] = [];
    for (const candidate of candidates) {
      const manifest = await json<PackageManifest>(join(candidate, "package.json")); const pnpm = await this.pnpmPatterns(join(candidate, "pnpm-workspace.yaml"));
      const lerna = await json<{ packages?: string[] }>(join(candidate, "lerna.json"));
      const patterns = [...(Array.isArray(manifest?.workspaces) ? manifest.workspaces : manifest?.workspaces?.packages || []), ...pnpm, ...(lerna?.packages || [])].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      const markers = [await exists(join(candidate, "pnpm-workspace.yaml")) && "pnpm-workspace.yaml", await exists(join(candidate, "nx.json")) && "nx.json", await exists(join(candidate, "turbo.json")) && "turbo.json", await exists(join(candidate, "lerna.json")) && "lerna.json"].filter(Boolean) as string[];
      const relativeService = repositoryPath(candidate, servicePath);
      if (patterns.some((pattern) => matchesGlob(relativeService, pattern) || matchesGlob(relativeService, `${pattern}/**`))) values.push({ root: candidate, workspacePatterns: patterns.sort(), manager: (await exists(join(candidate, "pnpm-lock.yaml"))) ? "pnpm" : (await exists(join(candidate, "yarn.lock"))) ? "yarn" : (await exists(join(candidate, "bun.lockb"))) || (await exists(join(candidate, "bun.lock"))) ? "bun" : "npm", markers });
    }
    return values;
  }
  private async pnpmPatterns(path: string) { try { const data = await readFile(path, "utf8"); const section = data.match(/^packages:\s*\n((?:\s+-\s+[^\n]+\n?)+)/m)?.[1] || ""; return [...section.matchAll(/^\s+-\s+['\"]?([^'\"\n]+)['\"]?\s*$/gm)].map((match) => match[1].trim()); } catch { return []; } }
  private async workspacePackages(root: string, evidence: RootEvidence, serviceId: string) {
    const manifests = await this.manifests(evidence.root); const packages: Array<{ name: string; path: string }> = [];
    for (const path of manifests) { const relativePath = repositoryPath(evidence.root, dirname(path)); const manifest = await json<PackageManifest>(path); if (manifest?.name && evidence.workspacePatterns.some((pattern) => matchesGlob(relativePath, pattern))) packages.push({ name: manifest.name, path: dirname(path) }); }
    const duplicates = packages.filter((item, index) => packages.findIndex((candidate) => candidate.name === item.name) !== index);
    if (duplicates.length) throw new BuildTargetResolutionError("DG_BUILD_TARGET_AMBIGUOUS", serviceId, `Workspace contains duplicate package identities: ${[...new Set(duplicates.map((item) => item.name))].join(", ")}.`);
    return packages;
  }
  private async manifests(root: string) {
    const values: string[] = []; const visit = async (path: string, depth: number): Promise<void> => { if (depth > 8) return; let entries: Dirent[]; try { entries = await readdir(path, { withFileTypes: true }); } catch { return; } for (const entry of entries) { if (ignored.has(entry.name)) continue; const next = join(path, entry.name); if (entry.isFile() && entry.name === "package.json") values.push(next); if (entry.isDirectory()) await visit(next, depth + 1); } }; await visit(root, 0); return values;
  }
  private async pythonEvidence(path: string) { const pyproject = await readFile(join(path, "pyproject.toml"), "utf8").catch(() => ""); const requirements = await readFile(join(path, "requirements.txt"), "utf8").catch(() => ""); const kind = /\[tool\.poetry\]/.test(pyproject) ? "poetry" : /\[tool\.uv\]/.test(pyproject) ? "uv" : /\[tool\.pdm\]/.test(pyproject) ? "pdm" : await exists(join(path, "Pipfile")) ? "pipenv" : requirements ? "pip" : pyproject ? "pyproject" : null; const name = pyproject.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] || null; const paths = [...pyproject.matchAll(/path\s*=\s*["']([^"']+)["']/g), ...requirements.matchAll(/(?:-e\s+|\.\.?\/)([^\s#]+)/g)].map((match) => match[1]).filter(Boolean); return { kind, name, paths }; }
  private async localDependencies(root: string, servicePath: string, manifest: PackageManifest | null, pythonPaths: string[], packages: Array<{ name: string; path: string }>, serviceId: string) {
    const paths: string[] = []; const byName = new Map(packages.map((item) => [item.name, item.path]));
    for (const deps of [manifest?.dependencies, manifest?.devDependencies, manifest?.peerDependencies]) for (const [name, version] of Object.entries(deps || {})) {
      if (version.startsWith("workspace:")) { const destination = byName.get(name); if (!destination) throw new BuildTargetResolutionError("DG_BUILD_TARGET_UNRESOLVED", serviceId, `Workspace dependency '${name}' has no unique local package.`, { dependency: name }); paths.push(destination); }
      if (/^(file:|link:|\.\.?\/)/.test(version)) paths.push(resolve(servicePath, version.replace(/^(file:|link:)/, "")));
    }
    for (const local of pythonPaths) paths.push(resolve(servicePath, local));
    const resolved: string[] = []; for (const path of paths) { try { const actual = await realpath(path); if (actual !== root && !actual.startsWith(`${root}/`)) throw new Error(); resolved.push(actual); } catch { throw new BuildTargetResolutionError("DG_BUILD_TARGET_UNRESOLVED", serviceId, "A declared local dependency is missing or outside the repository.", { dependencyPath: path }); } }
    return [...new Set(resolved)].sort();
  }
}
