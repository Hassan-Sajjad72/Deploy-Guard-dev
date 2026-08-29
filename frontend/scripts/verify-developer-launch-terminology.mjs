import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const developerSurfaces = [
  "../src/pages/Dashboard.jsx",
  "../src/pages/Projects.jsx",
  "../src/pages/Billing.jsx",
  "../src/pages/ProjectDetails.jsx",
  "../src/pages/ProjectPipeline.jsx",
  "../src/pages/DeploymentRequirements.jsx",
  "../src/pages/ProjectLogs.jsx",
  "../src/pages/ProjectMetrics.jsx",
  "../src/pages/ProjectSettings.jsx",
  "../src/components/projects/CanonicalDeploymentView.jsx",
  "../src/components/projects/NormalReleaseOperationPanel.jsx",
];
const forbidden = [
  /Terraform/i,
  /\bAWS\b/,
  /\bECS\b/,
  /\bECR\b/,
  /\bALB\b/,
  /\bIAM\b/,
  /BullMQ/i,
  /\bworker\b/i,
  /\blease\b/i,
  /\boutbox\b/i,
  /cleanup/i,
  /inventory error/i,
  /NORMAL_[A-Z0-9_]+/,
];

for (const path of developerSurfaces) {
  const source = read(path)
    // Billing protocol keys remain internal request/response identities; neither
    // value is rendered. The guard intentionally evaluates developer-visible
    // copy while preserving the backend compatibility contract.
    .replaceAll('"terraform_export"', '"internal_meter"')
    .replaceAll('"terraformExportsPerMonth"', '"internalMeterLimit"');
  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern, `${path} must not expose ${pattern}`);
  }
}

const sidebar = read("../src/components/layout/Sidebar.jsx");
const projectNavigation = sidebar.match(/const projectNavigation = \[[\s\S]*?\n\];/)?.[0] || "";
for (const label of ["Overview", "Deployments", "Environment", "Logs", "Metrics", "Settings"]) {
  assert.match(projectNavigation, new RegExp(`label: "${label}"`));
}
for (const pattern of forbidden) assert.doesNotMatch(projectNavigation, pattern);
assert.match(sidebar, /user\?\.role === "admin"[\s\S]*Operator modules/);

console.log("Developer launch terminology verification passed.");
