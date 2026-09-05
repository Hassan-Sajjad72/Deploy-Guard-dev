import "reflect-metadata";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BuildTargetResolutionError, BuildTargetResolverService } from "../src/projects/build-target-resolver.service";
import { RepositorySourceService } from "../src/projects/repository-source.service";
import { canonicalBuildTarget } from "../src/projects/build-target";

const serviceId = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(40);
const resolver = new BuildTargetResolverService();
const write = async (root: string, path: string, value: string) => { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), value); };
const packageJson = (name: string, dependencies: Record<string, string> = {}) => JSON.stringify({ name, version: "1.0.0", scripts: { build: "node build.js", start: "node index.js" }, dependencies });
const resolve = (root: string, serviceDirectory: string, override?: unknown) => resolver.resolve(root, { serviceId, sourceSha: sha, serviceDirectory, override });

void (async () => {
  const root = await mkdtemp(join(tmpdir(), "deployguard-build-target-"));
  try {
    // Standalone npm/pnpm/Yarn/Bun and nested standalone apps remain isolated.
    for (const manager of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]) {
      const fixture = join(root, manager.replace(/\W/g, "_")); await mkdir(fixture); await write(fixture, "package.json", packageJson(`standalone-${manager}`)); await write(fixture, manager, "lock");
      const target = await resolve(fixture, "."); assert.equal(target.strategy, "isolated"); assert.equal(target.contract, "JS_STANDALONE"); assert.equal(target.buildRoot, "."); assert.deepEqual(target.execution, { packageTarget: null, packageManager: null, buildCommand: null, startCommand: null });
    }
    const pnpm = join(root, "pnpm-shared"); await mkdir(pnpm); await write(pnpm, "pnpm-workspace.yaml", "packages:\n  - packages/*\n"); await write(pnpm, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n"); await write(pnpm, "packages/client/package.json", packageJson("@fixture/client")); await write(pnpm, "packages/client/src/index.ts", "export {}\n"); await write(pnpm, "packages/shared/package.json", packageJson("@fixture/shared"));
    const clientTarget = await resolve(pnpm, "packages/client"); assert.equal(clientTarget.workspaceRoot, "."); assert.equal(clientTarget.buildRoot, "."); assert.equal(clientTarget.installRoot, "."); assert.equal(clientTarget.strategy, "workspace"); assert.equal(clientTarget.contract, "JS_WORKSPACE_MEMBER"); assert.equal(clientTarget.packageIdentity, "@fixture/client"); assert.deepEqual(clientTarget.execution, { packageTarget: "@fixture/client", packageManager: "pnpm", buildCommand: "pnpm --filter @fixture/client run build", startCommand: "pnpm --filter @fixture/client run start" }); assert.deepEqual(clientTarget.dependencyPaths, []);
    const again = await resolve(pnpm, "packages/client"); assert.equal(clientTarget.fingerprint, again.fingerprint, "same SHA and topology are deterministic");
    const { fingerprint: _fingerprint, ...unsealedClientTarget } = clientTarget;
    const changedExecution = canonicalBuildTarget({ ...unsealedClientTarget, execution: { ...clientTarget.execution, startCommand: "pnpm --filter @fixture/client run start:alternate" } });
    assert.notEqual(changedExecution.fingerprint, clientTarget.fingerprint, "package-target execution commands are immutable BuildTarget fingerprint facts");
    await write(pnpm, "README.md", "irrelevant"); assert.equal((await resolve(pnpm, "packages/client")).fingerprint, clientTarget.fingerprint, "irrelevant content cannot alter ownership");
    await write(pnpm, "pnpm-workspace.yaml", "packages:\n  - packages/*\n  - tools/*\n"); assert.notEqual((await resolve(pnpm, "packages/client")).fingerprint, clientTarget.fingerprint, "changed workspace topology changes the fingerprint"); await write(pnpm, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    assert.equal(clientTarget.serviceDirectory, "packages/client", "selected runnable package identity remains distinct from the workspace root and unselected siblings");

    // npm, Yarn, Bun, Nx, Turbo and Lerna are all repository-owned workspace evidence.
    for (const [name, rootManifest, marker] of [
      ["npm", JSON.stringify({ private: true, workspaces: ["apps/*"] }), "package-lock.json"],
      ["yarn", JSON.stringify({ private: true, workspaces: ["apps/*"] }), "yarn.lock"],
      ["bun", JSON.stringify({ private: true, workspaces: ["apps/*"] }), "bun.lockb"],
      ["nx", JSON.stringify({ private: true, workspaces: ["apps/*"] }), "nx.json"],
      ["turbo", JSON.stringify({ private: true, workspaces: ["apps/*"] }), "turbo.json"],
      ["lerna", JSON.stringify({ private: true, workspaces: ["apps/*"] }), "lerna.json"],
    ] as const) {
      const fixture = join(root, name); await mkdir(fixture); await write(fixture, "package.json", rootManifest); await write(fixture, marker, marker === "lerna.json" ? JSON.stringify({ packages: ["apps/*"] }) : "{}"); await write(fixture, "apps/api/package.json", packageJson(`@${name}/api`)); await write(fixture, "apps/shared/package.json", packageJson(`@${name}/shared"`.replace('"', '')));
      const target = await resolve(fixture, "apps/api"); assert.equal(target.strategy, "workspace", `${name} declared workspace membership must retain the root build scope without a sibling dependency`); assert.equal(target.contract, "JS_WORKSPACE_MEMBER"); assert.equal(target.workspaceRoot, "."); assert.equal(target.buildRoot, "."); assert.equal(target.installRoot, "."); assert.equal(target.packageIdentity, `@${name}/api`); assert.equal(target.execution.packageTarget, `@${name}/api`);
    }
    const nested = join(root, "nested"); await mkdir(nested); await write(nested, "package.json", JSON.stringify({ private: true, workspaces: ["packages/*"] })); await write(nested, "packages/platform/package.json", JSON.stringify({ private: true, workspaces: ["apps/*"] })); await write(nested, "packages/platform/apps/web/package.json", packageJson("@nested/web"));
    assert.equal((await resolve(nested, "packages/platform/apps/web")).workspaceRoot, "packages/platform", "nearest nested workspace owns its member");
    const local = join(root, "local-path"); await mkdir(local); await write(local, "service/package.json", packageJson("local-service", { helper: "file:../helper" })); await write(local, "helper/package.json", packageJson("helper")); await assert.rejects(() => resolve(local, "service"), (error: unknown) => error instanceof BuildTargetResolutionError && error.code === "DG_DEPLOYMENT_CONTRACT_UNSUPPORTED");
    const cycle = join(root, "cycle"); await mkdir(cycle); await write(cycle, "package.json", JSON.stringify({ private: true, workspaces: ["packages/*"] })); await write(cycle, "packages/app/package.json", packageJson("app", { library: "workspace:*" })); await write(cycle, "packages/library/package.json", packageJson("library", { app: "workspace:*" })); assert.deepEqual((await resolve(cycle, "packages/app")).dependencyPaths, ["packages/library"], "dependency cycles are bounded and do not create another deployed service");
    const python = join(root, "python"); await mkdir(python); await write(python, "api/pyproject.toml", "[project]\nname = 'api'\n"); const pythonTarget = await resolve(python, "api"); assert.equal(pythonTarget.contract, "PYTHON_STANDALONE"); assert.equal(pythonTarget.strategy, "python_local"); await write(python, "api/requirements.txt", "-e ../shared\n"); await write(python, "shared/pyproject.toml", "[project]\nname = 'shared'\n"); await assert.rejects(() => resolve(python, "api"), (error: unknown) => error instanceof BuildTargetResolutionError && error.code === "DG_DEPLOYMENT_CONTRACT_UNSUPPORTED");
    for (const tool of ["poetry", "uv", "pdm", "pipenv"]) { const fixture = join(root, tool); await mkdir(fixture); if (tool === "pipenv") await write(fixture, "Pipfile", "[packages]\n"); else await write(fixture, "pyproject.toml", `[tool.${tool}]\n`); assert.equal((await resolve(fixture, ".")).contract, "PYTHON_STANDALONE"); }
    const duplicate = join(root, "duplicate"); await mkdir(duplicate); await write(duplicate, "package.json", JSON.stringify({ private: true, workspaces: ["packages/*"] })); await write(duplicate, "packages/a/package.json", packageJson("same")); await write(duplicate, "packages/b/package.json", packageJson("same")); await assert.rejects(() => resolve(duplicate, "packages/a"), (error: unknown) => error instanceof BuildTargetResolutionError && error.code === "DG_DEPLOYMENT_CONTRACT_UNSUPPORTED");
    const missing = join(root, "missing"); await mkdir(missing); await write(missing, "package.json", JSON.stringify({ private: true, workspaces: ["packages/*"] })); await write(missing, "packages/app/package.json", packageJson("app", { missing: "workspace:*" })); await assert.rejects(() => resolve(missing, "packages/app"), (error: unknown) => error instanceof BuildTargetResolutionError && error.code === "DG_DEPLOYMENT_CONTRACT_UNSUPPORTED");
    const uncertain = join(root, "uncertain"); await mkdir(uncertain); await write(uncertain, "pnpm-workspace.yaml", "packages: [\n"); await write(uncertain, "packages/app/package.json", packageJson("app")); await assert.rejects(() => resolve(uncertain, "packages/app"), (error: unknown) => error instanceof BuildTargetResolutionError && error.code === "DG_DEPLOYMENT_CONTRACT_UNSUPPORTED");
    for (const [name, manifest] of [["go", "go.mod"], ["java", "pom.xml"], ["php", "composer.json"], ["ruby", "Gemfile"]] as const) { const fixture = join(root, name); await mkdir(fixture); await write(fixture, manifest, "fixture"); await assert.rejects(() => resolve(fixture, "."), (error: unknown) => error instanceof BuildTargetResolutionError && error.code === "DG_DEPLOYMENT_CONTRACT_UNSUPPORTED"); }
    const multiServiceSource = new RepositorySourceService(resolver, {} as any) as any;
    await write(pnpm, "unsupported/go.mod", "module unsupported");
    multiServiceSource.checkout = async () => ({ workspacePath: pnpm, sourceSha: sha });
    multiServiceSource.cleanup = async () => undefined;
    await assert.rejects(
      () => multiServiceSource.resolveBuildTargetsAtExactSha({ repositoryUrl: "https://github.com/example/application", branch: "main", sourceSha: sha, services: [{ serviceId, serviceDirectory: "packages/client" }, { serviceId: "22222222-2222-4222-8222-222222222222", serviceDirectory: "unsupported" }] }),
      (error: unknown) => error instanceof BuildTargetResolutionError && error.code === "DG_DEPLOYMENT_CONTRACT_UNSUPPORTED",
      "one unsupported service blocks a multi-service source admission before a dispatch payload can exist",
    );
    await assert.rejects(() => resolve(pnpm, "packages/client", { buildRoot: "packages/client", selectedPackage: "@fixture/client" }), (error: unknown) => error instanceof BuildTargetResolutionError && error.code === "DG_DEPLOYMENT_CONTRACT_UNSUPPORTED");
    await symlink("/tmp", join(root, "escape")); await assert.rejects(() => resolve(root, "escape"), (error: unknown) => error instanceof BuildTargetResolutionError && error.code === "DG_BUILD_TARGET_INVALID");
    console.log("BUILD_TARGET_RESOLUTION=PASS SERVICE_AUTHORITY=USER_SELECTED BUILD_SCOPE_AUTHORITY=EXACT_SHA_CANONICAL");
  } finally { await rm(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
