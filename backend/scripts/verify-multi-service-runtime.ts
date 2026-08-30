import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const workflow = readFileSync(join(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
const terraform = readFileSync(join(root, "infrastructure/railpack-runtime/main.tf"), "utf8");
const outputs = readFileSync(join(root, "infrastructure/railpack-runtime/outputs.tf"), "utf8");
const deployment = readFileSync(join(root, "backend/src/projects/railpack-deployment.service.ts"), "utf8");
for (const resource of ["aws_cloudwatch_log_group", "aws_security_group", "aws_lb", "aws_lb_target_group", "aws_lb_listener", "aws_ecs_task_definition", "aws_ecs_service"]) {
  assert.match(terraform, new RegExp(`resource "${resource.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}"[\\s\\S]*?for_each\\s+= var\\.services`));
}
assert.match(terraform, /DeployGuardServiceId = each\.key/);
assert.match(terraform, /name\s+= "\/deployguard\/\$\{var\.project_id\}\/services\/\$\{each\.key\}"/);
assert.match(terraform, /security_groups = local\.database_enabled \? \[aws_security_group\.application\[local\.database_service_id\]\.id\] : \[\]/);
assert.match(terraform, /each\.value\.database_attached \? \[\{/);
assert.match(outputs, /output "services"/);
assert.match(workflow, /while IFS= read -r service; do[\s\S]*railpack build --name "\$image" "\$directory"/);
assert.match(workflow, /while IFS= read -r artifact; do[\s\S]*docker run --detach[\s\S]*PORT=8080[\s\S]*HOST=0\.0\.0\.0/);
assert.match(workflow, /\.services \| to_entries\[\]/);
assert.match(workflow, /terraform -chdir=\.deployguard\/terraform destroy/);
assert.match(workflow, /Select immutable rollback service images/);
assert.doesNotMatch(workflow.match(/Select immutable rollback service images[\s\S]*?Install Terraform/)?.[0] || "", /railpack build/);
assert.match(deployment, /action === "destroy" \? null : await this\.runtimeSecrets\.materialize/, "Destroy must not create or rotate application runtime secrets before deleting infrastructure");
console.log("MULTI_SERVICE_RUNTIME=PASS TERRAFORM_FOR_EACH=1 PER_SERVICE_ALB=1 ROLLBACK_REBUILD=0 DESTROY_SHARED_STATE=1");
