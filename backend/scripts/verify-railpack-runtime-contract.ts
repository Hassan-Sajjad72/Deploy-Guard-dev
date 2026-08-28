import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const terraform = readFileSync(join(root, "infrastructure", "railpack-runtime", "main.tf"), "utf8");
const workflow = readFileSync(join(root, ".github", "workflows", "deployguard-reusable.yml"), "utf8");
const deploymentService = readFileSync(join(root, "backend", "src", "projects", "railpack-deployment.service.ts"), "utf8");

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
assert.match(workflow, /\^\(deploy\|rollback\|destroy\)\$/);
assert.match(workflow, /key=projects\/\$PROJECT_ID\/\$ENVIRONMENT_NAME\/runtime\/terraform\.tfstate/);
assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
assert.match(workflow, /aws ecs wait services-stable/);
assert.match(workflow, /curl --fail/);
assert.doesNotMatch(workflow, /build_plan_base64|generated_dockerfile_base64|terraform:\/\//);
assert.match(deploymentService, /getResultArtifact/);
assert.match(deploymentService, /releaseEvidence/);
assert.match(deploymentService, /rollbackSourceSha/);
console.log("RAILPACK_RUNTIME_CONTRACT=PASS");
