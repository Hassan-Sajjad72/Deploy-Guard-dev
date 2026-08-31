import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(backendRoot, "..");

function filesUnder(directory, predicate) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path, predicate) : predicate(path) ? [path] : [];
  });
}

function decorators(node) {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : [];
}

function decoratorCall(node, names) {
  for (const decorator of decorators(node)) {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression) || !names.includes(expression.expression.text)) continue;
    return { name: expression.expression.text, args: expression.arguments };
  }
  return null;
}

function literalRoutes(argument) {
  if (!argument) return [""];
  if (ts.isStringLiteralLike(argument)) return [argument.text];
  if (ts.isArrayLiteralExpression(argument)) return argument.elements.filter(ts.isStringLiteralLike).map((item) => item.text);
  return [];
}

function joinRoute(base, route) {
  return `/${[base, route].filter(Boolean).join("/")}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

const controllerRoutes = [];
for (const file of filesUnder(join(backendRoot, "src"), (path) => path.endsWith(".controller.ts"))) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  source.forEachChild((node) => {
    if (!ts.isClassDeclaration(node)) return;
    const controller = decoratorCall(node, ["Controller"]);
    if (!controller) return;
    const bases = literalRoutes(controller.args[0]);
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const route = decoratorCall(member, ["Get", "Post", "Patch", "Put", "Delete"]);
      if (!route) continue;
      const suffixes = literalRoutes(route.args[0]);
      for (const base of bases) for (const suffix of suffixes) {
        controllerRoutes.push({ method: route.name.toUpperCase(), path: joinRoute(base, suffix), file });
      }
    }
  });
}

function expressionName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isCallExpression(expression) && expression.arguments[0]) return expressionName(expression.arguments[0]);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return "dynamic";
}

function apiPath(expression) {
  if (ts.isStringLiteralLike(expression)) return expression.text.split("?")[0];
  if (!ts.isTemplateExpression(expression)) return null;
  let path = expression.head.text;
  for (const span of expression.templateSpans) {
    if (ts.isConditionalExpression(span.expression) || expressionName(span.expression) === "query") break;
    path += `:${expressionName(span.expression)}`;
    path += span.literal.text;
  }
  return path.split("?")[0];
}

function enclosingFunctionName(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
    current = current.parent;
  }
  return "anonymous";
}

const frontendSourceRoot = join(root, "frontend", "src");
const frontendSources = filesUnder(frontendSourceRoot, (path) => /\.(?:js|jsx)$/.test(path));
const sourceByPath = new Map(frontendSources.map((file) => [file, ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.JS)]));

function resolveFrontendImport(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = extname(base) ? [base] : [base, `${base}.js`, `${base}.jsx`, join(base, "index.js"), join(base, "index.jsx")];
  return candidates.find((candidate) => sourceByPath.has(candidate)) || null;
}

const reachableFiles = new Set();
const queue = [join(frontendSourceRoot, "main.jsx")];
while (queue.length) {
  const file = queue.shift();
  if (!file || reachableFiles.has(file)) continue;
  reachableFiles.add(file);
  const source = sourceByPath.get(file);
  if (!source) continue;
  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const resolved = resolveFrontendImport(file, node.moduleSpecifier.text);
    if (resolved && !reachableFiles.has(resolved)) queue.push(resolved);
  });
}

const consumedApiFunctions = new Map();
for (const file of reachableFiles) {
  const source = sourceByPath.get(file);
  if (!source) continue;
  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const resolved = resolveFrontendImport(file, node.moduleSpecifier.text);
    if (!resolved || !resolved.includes(`${join("frontend", "src", "api")}/`) || !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) return;
    const names = consumedApiFunctions.get(resolved) || new Set();
    for (const element of node.importClause.namedBindings.elements) names.add((element.propertyName || element.name).text);
    consumedApiFunctions.set(resolved, names);
  });
}

const allFrontendRoutes = [];
for (const file of filesUnder(join(frontendSourceRoot, "api"), (path) => path.endsWith(".js") && !path.endsWith("client.js"))) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "apiRequest") {
      const path = node.arguments[0] ? apiPath(node.arguments[0]) : null;
      let method = "GET";
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) {
        const property = options.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(source) === "method");
        if (property && ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)) method = property.initializer.text.toUpperCase();
      }
      if (path) allFrontendRoutes.push({ method, path, functionName: enclosingFunctionName(node), file });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const frontendRoutes = allFrontendRoutes.filter(({ file, functionName }) => consumedApiFunctions.get(file)?.has(functionName));

const backendKeys = new Set(controllerRoutes.map(({ method, path }) => `${method} ${path}`));
const unreachableStale = allFrontendRoutes.filter(({ method, path, file, functionName }) => !backendKeys.has(`${method} ${path}`) && !consumedApiFunctions.get(file)?.has(functionName));
const missing = frontendRoutes.filter(({ method, path }) => !backendKeys.has(`${method} ${path}`));
assert.deepEqual(missing.map(({ method, path, functionName }) => `${functionName}: ${method} ${path}`), [], "Every real frontend API request must match the real NestJS controller method and parameter path");

// Execute representative real frontend functions. This capture is derived from
// the shipped client module, not a parallel hand-written request implementation.
globalThis.window = { location: { pathname: "/projects/contract", search: "" } };
const captured = [];
globalThis.fetch = async (url, options = {}) => {
  captured.push({ url: String(url), method: String(options.method || "GET").toUpperCase(), body: options.body ? JSON.parse(String(options.body)) : null });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
};
const frontendRoot = join(root, "frontend");
const { createServer } = await import(pathToFileURL(join(frontendRoot, "node_modules", "vite", "dist", "node", "index.js")).href);
const vite = await createServer({ root: frontendRoot, appType: "custom", server: { middlewareMode: true } });
const projectApi = await vite.ssrLoadModule("/src/api/projectApi.js");
const projectId = "11111111-1111-4111-8111-111111111111";
const serviceId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
await projectApi.createProject({ repositoryFullName: "owner/repository", targetBranch: "main", name: "repository", services: [{ name: "Web", serviceDirectory: "." }] });
await projectApi.updateProjectBranch(projectId, "release");
await projectApi.createProjectService(projectId, { name: "Worker", serviceDirectory: "worker" });
await projectApi.bulkUpsertProjectServiceEnvVars(projectId, serviceId, [{ key: "TOKEN", value: "opaque", isSecret: true, scope: "runtime" }]);
await projectApi.updateProjectDatabaseTier(projectId, { provider: "managed", engine: "mysql", persistenceEnabled: true, attachedServiceId: serviceId });
await projectApi.rollbackGithubActionsDeployment(projectId, operationId);
await projectApi.destroyGithubActionsDeployment(projectId, "DESTROY");
await projectApi.getGithubRepositoryDirectories("owner/repository", "main");
await vite.close();

function runtimeRouteMatches(template, actual) {
  const expectedParts = template.split("/");
  const actualParts = actual.split("/");
  return expectedParts.length === actualParts.length && expectedParts.every((part, index) => part.startsWith(":") || part === actualParts[index]);
}
for (const call of captured) {
  const path = new URL(call.url).pathname;
  assert.ok(controllerRoutes.some((route) => route.method === call.method && runtimeRouteMatches(route.path, path)), `Representative frontend call has no controller: ${call.method} ${path}`);
}
assert.deepEqual(captured[0].body, { repositoryFullName: "owner/repository", targetBranch: "main", name: "repository", services: [{ name: "Web", serviceDirectory: "." }] });
assert.deepEqual(captured[1].body, { targetBranch: "release" });
assert.deepEqual(captured[2].body, { name: "Worker", serviceDirectory: "worker" });
assert.deepEqual(captured[3].body, { variables: [{ key: "TOKEN", value: "opaque", isSecret: true, scope: "runtime" }] });
assert.deepEqual(captured[4].body, { provider: "managed", engine: "mysql", persistenceEnabled: true, attachedServiceId: serviceId });
assert.deepEqual(captured[5].body, { targetOperationId: operationId });
assert.deepEqual(captured[6].body, { confirmationPhrase: "DESTROY" });
assert.equal(new URL(captured[7].url).searchParams.get("ref"), "main");

const dtoContracts = [
  ["dto/create-project.dto.ts", ["repositoryFullName", "targetBranch", "name", "services"]],
  ["dto/update-branch.dto.ts", ["targetBranch"]],
  ["dto/deployable-service.dto.ts", ["name", "serviceDirectory"]],
  ["dto/bulk-env-vars.dto.ts", ["variables"]],
  ["dto/update-database-tier.dto.ts", ["provider", "engine", "persistenceEnabled", "attachedServiceId"]],
  ["dto/rollback-github-actions.dto.ts", ["targetOperationId"]],
  ["dto/destroy-github-actions.dto.ts", ["confirmationPhrase"]],
];
for (const [relative, fields] of dtoContracts) {
  const dto = readFileSync(join(backendRoot, "src", "projects", relative), "utf8");
  for (const field of fields) assert.match(dto, new RegExp(`\\b${field}\\??\\s*:`), `${relative} must accept the field sent by the real frontend client: ${field}`);
}

console.log(`API_CONTRACT_EQUIVALENCE=PASS FRONTEND_REQUESTS=${frontendRoutes.length} CONTROLLER_ROUTES=${controllerRoutes.length} REPRESENTATIVE_CALLS=${captured.length} UNREACHABLE_STALE_HELPERS=${unreachableStale.length}`);
