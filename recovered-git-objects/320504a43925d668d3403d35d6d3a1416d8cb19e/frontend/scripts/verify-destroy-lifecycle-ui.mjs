import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const canonical = read("../src/components/projects/CanonicalDeploymentView.jsx");
const sidebar = read("../src/components/layout/Sidebar.jsx");

assert.match(canonical, /setDestroyDialog\("running"\)/, "accepted destroy keeps a running lifecycle popup");
assert.match(canonical, /data-destroy-popup="running"/);
assert.match(canonical, />View Progress</);
assert.match(canonical, /data-destroy-popup="completed"/);
assert.match(canonical, />Destroy completed</);
assert.match(canonical, />Close</);
assert.match(canonical, /dismissedDestroyOperation\.current/, "completed popup closes only after the user chooses Close");
assert.match(canonical, /data-destroy-popup="failed"/);
assert.match(canonical, /Retry destroy/);
assert.match(canonical, /destroyInProgress/, "duplicate deploy, redeploy, and destroy controls are disabled while destruction is active");
assert.match(sidebar, /\["DEPLOYING", "FAILED", "LIVE", "DESTROYING"\]/);
assert.doesNotMatch(sidebar, /"DESTROYED"\]\.?includes\(state\?\.state\)/);

console.log("Destroy lifecycle popup, retry, progress, and retired active-navigation verification passed.");
