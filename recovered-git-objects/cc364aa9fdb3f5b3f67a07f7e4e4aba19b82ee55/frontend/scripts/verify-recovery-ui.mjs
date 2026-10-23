import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const overview = await readFile(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const settings = await readFile(new URL("../src/pages/ProjectSettings.jsx", import.meta.url), "utf8");
const card = await readFile(new URL("../src/components/projects/DeploymentRecoveryCard.jsx", import.meta.url), "utf8");
assert.equal((overview.match(/<DeploymentRecoveryCard/g) || []).length, 1);
assert.match(overview, /state\.recoveryIssue/);
assert.doesNotMatch(overview, /isStateRecovery|isEcsFailure/);
assert.match(settings, /focusSection/);
assert.match(settings, /Show full settings/);
assert.match(settings, /show\("database_setup"\)/);
assert.match(settings, /focusedHealth/);
assert.match(card, /IssueEvidenceList/);
assert.match(card, /DeveloperDetailsAccordion/);
console.log("Recovery overview and focused-settings UI verification passed.");
