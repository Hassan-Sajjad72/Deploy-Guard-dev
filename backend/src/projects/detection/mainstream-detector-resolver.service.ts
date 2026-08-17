import { Injectable } from "@nestjs/common";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  ExtractedRepositoryFacts,
  FrameworkDetector,
  FrameworkDetectorResult,
  PartialDetectorBuildPlan,
} from "./framework-detector";
import { PythonAstInspector } from "./python-ast-inspector";
import { deriveWebpackOutputDirectory } from "./webpack-output";

const CONFIG_FILES = [
  "next.config.js", "next.config.mjs", "next.config.cjs", "next.config.ts",
  "vite.config.js", "vite.config.mjs", "vite.config.ts", "vite.config.cjs",
  "webpack.config.js", "webpack.config.cjs", "webpack.config.mjs", "webpack.config.ts",
  "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.ts",
  "svelte.config.js", "svelte.config.mjs", "svelte.config.ts",
  "astro.config.js", "astro.config.mjs", "astro.config.ts",
  "remix.config.js", "remix.config.mjs", "remix.config.ts",
  "angular.json", "nest-cli.json", "Dockerfile", ".nvmrc", ".node-version",
  ".python-version", "runtime.txt", "pyproject.toml", "requirements.txt", "Pipfile",
  "server.js", "server.ts", "app.js", "app.ts", "index.js", "index.ts", "src/main.ts", "src/app.ts",
];

const nodeStatic = (template: string, packageManager: string, outputDirectory: string): PartialDetectorBuildPlan => ({
  runtimeType: "static", packageManager, runtimeVersion: "22", buildCommand: script(packageManager, "build"),
  baseImage: "node:22-alpine3.21", runtimeImage: "nginxinc/nginx-unprivileged:1.27-alpine",
  releaseCommand: null, runCommand: null, outputDirectory, runtimeFiles: [outputDirectory], port: 8080,
  bindHost: "0.0.0.0", bindsToPortEnv: true, dockerTemplate: template,
  buildSystemDependencies: [], runtimeSystemDependencies: [],
});

const nodeWeb = (template: string, packageManager: string, runCommand: string | null, port = 3000): PartialDetectorBuildPlan => ({
  runtimeType: "server", packageManager, runtimeVersion: "22", buildCommand: null,
  baseImage: "node:22-alpine3.21", runtimeImage: "node:22-alpine3.21",
  releaseCommand: null, runCommand, outputDirectory: null, runtimeFiles: [], port,
  bindHost: "0.0.0.0", bindsToPortEnv: true, dockerTemplate: template,
  buildSystemDependencies: [], runtimeSystemDependencies: [],
});

function script(manager: string, name: string) {
  return `${["yarn", "pnpm"].includes(manager) ? `corepack ${manager}` : manager} run ${name}`;
}

function evidence(source: string, description: string) {
  return { source, description };
}

function result(
  detectorId: string,
  framework: string,
  frameworkMode: string,
  confidence: number,
  detectorEvidence: Array<{ source: string; description: string }>,
  partialBuildPlan: PartialDetectorBuildPlan,
  warnings: string[] = [],
  requiredUserInputs: string[] = [],
  unsupportedReasons: string[] = [],
  language: "javascript" | "python" = "javascript",
): FrameworkDetectorResult {
  return { detectorId, language, framework, frameworkMode, confidence, evidence: detectorEvidence, partialBuildPlan, warnings, requiredUserInputs, unsupportedReasons };
}

function dependency(facts: ExtractedRepositoryFacts, name: string) {
  return Object.prototype.hasOwnProperty.call(facts.dependencies, name);
}

function combined(facts: ExtractedRepositoryFacts, names: string[]) {
  return names.map((name) => facts.textFiles[name] || "").join("\n");
}

function packageManager(facts: ExtractedRepositoryFacts) {
  const declared = String(facts.packageJson?.packageManager || "").match(/^(npm|yarn|pnpm|bun)(?:@|$)/)?.[1];
  if (declared) return declared;
  if (facts.files.has("pnpm-lock.yaml")) return "pnpm";
  if (facts.files.has("yarn.lock")) return "yarn";
  if (facts.files.has("bun.lock") || facts.files.has("bun.lockb")) return "bun";
  return "npm";
}

function nodeVersion(facts: ExtractedRepositoryFacts) {
  const raw = String(facts.textFiles[".nvmrc"] || facts.textFiles[".node-version"] || facts.packageJson?.volta?.node || facts.packageJson?.engines?.node || "22");
  const major = Number(raw.match(/(?:^|[^0-9])(18|20|22)(?:[^0-9]|$)/)?.[1] || 22);
  return String(major);
}

function pythonVersion(facts: ExtractedRepositoryFacts) {
  const raw = facts.textFiles[".python-version"] || facts.textFiles["runtime.txt"] || facts.textFiles["pyproject.toml"].match(/requires-python\s*=\s*["']([^"']+)/i)?.[1] || "3.11";
  return raw.match(/3\.(10|11|12|13)/)?.[0] || "3.11";
}

function nodeDependencies(facts: ExtractedRepositoryFacts) {
  const names = Object.keys(facts.dependencies);
  const build: string[] = [];
  const runtime: string[] = [];
  if (names.includes("canvas")) build.push("build-base", "cairo-dev", "jpeg-dev", "pango-dev");
  if (names.includes("sharp")) runtime.push("vips");
  if (names.some((name) => name === "prisma" || name === "@prisma/client")) runtime.push("openssl");
  if (names.some((name) => /puppeteer/.test(name))) runtime.push("chromium", "nss");
  return { build: [...new Set(build)], runtime: [...new Set(runtime)] };
}

function pythonDependencies(facts: ExtractedRepositoryFacts) {
  const text = facts.dependencyText.toLowerCase();
  const build: string[] = [];
  const runtime: string[] = [];
  if (/psycopg|psycopg2/.test(text)) { build.push("libpq-dev", "gcc"); runtime.push("libpq5"); }
  if (/mysqlclient/.test(text)) { build.push("default-libmysqlclient-dev", "gcc"); runtime.push("libmariadb3"); }
  if (/pillow/.test(text)) { build.push("libjpeg-dev", "zlib1g-dev"); runtime.push("libjpeg62-turbo", "zlib1g"); }
  if (/lxml/.test(text)) { build.push("libxml2-dev", "libxslt1-dev"); runtime.push("libxml2", "libxslt1.1"); }
  if (/cryptography/.test(text)) { build.push("libssl-dev", "libffi-dev", "gcc"); runtime.push("libssl3", "libffi8"); }
  return { build: [...new Set(build)], runtime: [...new Set(runtime)] };
}

function withNodeFacts(plan: PartialDetectorBuildPlan, facts: ExtractedRepositoryFacts) {
  const deps = nodeDependencies(facts);
  const version = nodeVersion(facts);
  return { ...plan, runtimeVersion: version, baseImage: `node:${version}-alpine3.21`, runtimeImage: plan.runtimeType === "static" ? plan.runtimeImage : `node:${version}-alpine3.21`, buildSystemDependencies: deps.build, runtimeSystemDependencies: deps.runtime };
}

function withPythonFacts(plan: PartialDetectorBuildPlan, facts: ExtractedRepositoryFacts) {
  const deps = pythonDependencies(facts);
  const version = pythonVersion(facts);
  return { ...plan, runtimeVersion: version, baseImage: `python:${version}-slim`, runtimeImage: `python:${version}-slim`, buildSystemDependencies: deps.build, runtimeSystemDependencies: deps.runtime };
}

const detectors: FrameworkDetector[] = [
  {
    id: "javascript.nextjs", priority: 1000,
    detect(facts) {
      if (!dependency(facts, "next")) return null;
      const manager = packageManager(facts);
      const config = combined(facts, ["next.config.js", "next.config.mjs", "next.config.cjs", "next.config.ts"]);
      const scripts = Object.values(facts.scripts).map(String).join("\n");
      const baseEvidence = [evidence("package.json", "next dependency and production scripts")];
      if (/output\s*:\s*["']export["']|\bnext\s+export\b/.test(`${config}\n${scripts}`)) {
        const plan = withNodeFacts(nodeStatic("nextjs-static", manager, "out"), facts);
        return result(this.id, "nextjs", "nextjs-static", 0.99, [...baseEvidence, evidence("next.config.*", "static export output")], plan);
      }
      if (/output\s*:\s*["']standalone["']/.test(config)) {
        const plan = withNodeFacts(nodeWeb("nextjs-standalone", manager, "HOSTNAME=0.0.0.0 PORT=${PORT:-3000} node .next/standalone/server.js"), facts);
        plan.buildCommand = script(manager, "build"); plan.runtimeFiles = [".next/standalone", ".next/static", "public"];
        return result(this.id, "nextjs", "nextjs-standalone", 0.99, [...baseEvidence, evidence("next.config.*", "output: standalone")], plan);
      }
      const plan = withNodeFacts(nodeWeb("nextjs-ssr", manager, `${script(manager, "start")} -- -H 0.0.0.0 -p ${'${PORT:-3000}'}`), facts);
      plan.buildCommand = script(manager, "build"); plan.runtimeFiles = [".next", "public", "package.json"];
      return result(this.id, "nextjs", "nextjs-ssr", 0.96, baseEvidence, plan);
    },
  },
  {
    id: "javascript.nuxt", priority: 950,
    detect(facts) {
      if (!dependency(facts, "nuxt")) return null;
      const manager = packageManager(facts); const config = combined(facts, ["nuxt.config.js", "nuxt.config.mjs", "nuxt.config.ts"]); const scripts = Object.values(facts.scripts).map(String).join("\n");
      const base = [evidence("package.json", "nuxt dependency"), evidence("nuxt.config.*", "Nuxt runtime configuration")];
      if (/\b(?:nuxi|nuxt)\s+generate\b|nitro\s*:\s*\{[\s\S]*?preset\s*:\s*["']static/.test(`${scripts}\n${config}`)) {
        const plan = withNodeFacts(nodeStatic("nuxt-static", manager, ".output/public"), facts);
        return result(this.id, "nuxt", "nuxt-static", 0.97, base, plan);
      }
      if (/preset\s*:\s*["'](?:cloudflare|vercel|netlify|deno|bun)/.test(config)) {
        const plan = withNodeFacts(nodeWeb("nuxt-ssr", manager, null), facts);
        return result(this.id, "nuxt", "nuxt-unsupported-adapter", 0.99, base, plan, [], [], ["Nuxt provider/edge preset is incompatible with the ECS Node runtime."]);
      }
      const plan = withNodeFacts(nodeWeb("nuxt-ssr", manager, "HOST=0.0.0.0 PORT=${PORT:-3000} node .output/server/index.mjs"), facts);
      plan.buildCommand = script(manager, "build"); plan.runtimeFiles = [".output"];
      return result(this.id, "nuxt", "nuxt-ssr", 0.94, base, plan);
    },
  },
  {
    id: "javascript.sveltekit", priority: 940,
    detect(facts) {
      if (!dependency(facts, "@sveltejs/kit")) return null;
      const manager = packageManager(facts); const config = combined(facts, ["svelte.config.js", "svelte.config.mjs", "svelte.config.ts"]); const ev = [evidence("package.json", "@sveltejs/kit dependency"), evidence("svelte.config.*", "configured SvelteKit adapter")];
      if (/adapter-static/.test(config)) return result(this.id, "sveltekit", "sveltekit-static", 0.99, ev, withNodeFacts(nodeStatic("sveltekit-static", manager, "build"), facts));
      if (/adapter-node/.test(config)) { const plan = withNodeFacts(nodeWeb("sveltekit-node", manager, "HOST=0.0.0.0 PORT=${PORT:-3000} node build"), facts); plan.buildCommand = script(manager, "build"); plan.runtimeFiles = ["build"]; return result(this.id, "sveltekit", "sveltekit-node", 0.99, ev, plan); }
      const plan = withNodeFacts(nodeWeb("sveltekit-node", manager, null), facts);
      return result(this.id, "sveltekit", "sveltekit-unsupported-adapter", 0.9, ev, plan, [], ["SVELTEKIT_ADAPTER"], ["SvelteKit adapter is missing, unknown, edge, or provider-specific."]);
    },
  },
  {
    id: "javascript.astro", priority: 930,
    detect(facts) {
      if (!dependency(facts, "astro")) return null;
      const manager = packageManager(facts); const config = combined(facts, ["astro.config.js", "astro.config.mjs", "astro.config.ts"]); const ev = [evidence("package.json", "astro dependency"), evidence("astro.config.*", "Astro output and adapter configuration")];
      if (/output\s*:\s*["'](?:server|hybrid)["']/.test(config)) {
        if (!/@astrojs\/node|adapter\s*:\s*node\s*\(/.test(config)) { const plan = withNodeFacts(nodeWeb("astro-node", manager, null), facts); return result(this.id, "astro", "astro-unsupported-adapter", 0.96, ev, plan, [], ["ASTRO_NODE_ADAPTER"], ["Astro SSR requires the supported @astrojs/node standalone adapter; edge/serverless adapters cannot run on ECS."]); }
        const plan = withNodeFacts(nodeWeb("astro-node", manager, "HOST=0.0.0.0 PORT=${PORT:-3000} node dist/server/entry.mjs"), facts); plan.buildCommand = script(manager, "build"); plan.runtimeFiles = ["dist"];
        return result(this.id, "astro", "astro-node", 0.99, ev, plan);
      }
      return result(this.id, "astro", "astro-static", 0.96, ev, withNodeFacts(nodeStatic("astro-static", manager, "dist"), facts));
    },
  },
  {
    id: "javascript.remix", priority: 920,
    detect(facts) {
      if (!Object.keys(facts.dependencies).some((name) => name.startsWith("@remix-run/"))) return null;
      const manager = packageManager(facts); const config = combined(facts, ["remix.config.js", "remix.config.mjs", "remix.config.ts"]); const deps = Object.keys(facts.dependencies).join(" "); const ev = [evidence("package.json", "@remix-run dependencies and build/start scripts")];
      if (/cloudflare|deno|architect|vercel/.test(`${deps}\n${config}`)) { const plan = withNodeFacts(nodeWeb("remix-node", manager, null), facts); return result(this.id, "remix", "remix-unsupported-runtime", 0.98, ev, plan, [], [], ["Remix provider-specific edge/serverless runtime is incompatible with ECS."]); }
      const start = facts.scripts.start ? `HOST=0.0.0.0 PORT=${'${PORT:-3000}'} ${script(manager, "start")}` : dependency(facts, "@remix-run/serve") ? `HOST=0.0.0.0 PORT=${'${PORT:-3000}'} ${manager === "npm" ? "npx" : manager} remix-serve build/server/index.js` : null;
      const plan = withNodeFacts(nodeWeb("remix-node", manager, start), facts); plan.buildCommand = facts.scripts.build ? script(manager, "build") : null; plan.runtimeFiles = ["build", "public"];
      return result(this.id, "remix", "remix-node", start && plan.buildCommand ? 0.94 : 0.8, ev, plan, [], start ? [] : ["REMIX_START_COMMAND"]);
    },
  },
  {
    id: "javascript.angular", priority: 910,
    detect(facts) {
      if (!dependency(facts, "@angular/core") || !facts.files.has("angular.json")) return null;
      const manager = packageManager(facts); let output: string | null = null; let project: string | null = null;
      try { const angular = JSON.parse(facts.textFiles["angular.json"]); project = angular.defaultProject || Object.keys(angular.projects || {}).sort()[0] || null; const options = project ? angular.projects?.[project]?.architect?.build?.options || angular.projects?.[project]?.targets?.build?.options : null; const raw = options?.outputPath; output = typeof raw === "string" ? raw : raw?.base ? `${raw.base}${raw.browser ? `/${raw.browser}` : ""}` : null; } catch { /* exact unsupported evidence below */ }
      const ev = [evidence("angular.json", `Angular application project ${project || "could not be selected"}`), evidence("package.json", "@angular/core dependency and Angular CLI scripts")];
      const plan = withNodeFacts(nodeStatic("angular-static", manager, output || ""), facts);
      return result(this.id, "angular", "angular-static", output ? 0.98 : 0.75, ev, plan, [], output ? [] : ["ANGULAR_OUTPUT_PATH"], output ? [] : ["Angular outputPath could not be derived from angular.json."]);
    },
  },
  {
    id: "javascript.react-native", priority: 905,
    detect(facts) {
      if (!dependency(facts, "react-native") || !dependency(facts, "react")) return null;
      const manager = packageManager(facts); const plan = withNodeFacts(nodeWeb("custom-dockerfile-required", manager, null), facts); plan.port = 0;
      return result(this.id, "react-native", "react-native-mobile", 0.99, [evidence("package.json", "react-native mobile dependency")], plan, [], [], ["React Native mobile applications do not expose an ECS/ALB HTTP web target."]);
    },
  },
  {
    id: "javascript.create-react-app", priority: 900,
    detect(facts) { if (!dependency(facts, "react") || !dependency(facts, "react-scripts")) return null; const manager = packageManager(facts); return result(this.id, "create-react-app", "cra-static", 0.99, [evidence("package.json", "react and react-scripts dependencies with build script")], withNodeFacts(nodeStatic("cra-static", manager, "build"), facts)); },
  },
  {
    id: "javascript.react-webpack", priority: 895,
    detect(facts) {
      if (!dependency(facts, "react") || dependency(facts, "react-native")) return null;
      const webpackConfigNames = ["webpack.config.js", "webpack.config.cjs", "webpack.config.mjs", "webpack.config.ts"];
      const config = combined(facts, webpackConfigNames);
      const buildScript = String(facts.scripts.build || "");
      if (!dependency(facts, "webpack") && !config.trim() && !/\bwebpack\b/.test(buildScript)) return null;
      const manager = packageManager(facts);
      const output = deriveWebpackOutputDirectory(config);
      const hasProductionBuild = /(?:^|[\s/])(?:webpack|webpack-cli)(?:\s|$)/.test(buildScript) && !/webpack-dev-server/.test(buildScript);
      const plan = withNodeFacts(nodeStatic("react-webpack-static", manager, output || ""), facts);
      if (!hasProductionBuild) plan.buildCommand = null;
      const required = [
        ...(!hasProductionBuild ? ["PRODUCTION_BUILD_COMMAND"] : []),
        ...(!output ? ["OUTPUT_DIRECTORY"] : []),
      ];
      const detectorEvidence = [
        evidence("package.json", "React web dependency and Webpack build tooling"),
        ...(hasProductionBuild ? [evidence("package.json#scripts.build", `production build command: ${buildScript}`)] : []),
        ...(output ? [evidence("webpack.config.*#output.path", `static output directory: ${output}`)] : []),
      ];
      return result(this.id, "react", "react-webpack-static", output && hasProductionBuild ? 0.97 : 0.78, detectorEvidence, plan, [], required);
    },
  },
  {
    id: "javascript.vite-react", priority: 890,
    detect(facts) { if (!dependency(facts, "react") || !dependency(facts, "vite")) return null; const manager = packageManager(facts); const buildEvidence = Object.values(facts.scripts).some((value) => /\bvite\s+build\b/.test(String(value))) || Object.keys(facts.textFiles).some((name) => name.startsWith("vite.config") && facts.textFiles[name]); return result(this.id, "vite-react", "vite-static", buildEvidence ? 0.98 : 0.8, [evidence("package.json", `react and vite dependencies${buildEvidence ? " with Vite build evidence" : ""}`)], withNodeFacts(nodeStatic("vite-static", manager, "dist"), facts), [], buildEvidence ? [] : ["VITE_BUILD_CONFIGURATION"], buildEvidence ? [] : ["Vite production build script or configuration could not be proven."]); },
  },
  {
    id: "javascript.vite-vue", priority: 880,
    detect(facts) { if (!dependency(facts, "vue") || !dependency(facts, "vite")) return null; const manager = packageManager(facts); return result(this.id, "vite-vue", "vite-vue-static", 0.98, [evidence("package.json", "vue and vite dependencies")], withNodeFacts(nodeStatic("vite-vue-static", manager, "dist"), facts)); },
  },
  {
    id: "javascript.react-static", priority: 100,
    detect(facts) {
      if (!dependency(facts, "react")) return null;
      const manager = packageManager(facts); const buildScript = String(facts.scripts.build || "");
      const hasProductionBuild = Boolean(buildScript) && !/\b(?:webpack-dev-server|vite\s+dev|react-scripts\s+start)\b/.test(buildScript);
      const plan = withNodeFacts(nodeStatic("react-static", manager, ""), facts);
      if (!hasProductionBuild) plan.buildCommand = null;
      return result(this.id, "react", "react-static", hasProductionBuild ? 0.76 : 0.7, [evidence("package.json", `React web dependency${hasProductionBuild ? " with a production build script" : ""}`)], plan, [], [...(!hasProductionBuild ? ["PRODUCTION_BUILD_COMMAND"] : []), "OUTPUT_DIRECTORY"]);
    },
  },
  {
    id: "javascript.vite-unsupported", priority: 90,
    detect(facts) {
      if (!dependency(facts, "vite")) return null;
      const manager = packageManager(facts); const plan = withNodeFacts(nodeStatic("generic-node", manager, "dist"), facts);
      return result(this.id, "unknown", "unsupported-vite-framework", 0.72, [evidence("package.json", "Vite dependency without recognized web framework evidence")], plan, [], ["VITE_FRAMEWORK"], ["The Vite web framework could not be identified safely."]);
    },
  },
  {
    id: "javascript.nestjs", priority: 800,
    detect(facts) { if (!dependency(facts, "@nestjs/core")) return null; const manager = packageManager(facts); const plan = withNodeFacts(nodeWeb("nestjs-server", manager, facts.scripts["start:prod"] ? script(manager, "start:prod") : "node dist/main.js"), facts); plan.buildCommand = script(manager, "build"); plan.runtimeFiles = ["dist"]; return result(this.id, "nestjs", "nestjs-server", facts.files.has("nest-cli.json") ? 0.99 : 0.94, [evidence("package.json", "@nestjs/core and production scripts"), ...(facts.files.has("nest-cli.json") ? [evidence("nest-cli.json", "Nest CLI project configuration")] : [])], plan); },
  },
  ...["fastify", "express"].map((framework, offset): FrameworkDetector => ({
    id: `javascript.${framework}`, priority: 790 - offset,
    detect(facts) {
      if (!dependency(facts, framework)) return null;
      const manager = packageManager(facts); const sources = combined(facts, ["server.js", "server.ts", "app.js", "app.ts", "index.js", "index.ts", "src/main.ts", "src/app.ts"]); const entry = ["server.js", "app.js", "index.js"].find((name) => facts.files.has(name));
      const executable = framework === "fastify" ? /(?:Fastify|fastify)\s*\(|\.listen\s*\(/.test(sources) : /express\s*\(|app\.listen\s*\(|server\.listen\s*\(/.test(sources);
      const run = facts.scripts.start ? script(manager, "start") : entry ? `node ${entry}` : null; const plan = withNodeFacts(nodeWeb(`${framework}-server`, manager, run), facts); if (facts.scripts.build) { plan.buildCommand = script(manager, "build"); plan.runtimeFiles = ["dist"]; }
      return result(this.id, framework, `${framework}-server`, executable && run ? 0.96 : 0.78, [evidence("package.json", `${framework} dependency`), ...(executable ? [evidence("server source", `${framework} construction and listen evidence`)] : [])], plan, [], run ? [] : ["EXECUTABLE_ENTRYPOINT"]);
    },
  })),
  ...["django", "fastapi", "flask", "streamlit"].map((framework, offset): FrameworkDetector => ({
    id: `python.${framework}`, priority: 700 - offset,
    detect(facts) {
      const lower = facts.dependencyText.toLowerCase(); if (!lower.includes(framework)) return null;
      const manager = facts.files.has("Pipfile") ? "pipenv" : /\[tool\.poetry\]/.test(facts.textFiles["pyproject.toml"]) ? "poetry" : "pip";
      const deps = pythonDependencies(facts); const resolvedPython = pythonVersion(facts); const base: PartialDetectorBuildPlan = { runtimeType: "server", packageManager: manager, runtimeVersion: resolvedPython, baseImage: `python:${resolvedPython}-slim`, runtimeImage: `python:${resolvedPython}-slim`, buildCommand: null, releaseCommand: null, runCommand: null, outputDirectory: null, runtimeFiles: ["."], port: framework === "flask" ? 5000 : 8000, bindHost: "0.0.0.0", bindsToPortEnv: true, dockerTemplate: `${framework}-${framework === "fastapi" ? "asgi" : framework === "django" ? "wsgi" : framework === "flask" ? "wsgi" : "server"}`, buildSystemDependencies: deps.build, runtimeSystemDependencies: deps.runtime };
      const ev = [evidence("Python dependency manifest", `${framework} dependency`)];
      if (framework === "flask" || framework === "fastapi") {
        const constructor = framework === "flask" ? "Flask" : "FastAPI"; const module = facts.pythonModules.find((item) => item.assignments.some((assignment) => assignment.constructor === constructor) || item.functions.some((fn) => fn.returnsConstructor === constructor)); const assignment = module?.assignments.find((item) => item.constructor === constructor); const factory = module?.functions.find((item) => item.returnsConstructor === constructor && ["create_app", "make_app"].includes(item.name));
        if (module && (assignment || factory)) { ev.push(evidence(module.file, factory ? `${factory.name} application factory found by safe structural AST parsing` : `${assignment!.name} application object found by safe structural AST parsing`)); base.runCommand = framework === "flask" ? `gunicorn '${module.module}:${factory ? `${factory.name}()` : assignment!.name}' --bind 0.0.0.0:${'${PORT:-5000}'}` : `uvicorn ${module.module}:${factory ? factory.name : assignment!.name}${factory ? " --factory" : ""} --host 0.0.0.0 --port ${'${PORT:-8000}'}`; }
        return result(this.id, framework, framework === "flask" ? "flask-wsgi" : "fastapi-asgi", module ? 0.99 : 0.75, ev, base, [], base.runCommand ? [] : ["PYTHON_APPLICATION_TARGET"], base.runCommand ? [] : [`${framework} application object or factory could not be proven by safe AST inspection.`], "python");
      }
      if (framework === "django") { const wsgi = facts.pythonModules.find((item) => /(?:^|\/)wsgi\.py$/.test(item.file)); const asgi = facts.pythonModules.find((item) => /(?:^|\/)asgi\.py$/.test(item.file)); const target = wsgi || asgi; if (target) { const projectModule = target.module.replace(/\.(?:wsgi|asgi)$/, ""); base.dockerTemplate = wsgi ? "django-wsgi" : "django-asgi"; base.runCommand = wsgi ? `gunicorn ${wsgi.module}:application --bind 0.0.0.0:${'${PORT:-8000}'}` : `uvicorn ${asgi!.module}:application --host 0.0.0.0 --port ${'${PORT:-8000}'}`; base.releaseCommand = "python manage.py migrate --noinput"; base.buildCommand = "python manage.py collectstatic --noinput"; base.runtimeFiles = [projectModule, "manage.py", "staticfiles"]; ev.push(evidence(target.file, `${wsgi ? "WSGI" : "ASGI"} application module`)); } return result(this.id, "django", wsgi ? "django-wsgi" : "django-asgi", target ? 0.99 : 0.76, ev, base, [], target ? [] : ["DJANGO_APPLICATION_MODULE"], target ? [] : ["Django wsgi.py or asgi.py could not be derived."], "python"); }
      const streamlitFile = facts.pythonModules.find((item) => /(?:^|\/)(?:app|main|server)\.py$/.test(item.file)); if (streamlitFile) { base.runCommand = `streamlit run ${streamlitFile.file} --server.address 0.0.0.0 --server.port ${'${PORT:-8000}'}`; base.port = 8000; }
      return result(this.id, "streamlit", "streamlit-server", streamlitFile ? 0.96 : 0.75, ev, base, [], streamlitFile ? [] : ["STREAMLIT_ENTRYPOINT"], [], "python");
    },
  })),
];

@Injectable()
export class MainstreamDetectorResolverService {
  private readonly pythonAst = new PythonAstInspector();
  readonly detectors = [...detectors].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));

  resolve(appPath: string, files: Set<string>) {
    const facts = this.extract(appPath, files);
    const matches = this.detectors.map((detector) => ({ detector, result: detector.detect(facts) })).filter((item): item is { detector: FrameworkDetector; result: FrameworkDetectorResult } => Boolean(item.result));
    if (!matches.length) return { facts, result: null, ambiguous: [] as string[] };
    const selected = matches[0];
    const selectedResult: FrameworkDetectorResult = {
      ...selected.result,
      requiredUserInputs: [...selected.result.requiredUserInputs],
      unsupportedReasons: [...selected.result.unsupportedReasons],
    };
    if (selectedResult.language === "javascript") {
      const raw = String(facts.textFiles[".nvmrc"] || facts.textFiles[".node-version"] || facts.packageJson?.volta?.node || facts.packageJson?.engines?.node || "");
      const explicitMajor = Number(raw.match(/\d+/)?.[0] || 0);
      if (explicitMajor && ![20, 22].includes(explicitMajor)) {
        selectedResult.requiredUserInputs.push("SUPPORTED_NODE_RUNTIME");
        selectedResult.unsupportedReasons.push(`Node runtime evidence '${raw.trim()}' cannot be resolved to an approved Node 20 or 22 image.`);
      }
    } else {
      const raw = String(facts.textFiles[".python-version"] || facts.textFiles["runtime.txt"] || facts.textFiles["pyproject.toml"].match(/requires-python\s*=\s*["']([^"']+)/i)?.[1] || "");
      const explicit = raw.match(/3\.\d+/)?.[0];
      if (explicit && !["3.10", "3.11", "3.12", "3.13"].includes(explicit)) {
        selectedResult.requiredUserInputs.push("SUPPORTED_PYTHON_RUNTIME");
        selectedResult.unsupportedReasons.push(`Python runtime evidence '${raw.trim()}' cannot be resolved to an approved Python 3.10-3.13 image.`);
      }
    }
    const backendIds = new Set(["javascript.express", "javascript.fastify", "javascript.nestjs"]);
    const backendAmbiguous = backendIds.has(selected.result.detectorId);
    const conflicts = matches.filter((item) => item !== selected && (
      (item.detector.priority === selected.detector.priority && Math.abs(item.result.confidence - selected.result.confidence) < 0.05)
      || (backendAmbiguous && backendIds.has(item.result.detectorId))
    )).map((item) => item.result.detectorId);
    return { facts, result: selectedResult, ambiguous: conflicts };
  }

  extract(appPath: string, files = new Set<string>()): ExtractedRepositoryFacts {
    const textFiles: Record<string, string> = {};
    for (const name of CONFIG_FILES) textFiles[name] = this.read(appPath, name);
    const packageJson = this.json(this.read(appPath, "package.json"));
    const dependencies = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    const dependencyText = ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg"].map((name) => this.read(appPath, name)).join("\n");
    return { appPath, files, packageJson, dependencies, scripts: packageJson?.scripts || {}, dependencyText, textFiles, pythonModules: this.pythonAst.inspect(appPath) };
  }

  private read(root: string, name: string) { const path = join(root, name); return existsSync(path) ? readFileSync(path, "utf8") : ""; }
  private json(text: string) { try { return JSON.parse(text); } catch { return null; } }
}
