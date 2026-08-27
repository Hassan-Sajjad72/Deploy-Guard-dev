import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/pages/NewProject.jsx"), "utf8");
const primitives = readFileSync(join(root, "src/components/common/DesignSystem.jsx"), "utf8");

assert.match(source, /topologyAnalysisState[^\n]+!== "SUPPORTED"/, "readiness must fail closed on unresolved canonical topology");
assert.match(source, /<DataRow label="Topology"/, "canonical topology must be the primary readiness summary");
assert.match(source, /Technical detector evidence/, "legacy detector output must be kept inside technical details");
assert.match(source, /const canonicalDatabase = readiness\?\.profile\?\.managedDatabase \|\| null/, "database presentation must use the canonical topology owner");
assert.doesNotMatch(source, /managedDatabase \|\| readiness\.profile\?\.requiresDatabase/, "legacy database flags must not drive the managed database card");
assert.match(primitives, /level === "warning" \? "READY_WITH_WARNINGS"/, "warning-only readiness must be labeled READY_WITH_WARNINGS");
assert.match(source, /\["ready", "warning"\]\.includes\(readiness\.level\)/, "warning-only readiness must keep deployment enabled");
assert.match(source, /report\?\.report\?\.warningDetails \|\| readiness\?\.profile\?\.warningDetails/, "structured warning details must be rendered from preflight or detection evidence");
assert.match(source, /Deployment allowed:.*warning\.deploymentAllowed/, "the UI must show the warning's deployment-allowed contract");
assert.match(source, /report\?\.readinessStatus \|\| report\?\.report\?\.readiness\?\.decision/, "the UI must consume the authoritative preflight readiness decision");
assert.match(source, /decision === "INPUT_REQUIRED"/, "missing required inputs must remain a distinct UI state");
assert.match(source, /readiness\.deployAllowed === true/, "the Deploy gate must consume the API readiness permission");
assert.match(primitives, /level === "input_required" \? "INPUT_REQUIRED"/, "INPUT_REQUIRED must not be mislabeled BLOCKED or READY_WITH_WARNINGS");

console.log("New Deployment topology-authority and warning-policy presentation checks passed.");
