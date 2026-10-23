import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = readFileSync(join(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");

assert.match(workflow, /OPERATION_SUFFIX=.*\$OPERATION_ID/);
assert.match(workflow, /image_tag=\$\{SHORT_SHA\}-\$\{OPERATION_SUFFIX\}/);
assert.match(workflow, /steps\.release\.outputs\.image_tag/, "ECR image tags must include a per-operation identity, not only the commit SHA");
assert.doesNotMatch(workflow, /IMAGE_URI=.*outputs\.short_sha/, "a same-commit redeploy must not overwrite the prior immutable tag");

console.log("Immutable per-operation ECR release tag workflow verification passed.");
