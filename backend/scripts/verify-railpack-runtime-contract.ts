import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const terraform = readFileSync(join(root, "infrastructure", "railpack-runtime", "main.tf"), "utf8");
const workflow = readFileSync(join(root, ".github", "workflows", "deployguard-reusable.yml"), "utf8");

assert.doesNotMatch(terraform, /aws_db_instance|aws_db_subnet_group/);
assert.match(terraform, /aws_ecs_task_definition/);
assert.match(terraform, /aws_efs_file_system/);
assert.match(terraform, /aws_efs_access_point/);
assert.match(terraform, /aws_secretsmanager_secret/);
assert.match(terraform, /image\s*=\s*var\.image/);
assert.match(terraform, /containerPort\s*=\s*var\.platform_port/);
assert.match(workflow, /HOST:"0\.0\.0\.0"/);
assert.match(workflow, /control_plane_sha/);
assert.match(workflow, /railpack build --name/);
assert.doesNotMatch(workflow, /build_plan_base64|generated_dockerfile_base64|terraform:\/\//);
console.log("RAILPACK_RUNTIME_CONTRACT=PASS");
