import { lstat, readFile, readdir, realpath } from "fs/promises";
import { extname, join, relative } from "path";

export const SERVICE_PORT_FAILURE = {
  unresolved: "DG_SERVICE_PORT_UNRESOLVED",
  conflict: "DG_SERVICE_PORT_CONFLICT",
  invalid: "DG_SERVICE_PORT_INVALID",
  localHostAllocation: "DG_LOCAL_HOST_PORT_ALLOCATION_FAILED",
} as const;

type Evidence = { priority: number; source: string; raw: string; port: number | null };
export type ResolvedServicePort = { serviceId: string; servicePort: number; evidence: { priority: number; source: string } };

export class ServicePortResolutionError extends Error {
  constructor(
    readonly code: typeof SERVICE_PORT_FAILURE[keyof typeof SERVICE_PORT_FAILURE],
    readonly serviceId: string,
    readonly evidence: Array<{ source: string; value?: string }>,
  ) {
    super(`${code}: DeployGuard could not resolve a canonical application port for service ${serviceId}.`);
    this.name = "ServicePortResolutionError";
  }

  get safeDetail() {
    const sources = this.evidence.map((item) => `${item.source}${item.value ? `=${item.value}` : ""}`).join(",");
    return `DG_FAILURE serviceId=${this.serviceId} code=${this.code} stage=service_port_resolution${sources ? ` evidence=${sources}` : ""}`;
  }
}

const SOURCE_EXTENSIONS = new Set([".cjs", ".go", ".java", ".js", ".jsx", ".mjs", ".php", ".py", ".rb", ".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set([".git", ".next", ".nuxt", ".output", ".venv", "__tests__", "build", "coverage", "dist", "e2e", "fixtures", "node_modules", "spec", "target", "test", "tests", "vendor"]);
const ENTRYPOINT_FILE = /^(?:api|app|application|asgi|index|main|manage|run|server|web|wsgi)\.(?:cjs|go|java|js|jsx|mjs|php|py|rb|ts|tsx)$/i;
const MAX_SOURCE_FILES = 1_000;
const MAX_FILE_BYTES = 256 * 1024;

function port(raw: string) {
  const value = raw.trim().replace(/^['"]|['"]$/g, "");
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : null;
}

function evidence(priority: number, source: string, raw: string): Evidence { return { priority, source, raw, port: port(raw) }; }

async function boundedRead(path: string) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.size > MAX_FILE_BYTES) return null;
    return await readFile(path, "utf8");
  } catch { return null; }
}

async function sourceFiles(root: string) {
  const files: string[] = [];
  const explicitEntrypoints = new Set<string>();
  const packageText = await boundedRead(join(root, "package.json"));
  if (packageText !== null) {
    try {
      const manifest = JSON.parse(packageText) as { main?: unknown; scripts?: { start?: unknown } };
      if (typeof manifest.main === "string") explicitEntrypoints.add(manifest.main.replace(/^\.\//, ""));
      if (typeof manifest.scripts?.start === "string") {
        for (const token of manifest.scripts.start.split(/\s+/).map((value) => value.replace(/^['"]|['",;]$/g, ""))) {
          if (SOURCE_EXTENSIONS.has(extname(token).toLowerCase()) && !token.startsWith("/") && !token.split("/").includes("..")) explicitEntrypoints.add(token.replace(/^\.\//, ""));
        }
      }
    } catch { /* Railpack owns package-manifest validation. */ }
  }
  const visit = async (directory: string) => {
    if (files.length >= MAX_SOURCE_FILES) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= MAX_SOURCE_FILES) return;
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(candidate);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase()) && !/\.(?:spec|test)\./i.test(entry.name)) {
        const repositoryPath = relative(root, candidate).replace(/\\/g, "/");
        if (ENTRYPOINT_FILE.test(entry.name) || explicitEntrypoints.has(repositoryPath)) files.push(candidate);
      }
    }
  };
  await visit(root);
  return files;
}

function matches(content: string, expression: RegExp, priority: number, source: string) {
  return [...content.matchAll(expression)].map((match) => evidence(priority, source, match[1]));
}

function concreteConfigurationMatches(content: string, expression: RegExp, priority: number, source: string) {
  return [...content.matchAll(expression)]
    .filter((match) => !/(?:process\.env|import\.meta\.env|\$\{|\$[A-Z_(]|\benv\s*\(|\bNumber\s*\()/i.test(match[1]))
    .map((match) => evidence(priority, source, match[1]));
}

async function configurationEvidence(root: string) {
  const found: Evidence[] = [];
  for (const filename of ["application.properties", "config/application.properties", "src/main/resources/application.properties"]) {
    const content = await boundedRead(join(root, filename));
    if (content !== null) found.push(...matches(content, /^\s*server\.port\s*[=:]\s*([^\s#]+)\s*$/gmi, 1, `${filename}:server.port`));
  }
  for (const filename of ["application.yml", "application.yaml", "config/application.yml", "config/application.yaml", "src/main/resources/application.yml", "src/main/resources/application.yaml"]) {
    const content = await boundedRead(join(root, filename));
    if (content !== null) found.push(...matches(content, /^server:\s*(?:\r?\n[ \t]+[^\r\n]+)*?\r?\n[ \t]+port:\s*([^\s#]+)\s*$/gmi, 1, `${filename}:server.port`));
  }
  for (const filename of ["vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.cjs", "nuxt.config.js", "nuxt.config.ts"]) {
    const content = await boundedRead(join(root, filename));
    if (content !== null) found.push(...concreteConfigurationMatches(content, /\bserver\s*:\s*\{[\s\S]{0,2000}?\bport\s*:\s*([^,}\s]+)/g, 1, `${filename}:server.port`));
  }
  const packageText = await boundedRead(join(root, "package.json"));
  if (packageText !== null) {
    try {
      const manifest = JSON.parse(packageText) as { config?: { port?: unknown } };
      if (manifest.config?.port !== undefined) found.push(evidence(1, "package.json:config.port", String(manifest.config.port)));
    } catch { /* Railpack remains responsible for malformed package manifests. */ }
  }
  return found;
}

async function bindingEvidence(root: string) {
  const found: Evidence[] = [];
  for (const filename of await sourceFiles(root)) {
    const content = await boundedRead(filename);
    if (content === null) continue;
    const source = relative(root, filename).replace(/\\/g, "/");
    for (const expression of [
      /(?:\bapp|\bserver|\bhttpServer)\.listen\s*\(\s*(?:process\.env\.[A-Z][A-Z0-9_]*\s*(?:\|\||\?\?)\s*)?(\d+)/g,
      /(?:\bapp|\bserver|\bhttpServer)\.listen\s*\(\s*["']([^"']+)["']/g,
      /\b(?:app|application)\.run\s*\([^)]*?\bport\s*=\s*(\d+)/g,
      /\b(?:app|application)\.run\s*\([^)]*?\bport\s*=\s*["']([^"']+)["']/g,
      /\buvicorn\.run\s*\([^)]*?\bport\s*=\s*(\d+)/g,
      /\bListenAndServe\s*\(\s*["'][^"']*:(\d+)["']/g,
    ]) found.push(...matches(content, expression, 2, `${source}:listen`));
    const constants = new Map<string, string>();
    for (const match of content.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Number\s*\(\s*)?(?:process\.env\.[A-Z][A-Z0-9_]*|process\.env\[["'][A-Z][A-Z0-9_]*["']\])\s*\)?\s*(?:\|\||\?\?)\s*(\d+)/g)) constants.set(match[1], match[2]);
    for (const match of content.matchAll(/(?:\bapp|\bserver|\bhttpServer)\.listen\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
      const value = constants.get(match[1]);
      if (value) found.push(evidence(2, `${source}:listen:${match[1]}`, value));
    }
  }
  return found;
}

function commandPort(command: string, source: string) {
  return matches(command, /(?:^|\s)(?:--port(?:=|\s+)|-p\s+)([^\s]+)/g, 3, source);
}

async function startCommandEvidence(root: string) {
  const found: Evidence[] = [];
  const packageText = await boundedRead(join(root, "package.json"));
  if (packageText !== null) {
    try {
      const manifest = JSON.parse(packageText) as { scripts?: { start?: unknown } };
      if (typeof manifest.scripts?.start === "string") found.push(...commandPort(manifest.scripts.start, "package.json:scripts.start"));
    } catch { /* Railpack owns package-manifest validation. */ }
  }
  const procfile = await boundedRead(join(root, "Procfile"));
  const web = procfile?.match(/^web:\s*(.+)$/mi)?.[1];
  if (web) found.push(...commandPort(web, "Procfile:web"));
  return found;
}

async function environmentEvidence(root: string) {
  const found: Evidence[] = [];
  for (const filename of [".env", ".env.production", ".env.deploy", "config/.env", "config/.env.production"]) {
    const content = await boundedRead(join(root, filename));
    if (content === null) continue;
    found.push(...concreteConfigurationMatches(content, /^\s*(?:PORT|SERVER_PORT|FLASK_RUN_PORT|UVICORN_PORT)\s*=\s*([^\s#]+)\s*$/gmi, 4, `${filename}:PORT`));
  }
  return found;
}

async function frameworkDefaultEvidence(root: string) {
  const found: Evidence[] = [];
  const packageText = await boundedRead(join(root, "package.json"));
  if (packageText !== null) {
    try {
      const manifest = JSON.parse(packageText) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      const dependencies = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
      for (const [framework, defaultPort] of [["next", 3000], ["@nestjs/core", 3000], ["nuxt", 3000], ["vite", 5173], ["react-scripts", 3000]] as const) {
        if (framework in dependencies) found.push(evidence(5, `package.json:framework:${framework}`, String(defaultPort)));
      }
    } catch { /* Railpack owns package-manifest validation. */ }
  }
  const python = [await boundedRead(join(root, "requirements.txt")), await boundedRead(join(root, "pyproject.toml"))].filter((value): value is string => value !== null).join("\n");
  for (const [framework, expression, defaultPort] of [["django", /(?:^|\n)\s*django(?:[=<>~!]|\s|$)/i, 8000], ["flask", /(?:^|\n)\s*flask(?:[=<>~!]|\s|$)/i, 5000], ["fastapi", /(?:^|\n)\s*fastapi(?:[=<>~!]|\s|$)/i, 8000]] as const) {
    if (expression.test(python)) found.push(evidence(5, `python:framework:${framework}`, String(defaultPort)));
  }
  const java = [await boundedRead(join(root, "pom.xml")), await boundedRead(join(root, "build.gradle")), await boundedRead(join(root, "build.gradle.kts"))].filter((value): value is string => value !== null).join("\n");
  if (/spring-boot/i.test(java)) found.push(evidence(5, "java:framework:spring-boot", "8080"));
  const gemfile = await boundedRead(join(root, "Gemfile"));
  if (gemfile && /gem\s+["']rails["']/.test(gemfile)) found.push(evidence(5, "ruby:framework:rails", "3000"));
  return found;
}

export async function resolveServicePort(serviceId: string, serviceRoot: string): Promise<ResolvedServicePort> {
  const levels = [configurationEvidence, bindingEvidence, startCommandEvidence, environmentEvidence, frameworkDefaultEvidence];
  for (const collect of levels) {
    const found = await collect(serviceRoot);
    if (!found.length) continue;
    const invalid = found.filter((item) => item.port === null);
    if (invalid.length) throw new ServicePortResolutionError(SERVICE_PORT_FAILURE.invalid, serviceId, invalid.map((item) => ({ source: item.source, value: item.raw.slice(0, 80) })));
    const values = [...new Set(found.map((item) => item.port!))];
    if (values.length > 1) throw new ServicePortResolutionError(SERVICE_PORT_FAILURE.conflict, serviceId, found.map((item) => ({ source: item.source, value: String(item.port) })));
    return { serviceId, servicePort: values[0], evidence: { priority: found[0].priority, source: found.map((item) => item.source).sort().join(",") } };
  }
  throw new ServicePortResolutionError(SERVICE_PORT_FAILURE.unresolved, serviceId, []);
}

export async function resolveServicePorts(workspaceRoot: string, services: Array<{ serviceId: string; serviceDirectory: string }>) {
  const root = await realpath(workspaceRoot);
  const results: ResolvedServicePort[] = [];
  for (const service of services) {
    const candidate = service.serviceDirectory === "." ? root : join(root, ...service.serviceDirectory.split("/"));
    const serviceRoot = await realpath(candidate);
    if (serviceRoot !== root && !serviceRoot.startsWith(`${root}/`)) throw new Error("Service directory escapes the repository root.");
    results.push(await resolveServicePort(service.serviceId, serviceRoot));
  }
  return results;
}
