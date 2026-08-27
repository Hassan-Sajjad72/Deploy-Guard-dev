import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = readFileSync(join(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");

assert.match(workflow, /OPERATION_SUFFIX=.*\$OPERATION_ID/);
assert.match(workflow, /inputs\.image_tag/);
assert.match(workflow, /Immutable image tag does not match this operation/);
assert.match(workflow, /steps\.release\.outputs\.image_tag/, "ECR image tags must include a per-operation identity, not only the commit SHA");
assert.doesNotMatch(workflow, /IMAGE_URI=.*outputs\.short_sha/, "a same-commit redeploy must not overwrite the prior immutable tag");
assert.match(workflow, /describe-images[\s\S]*imageDetails\[0\]\.imageDigest/);
assert.match(workflow, /COMPONENT_TAG="\$\{\{ steps\.release\.outputs\.image_tag \}\}-\$COMPONENT_ID"/);
assert.match(workflow, /IMMUTABLE_URI="\$REGISTRY\/\$\{\{ steps\.release\.outputs\.repository_name \}\}@\$IMAGE_DIGEST"/);
assert.match(workflow, /component-images\.json/);

console.log("Immutable per-operation, per-component ECR release tag and digest workflow verification passed.");
