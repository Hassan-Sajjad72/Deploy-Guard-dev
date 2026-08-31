import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const install = spawnSync(process.execPath, [join(root, "scripts", "install-certification-tools.mjs")], { cwd: root, stdio: "inherit" });
if (install.status !== 0) process.exit(install.status || 1);

const toolRoot = join(root, ".cache", "certification-tools");
const actionlint = join(toolRoot, "actionlint-1.7.12", "actionlint");
const shellcheck = join(toolRoot, "shellcheck-0.11.0", "shellcheck-v0.11.0", "shellcheck");
const workflowRoot = join(root, ".github", "workflows");
const workflows = readdirSync(workflowRoot)
  .filter((file) => /\.ya?ml$/i.test(file))
  .sort()
  .map((file) => join(workflowRoot, file));

if (!workflows.length) throw new Error("No GitHub Actions workflows were found");
const lint = spawnSync(actionlint, [`-shellcheck=${shellcheck}`, ...workflows], { cwd: root, stdio: "inherit" });
if (lint.status !== 0) process.exit(lint.status || 1);
console.log(`GITHUB_WORKFLOW_LINT=PASS WORKFLOWS=${workflows.length} ACTIONLINT=1.7.12 SHELLCHECK=0.11.0`);
