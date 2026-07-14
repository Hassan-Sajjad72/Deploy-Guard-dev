import { strict as assert } from "assert";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { StackDetectionService } from "../src/projects/detection/stack-detection.service";
import { TemplateMatchingService } from "../src/projects/detection/template-matching.service";

type Fixture = {
  name: string;
  files: Record<string, string>;
  ecosystem: string;
  framework: string;
  appDirectory: string;
  templateMatched: boolean;
  expectedPort?: number;
};

const fixtures: Fixture[] = [
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
  },
  {
    name: "Express",
    files: {
      "package.json": JSON.stringify({
        scripts: { start: "node server.js" },
        dependencies: { express: "latest" },
      }),
      "server.js": "app.get('/health', handler)",
    },
    ecosystem: "node",
    framework: "express",
    appDirectory: ".",
    templateMatched: true,
  },
  {
    name: "nested Django",
    files: {
      "backend/manage.py": "",
      "backend/requirements.txt": "Django\ngunicorn\n",
      "backend/config/settings.py": "DATABASES = {}",
    },
    ecosystem: "python",
    framework: "django",
    appDirectory: "backend",
    templateMatched: true,
  },
  {
    name: "generic PHP",
    files: { "index.php": "<?php echo 'ok';" },
    ecosystem: "php",
    framework: "php",
    appDirectory: ".",
    templateMatched: false,
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
  },
];

async function main() {
  const detector = new StackDetectionService(new TemplateMatchingService());

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
      if (fixture.expectedPort) {
        assert.equal(profile.expectedPort, fixture.expectedPort, fixture.name);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const monorepo = await mkdtemp(join(tmpdir(), "deployguard-app-directory-test-"));
  try {
    await mkdir(join(monorepo, "apps", "web"), { recursive: true });
    await mkdir(join(monorepo, "apps", "api"), { recursive: true });
    await writeFile(join(monorepo, "apps", "web", "package.json"), JSON.stringify({ dependencies: { react: "latest" } }));
    await writeFile(join(monorepo, "apps", "api", "package.json"), JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "latest" } }));
    await writeFile(join(monorepo, "apps", "api", "server.js"), "app.get('/health', handler)");
    const selected = detector.detect(monorepo, "b".repeat(40), "apps/api");
    assert.equal(selected.framework, "express");
    assert.equal(selected.rawProfile.appDirectory, "apps/api");
    assert.equal(selected.rawProfile.preferredAppDirectory, "apps/api");
    assert.throws(() => detector.detect(monorepo, null, "../outside"), /outside the repository workspace/);
  } finally {
    await rm(monorepo, { recursive: true, force: true });
  }

  process.stdout.write(`Verified ${fixtures.length} stack-detection fixtures and explicit app-directory safety.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
