import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(__dirname, "..");
const targets = [join(root, "src"), join(root, "..", "frontend", "src"), join(root, "..", ".github", "workflows")];
const forbidden = [
  "StackDetectionService", "MainstreamDetectorResolver", "RepoDeployabilityScanner", "FrameworkDetector",
  "DockerTemplateEngine", "requireBuildPlan", "BUILD_PLAN_REANALYSIS_MESSAGE", "build_plan_base64",
  "generated_dockerfile_base64", "topology-detection-v", "Run Detect Stack again",
];

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory()
    ? files(join(directory, entry.name))
    : [join(directory, entry.name)]))).flat();
}

async function main() {
  const matches: string[] = [];
  for (const target of targets) for (const file of await files(target)) {
    if (file.includes("/migrations/")) continue;
    if (!/\.(?:ts|tsx|js|jsx|ya?ml)$/.test(file)) continue;
    const text = await readFile(file, "utf8");
    for (const token of forbidden) if (text.includes(token)) matches.push(`${file.replace(root, "backend")}: ${token}`);
  }
  if (matches.length) {
    console.error(`LEGACY_EXECUTABLE_REFERENCES=${matches.length}`);
    console.error(matches.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("LEGACY_EXECUTABLE_REFERENCES=0");
  }
}

void main();
