import { strict as assert } from "assert";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { StackDetectionService } from "../src/projects/detection/stack-detection.service";
import { TemplateMatchingService } from "../src/projects/detection/template-matching.service";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";

type Fixture = {
  name: string;
  files: Record<string, string>;
  ecosystem: string;
  framework: string;
  appDirectory: string;
  templateMatched: boolean;
  expectedPort?: number | null;
  expectedTemplate?: string;
  expectedHealthPath?: string;
  expectedStatus?: string;
  expectedOutputDirectory?: string;
  expectedLockfile?: string;
  expectedStartCommand?: string | null;
  expectedSettingsModule?: string;
};

const fixtures: Fixture[] = [
  {
    name: "Next.js SSR",
    files: {
      "package.json": JSON.stringify({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "latest", react: "latest", "react-dom": "latest" } }),
      "package-lock.json": "{}",
    },
    ecosystem: "node", framework: "nextjs", appDirectory: ".", templateMatched: true, expectedTemplate: "nextjs-ssr", expectedStatus: "success",
    expectedStartCommand: "npm run start -- -H 0.0.0.0 -p ${PORT:-3000}",
  },
  {
    name: "Next.js static export",
    files: {
      "package.json": JSON.stringify({ scripts: { build: "next build" }, dependencies: { next: "latest", react: "latest", "react-dom": "latest" } }),
      "package-lock.json": "{}",
      "next.config.js": "module.exports = { output: 'export' }",
    },
    ecosystem: "node", framework: "nextjs", appDirectory: ".", templateMatched: true, expectedTemplate: "nextjs-static", expectedPort: 8080, expectedOutputDirectory: "out", expectedStatus: "success",
  },
  {
    name: "root Vite React",
    files: {
      "package.json": JSON.stringify({
        scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
        dependencies: { react: "latest" },
        devDependencies: { vite: "latest" },
      }),
      "package-lock.json": "{}",
    },
    ecosystem: "node",
    framework: "vite-react",
    appDirectory: ".",
    templateMatched: true,
    expectedPort: 8080,
    expectedTemplate: "vite-static",
    expectedHealthPath: "/",
    expectedStatus: "success",
  },
  {
    name: "nested React",
    files: {
      "README.md": "monorepo",
      "frontend/package.json": JSON.stringify({
        scripts: { build: "react-scripts build", start: "react-scripts start" },
        dependencies: { react: "latest" },
      }),
    },
    ecosystem: "node",
    framework: "react",
    appDirectory: "frontend",
    templateMatched: true,
    expectedPort: 8080,
    expectedTemplate: "react-static",
    expectedHealthPath: "/",
    expectedStatus: "manual_input_required",
  },
  {
    name: "legacy webpack React output",
    files: {
      "package.json": JSON.stringify({ scripts: { build: "NODE_ENV='production' ./node_modules/.bin/webpack" }, dependencies: { react: "15.0.1" }, devDependencies: { webpack: "1.12.9" } }),
      "webpack.config.js": `var path = require('path'); module.exports = { context: path.join(__dirname, "app"), output: { path: __dirname + "/app/", filename: "bundle.js" } };`,
      "app/js/app.js": "const view = require('react');",
    },
    ecosystem: "node", framework: "react", appDirectory: ".", templateMatched: true,
    expectedPort: 8080, expectedTemplate: "react-webpack-static", expectedOutputDirectory: "app", expectedHealthPath: "/", expectedStatus: "success",
  },
  {
    name: "React Native mobile app",
    files: {
      "package.json": JSON.stringify({
        scripts: { start: "react-native start", android: "react-native run-android" },
        dependencies: { react: "latest", "react-native": "0.59.0" },
      }),
      "yarn.lock": "",
    },
    ecosystem: "node",
    framework: "react-native",
    appDirectory: ".",
    templateMatched: false,
    expectedPort: null,
    expectedTemplate: "custom-dockerfile-required",
    expectedHealthPath: "/",
    expectedStatus: "manual_input_required",
  },
  {
    name: "Express",
    files: {
      "package.json": JSON.stringify({
        scripts: { start: "node server.js" },
        dependencies: { express: "latest" },
      }),
      "package-lock.json": "{}",
      "server.js": "const port = process.env.PORT || 3000; app.get('/api/health', handler); app.listen(port, '0.0.0.0')",
    },
    ecosystem: "node",
    framework: "express",
    appDirectory: ".",
    templateMatched: true,
    expectedStatus: "success",
    expectedHealthPath: "/api/health",
  },
  {
    name: "NestJS",
    files: {
      "package.json": JSON.stringify({ scripts: { build: "nest build", "start:prod": "node dist/main.js" }, dependencies: { "@nestjs/core": "latest" } }),
      "package-lock.json": "{}",
      "src/main.ts": "await app.listen(process.env.PORT || 3000, '0.0.0.0')",
    },
    ecosystem: "node", framework: "nestjs", appDirectory: ".", templateMatched: true, expectedTemplate: "nestjs-server", expectedStatus: "success",
  },
  {
    name: "Fastify",
    files: {
      "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { fastify: "latest" } }),
      "package-lock.json": "{}",
      "server.js": "fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' })",
    },
    ecosystem: "node", framework: "fastify", appDirectory: ".", templateMatched: true, expectedTemplate: "fastify-server", expectedStatus: "success",
  },
  {
    name: "Flask",
    files: { "requirements.txt": "Flask==3.0.0\ngunicorn==22.0.0\n", "app.py": "from flask import Flask\napp = Flask(__name__)\n@app.get('/health')\ndef health(): return 'ok'" },
    ecosystem: "python", framework: "flask", appDirectory: ".", templateMatched: true, expectedTemplate: "flask-wsgi", expectedStatus: "success",
  },
  {
    name: "Flask application factory",
    files: {
      "requirements.txt": "Flask==3.0.0\ngunicorn==22.0.0\n",
      "app.py": "from flask import Flask\ndef create_app():\n    return Flask(__name__)\n",
    },
    ecosystem: "python", framework: "flask", appDirectory: ".", templateMatched: true,
    expectedTemplate: "flask-wsgi", expectedStatus: "success",
    expectedStartCommand: "gunicorn 'app:create_app()' --bind 0.0.0.0:${PORT:-5000}",
  },
  {
    name: "FastAPI",
    files: { "requirements.txt": "fastapi==0.115.0\nuvicorn==0.34.0\n", "main.py": "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/healthz')\ndef health(): return {'ok': True}" },
    ecosystem: "python", framework: "fastapi", appDirectory: ".", templateMatched: true, expectedTemplate: "fastapi-asgi", expectedHealthPath: "/healthz", expectedLockfile: "requirements.txt", expectedStatus: "success",
  },
  {
    name: "Streamlit",
    files: { "requirements.txt": "streamlit==1.37.0\n", "app.py": "import streamlit as st\nst.write('ready')" },
    ecosystem: "python", framework: "streamlit", appDirectory: ".", templateMatched: true, expectedTemplate: "streamlit-server", expectedStatus: "success",
  },
  {
    name: "nested Django",
    files: {
      "backend/manage.py": "",
      "backend/requirements.txt": "Django==5.0.0\ngunicorn==22.0.0\n",
      "backend/config/settings/production.py": "import os\nSECRET_KEY = os.environ['SECRET_KEY']\nDEBUG = False\nALLOWED_HOSTS = os.getenv('ALLOWED_HOSTS', '*').split(',')\nDATABASES = {}",
      "backend/config/wsgi.py": "application = object()",
    },
    ecosystem: "python",
    framework: "django",
    appDirectory: "backend",
    templateMatched: true,
    expectedStatus: "success",
    expectedSettingsModule: "config.settings.production",
  },
  {
    name: "generic PHP",
    files: { "index.php": "<?php echo 'ok';" },
    ecosystem: "php",
    framework: "php",
    appDirectory: ".",
    templateMatched: false,
    expectedStatus: "manual_input_required",
  },
  {
    name: "Laravel",
    files: {
      "composer.json": JSON.stringify({ require: { "laravel/framework": "latest" } }),
      artisan: "#!/usr/bin/env php",
      "public/index.php": "<?php",
    },
    ecosystem: "php",
    framework: "laravel",
    appDirectory: ".",
    templateMatched: false,
    expectedStatus: "manual_input_required",
  },
];

async function main() {
  const detector = new StackDetectionService(new TemplateMatchingService(), new RepoDeployabilityScannerService());

  for (const fixture of fixtures) {
    const root = await mkdtemp(join(tmpdir(), "deployguard-detection-test-"));
    try {
      for (const [path, content] of Object.entries(fixture.files)) {
        const absolute = join(root, path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, content, "utf8");
      }
      const profile = detector.detect(root, "a".repeat(40));
      assert.equal(profile.ecosystem, fixture.ecosystem, fixture.name);
      assert.equal(profile.framework, fixture.framework, fixture.name);
      assert.equal(profile.rawProfile.appDirectory, fixture.appDirectory, fixture.name);
      assert.equal(profile.rawProfile.templateMatched, fixture.templateMatched, fixture.name);
      assert.equal(profile.rawProfile.detected, true, fixture.name);
      if (fixture.expectedPort !== undefined) {
        assert.equal(profile.expectedPort, fixture.expectedPort, fixture.name);
      }
      if (fixture.expectedTemplate) {
        assert.equal(profile.selectedTemplate, fixture.expectedTemplate, fixture.name);
      }
      if (fixture.expectedHealthPath) {
        assert.equal(profile.healthCheckPath, fixture.expectedHealthPath, fixture.name);
      }
      if (fixture.expectedOutputDirectory) assert.equal(profile.rawProfile.outputDirectory, fixture.expectedOutputDirectory, fixture.name);
      if (fixture.expectedLockfile) assert.ok((profile.rawProfile.lockfiles as string[]).includes(fixture.expectedLockfile), fixture.name);
      if (fixture.expectedStatus) assert.equal(profile.detectionStatus, fixture.expectedStatus, fixture.name);
      if (fixture.expectedStartCommand !== undefined) assert.equal(profile.startCommand, fixture.expectedStartCommand, fixture.name);
      if (fixture.expectedSettingsModule) assert.equal(profile.rawProfile.djangoSettingsModule, fixture.expectedSettingsModule, fixture.name);
      assert.equal(profile.commitSha, "a".repeat(40), `${fixture.name} commit evidence`);
      if (fixture.expectedStatus === "success") {
        const repeated = detector.detect(root, "a".repeat(40));
        assert.deepEqual(
          {
            ecosystem: repeated.ecosystem,
            framework: repeated.framework,
            frameworkVariant: repeated.frameworkVariant,
            packageManager: repeated.packageManager,
            buildCommand: repeated.buildCommand,
            startCommand: repeated.startCommand,
            expectedPort: repeated.expectedPort,
            healthCheckPath: repeated.healthCheckPath,
            rawProfile: repeated.rawProfile,
          },
          {
            ecosystem: profile.ecosystem,
            framework: profile.framework,
            frameworkVariant: profile.frameworkVariant,
            packageManager: profile.packageManager,
            buildCommand: profile.buildCommand,
            startCommand: profile.startCommand,
            expectedPort: profile.expectedPort,
            healthCheckPath: profile.healthCheckPath,
            rawProfile: profile.rawProfile,
          },
          `${fixture.name} deterministic profile`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const monorepo = await mkdtemp(join(tmpdir(), "deployguard-app-directory-test-"));
  try {
    await mkdir(join(monorepo, "apps", "web"), { recursive: true });
    await mkdir(join(monorepo, "apps", "api"), { recursive: true });
    await writeFile(join(monorepo, "apps", "web", "package.json"), JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }));
    await writeFile(join(monorepo, "apps", "web", "server.js"), "app.listen(process.env.PORT || 3000, '0.0.0.0')");
    await writeFile(join(monorepo, "apps", "api", "package.json"), JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }));
    await writeFile(join(monorepo, "apps", "api", "server.js"), "app.get('/health', handler)");
    const selected = detector.detect(monorepo, "b".repeat(40), "apps/api");
    assert.equal(selected.framework, "express");
    assert.equal(selected.rawProfile.appDirectory, "apps/api");
    assert.equal(selected.rawProfile.preferredAppDirectory, "apps/api");
    const ambiguous = detector.detect(monorepo, "b".repeat(40));
    assert.equal(ambiguous.rawProfile.appRootConfidence, "low");
    assert.equal(ambiguous.detectionStatus, "manual_input_required");
    assert.match(ambiguous.errors.join(" "), /multiple (?:application roots|backends)/i);
    assert.throws(() => detector.detect(monorepo, null, "../outside"), /outside the repository workspace/);
  } finally {
    await rm(monorepo, { recursive: true, force: true });
  }

  const emptyRepository = await mkdtemp(join(tmpdir(), "deployguard-empty-repository-test-"));
  try {
    const empty = detector.detect(emptyRepository, "c".repeat(40));
    assert.equal(empty.ecosystem, "unknown");
    assert.equal(empty.rawProfile.repositoryEmpty, true);
    assert.equal(empty.detectionStatus, "manual_input_required");
    assert.match(empty.errors[0], /repository and branch are empty/i);
  } finally {
    await rm(emptyRepository, { recursive: true, force: true });
  }

  const missingEnvironment = await mkdtemp(join(tmpdir(), "deployguard-missing-env-test-"));
  try {
    await writeFile(join(missingEnvironment, "package.json"), JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }));
    await writeFile(join(missingEnvironment, "package-lock.json"), "{}");
    await writeFile(join(missingEnvironment, "server.js"), "const apiKey = process.env.API_KEY; app.listen(process.env.PORT || 3000, '0.0.0.0')");
    const profile = detector.detect(missingEnvironment, "d".repeat(40));
    assert.deepEqual(profile.rawProfile.requiredEnvironmentVariables, [], "a bare ENV reference is not proven required");
    assert.deepEqual(profile.rawProfile.optionalEnvironmentVariables, ["API_KEY"], "unknown application ENV remains injectable but non-blocking");
    assert.equal((profile.rawProfile.environmentVariables as Array<Record<string, unknown>>).find((item) => item.key === "API_KEY")?.requirement, "unknown");
  } finally {
    await rm(missingEnvironment, { recursive: true, force: true });
  }

  const platformRuntime = await mkdtemp(join(tmpdir(), "deployguard-python-runtime-test-"));
  try {
    await writeFile(join(platformRuntime, "requirements.txt"), "fastapi==0.116.0\n");
    await writeFile(join(platformRuntime, "main.py"), "from fastapi import FastAPI\napp = FastAPI()");
    const profile = detector.detect(platformRuntime, "7".repeat(40));
    assert.equal(profile.detectionStatus, "success");
    assert.match(String(profile.rawProfile.installCommand), /uvicorn==0\.35\.0/);
    assert.doesNotMatch(profile.errors.join(" "), /requires uvicorn/i);
  } finally {
    await rm(platformRuntime, { recursive: true, force: true });
  }

  const blockerFixtures: Array<{ name: string; files: Record<string, string>; expected: RegExp }> = [
    {
      name: "Python missing dependency manifest",
      files: {
        "app.py": "from flask import Flask\napp = Flask(__name__)",
      },
      expected: /Python deployment requires|dependency manifest|framework.*identified|No supported deployable application component/i,
    },
    {
      name: "Vite missing production build",
      files: {
        "package.json": JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "latest" }, devDependencies: { vite: "latest" } }),
        "package-lock.json": "{}",
      },
      expected: /production build script/i,
    },
    {
      name: "Express fixed port",
      files: {
        "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }),
        "package-lock.json": "{}",
        "server.js": "app.listen(3000, '0.0.0.0')",
      },
      expected: /read PORT from the environment/i,
    },
    {
      name: "Express development start command",
      files: {
        "package.json": JSON.stringify({ scripts: { start: "nodemon server.js" }, dependencies: { express: "latest", nodemon: "latest" } }),
        "package-lock.json": "{}",
        "server.js": "app.listen(process.env.PORT || 3000, '0.0.0.0')",
      },
      expected: /development server/i,
    },
    {
      name: "conflicting JavaScript lockfiles",
      files: {
        "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }),
        "package-lock.json": "{}",
        "yarn.lock": "",
        "server.js": "app.listen(process.env.PORT || 3000, '0.0.0.0')",
      },
      expected: /conflicting JavaScript lockfiles/i,
    },
    {
      name: "localhost-only Express",
      files: {
        "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }),
        "package-lock.json": "{}",
        "server.js": "app.listen(process.env.PORT || 3000, 'localhost')",
      },
      expected: /bind only to localhost/i,
    },
    {
      name: "unsafe Django settings",
      files: {
        "manage.py": "",
        "requirements.txt": "Django\ngunicorn\n",
        "config/settings.py": "SECRET_KEY = 'committed-secret'\nDEBUG = True\nALLOWED_HOSTS = []",
        "config/wsgi.py": "application = object()",
      },
      expected: /DEBUG=True|SECRET_KEY is hard-coded|ALLOWED_HOSTS/i,
    },
    {
      name: "missing production start command",
      files: {
        "package.json": JSON.stringify({ dependencies: { express: "latest" } }),
        "package-lock.json": "{}",
        "src/main.ts": "import express from 'express'; const app = express(); app.listen(process.env.PORT || 3000, '0.0.0.0');",
      },
      expected: /start command/i,
    },
    {
      name: "package-manager mismatch",
      files: {
        "package.json": JSON.stringify({ packageManager: "yarn@4.5.0", scripts: { start: "node server.js" }, dependencies: { express: "latest" } }),
        "package-lock.json": "{}",
        "server.js": "app.listen(process.env.PORT || 3000, '0.0.0.0')",
      },
      expected: /declares yarn.*lockfile belongs to npm/i,
    },
    {
      name: "conflicting framework evidence",
      files: {
        "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest", fastify: "latest" } }),
        "package-lock.json": "{}",
        "server.js": "app.listen(process.env.PORT || 3000, '0.0.0.0')",
      },
      expected: /Conflicting JavaScript framework evidence|multiple competing backend runtimes/i,
    },
    {
      name: "Vite without React evidence",
      files: {
        "package.json": JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "latest" } }),
        "package-lock.json": "{}",
      },
      expected: /Vite web framework could not be identified safely|No supported deployable application component/i,
    },
  ];
  for (const fixture of blockerFixtures) {
    const root = await mkdtemp(join(tmpdir(), "deployguard-blocker-test-"));
    try {
      for (const [path, content] of Object.entries(fixture.files)) {
        const absolute = join(root, path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, content, "utf8");
      }
      const profile = detector.detect(root, "e".repeat(40));
      assert.equal(profile.detectionStatus, "manual_input_required", fixture.name);
      assert.match(profile.errors.join(" "), fixture.expected, fixture.name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const repositoryDockerfile = await mkdtemp(join(tmpdir(), "deployguard-repository-dockerfile-test-"));
  try {
    await writeFile(join(repositoryDockerfile, "package.json"), JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }));
    await writeFile(join(repositoryDockerfile, "package-lock.json"), "{}");
    await writeFile(join(repositoryDockerfile, "server.js"), "app.listen(process.env.PORT || 3000, '0.0.0.0')");
    await writeFile(join(repositoryDockerfile, "Dockerfile"), "FROM node\nCOPY . .");

    const generated = detector.detect(repositoryDockerfile, "f".repeat(40));
    assert.equal(generated.hasDockerfile, true, "repository Dockerfile remains detected");
    assert.equal(generated.selectedTemplate, "express-server", "supported stack defaults to generated containerization");
    assert.equal(generated.detectionStatus, "success");
    assert.equal(generated.rawProfile.containerizationSource, "deployguard");
    assert.equal(generated.rawProfile.repositoryDockerfileIgnored, true);
    assert.doesNotMatch(generated.errors.join(" "), /Dockerfile base image|CMD or ENTRYPOINT/i);

    const custom = detector.detect(repositoryDockerfile, "f".repeat(40), null, { dockerfileMode: "custom" });
    assert.equal(custom.selectedTemplate, "custom-dockerfile", "explicit custom mode selects repository Dockerfile");
    assert.equal(custom.rawProfile.containerizationSource, "repository");
    assert.equal(custom.detectionStatus, "manual_input_required", "custom Dockerfile validation remains enforced");
    assert.match(custom.errors.join(" "), /explicit version tag|CMD or ENTRYPOINT/i);
  } finally {
    await rm(repositoryDockerfile, { recursive: true, force: true });
  }

  const conflictingOverride = await mkdtemp(join(tmpdir(), "deployguard-conflicting-override-test-"));
  try {
    await writeFile(join(conflictingOverride, "package.json"), JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "latest" }, devDependencies: { vite: "latest" } }));
    await writeFile(join(conflictingOverride, "package-lock.json"), "{}");
    const profile = detector.detect(conflictingOverride, "8".repeat(40), null, { runtimeType: "server", startCommand: "node server.js" });
    assert.equal(profile.detectionStatus, "manual_input_required");
    assert.match(profile.errors.join(" "), /runtimeType override.*conflicts|startCommand override conflicts/i);
  } finally {
    await rm(conflictingOverride, { recursive: true, force: true });
  }

  const privateRegistry = await mkdtemp(join(tmpdir(), "deployguard-private-registry-test-"));
  try {
    await writeFile(join(privateRegistry, "package.json"), JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "latest" }, devDependencies: { vite: "latest" } }));
    await writeFile(join(privateRegistry, "package-lock.json"), "{}");
    await writeFile(join(privateRegistry, ".npmrc"), "@company:registry=https://npm.company.example\n//npm.company.example/:_authToken=${NPM_TOKEN}");
    const profile = detector.detect(privateRegistry, "f".repeat(40));
    assert.equal(profile.rawProfile.privateRegistryRequired, true);
    assert.ok((profile.rawProfile.requiredEnvironmentVariables as string[]).includes("NPM_TOKEN"));
    const evidence = profile.rawProfile.environmentVariables as Array<Record<string, unknown>>;
    assert.equal(evidence.find((item) => item.key === "NPM_TOKEN")?.secret, true);
    assert.equal(JSON.stringify(profile.rawProfile).includes("npm.company.example/:_authToken"), false, "registry file contents must not be persisted");
  } finally {
    await rm(privateRegistry, { recursive: true, force: true });
  }

  const privatePythonRegistry = await mkdtemp(join(tmpdir(), "deployguard-private-python-registry-test-"));
  try {
    await writeFile(join(privatePythonRegistry, "requirements.txt"), "--extra-index-url https://packages.company.example/simple\nfastapi==0.115.0\nuvicorn==0.34.0\n");
    await writeFile(join(privatePythonRegistry, "main.py"), "from fastapi import FastAPI\napp = FastAPI()");
    const profile = detector.detect(privatePythonRegistry, "7".repeat(40));
    assert.equal(profile.rawProfile.privateRegistryRequired, true);
    assert.ok((profile.rawProfile.requiredEnvironmentVariables as string[]).includes("PYPI_TOKEN"));
    assert.equal(JSON.stringify(profile.rawProfile).includes("packages.company.example"), false, "Python registry configuration must not be persisted");
  } finally {
    await rm(privatePythonRegistry, { recursive: true, force: true });
  }

  process.stdout.write(`Verified ${fixtures.length} framework fixtures plus deterministic profiles, app factories, app-root ambiguity, environment evidence, lockfile/package-manager consistency, conflicting overrides, and safety gates.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
