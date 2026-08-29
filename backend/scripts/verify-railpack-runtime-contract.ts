import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const terraform = readFileSync(join(root, "infrastructure", "railpack-runtime", "main.tf"), "utf8");
const outputs = readFileSync(join(root, "infrastructure", "railpack-runtime", "outputs.tf"), "utf8");
const workflow = readFileSync(join(root, ".github", "workflows", "deployguard-reusable.yml"), "utf8");
const deploymentService = readFileSync(join(root, "backend", "src", "projects", "railpack-deployment.service.ts"), "utf8");
const capabilityContract = readFileSync(join(root, "backend", "src", "projects", "github-actions-aws-capability-contract.ts"), "utf8");
const providerLock = readFileSync(join(root, "infrastructure", "railpack-runtime", ".terraform.lock.hcl"), "utf8");

assert.doesNotMatch(terraform, /aws_db_instance|aws_db_subnet_group/);
assert.match(terraform, /aws_ecs_task_definition/);
assert.match(terraform, /aws_efs_file_system/);
assert.match(terraform, /aws_efs_access_point/);
assert.match(terraform, /aws_secretsmanager_secret/);
assert.match(terraform, /count = length\(local\.runtime_secret_arns\) > 0 \? 1 : 0/);
assert.match(terraform, /runtime_secret_arns = distinct\(concat/);
assert.doesNotMatch(terraform, /Resource\s*=\s*"\*"/);
assert.match(terraform, /image\s*=\s*var\.image/);
assert.match(terraform, /containerPort\s*=\s*var\.platform_port/);
for (const output of [
  "aws_region", "ecs_cluster_arn", "ecs_cluster_name", "ecs_service_arn", "ecs_service_name",
  "task_definition_arn", "alb_arn", "alb_name", "alb_target_group_arn", "alb_target_group_name",
  "alb_url", "cloudwatch_log_group_name", "application_container_name",
  "database_efs_file_system_id", "database_efs_access_point_id",
]) assert.match(outputs, new RegExp(`output\\s+"${output}"`), `Railpack release evidence must expose ${output}`);
assert.match(workflow, /HOST:"0\.0\.0\.0"/);
assert.match(workflow, /aws-actions\/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502 # v4\.0\.2/);
assert.match(workflow, /actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4\.2\.2/);
assert.match(workflow, /hashicorp\/setup-terraform@b9cd54a3c349d3f38e8881555d616ced269862dd # v3\.1\.2/);
const terraformSetup = /- name: Install Terraform\n([\s\S]*?)(?=\n      - name: Materialize release runtime)/.exec(workflow)?.[1] || "";
const runtimeMaterialization = /- name: Materialize release runtime\n([\s\S]*?)(?=\n      - name: Publish verified release result)/.exec(workflow)?.[1] || "";
assert.match(terraformSetup, /if: success\(\)/);
assert.doesNotMatch(terraformSetup, /deployment_action|steps\.image\.outputs\.image/);
for (const action of ["deploy", "rollback", "destroy"]) {
  assert.match(runtimeMaterialization, new RegExp(`inputs\\.deployment_action == '${action}'`), `runtime materialization must include ${action}`);
}
assert.ok(workflow.indexOf("- name: Install Terraform") < workflow.indexOf("- name: Materialize release runtime"), "pinned Terraform setup must precede every runtime materialization path");
assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\.6\.2/);
assert.doesNotMatch(workflow, /aws-actions\/configure-aws-credentials@0a3a7f8c8f8b37f3c7d2b23fe4cdd20b3b8a2746/);
assert.match(workflow, /control_plane_sha/);
assert.match(workflow, /railpack build --name/);
assert.match(workflow, /BUILDKIT_IMAGE: moby\/buildkit:v0\.16\.0@sha256:bc1fe18224dbcb92599139db0c745696c48ba9fd4ac24038d1fa81fdd7dcac27/);
assert.match(workflow, /docker version --format/);
assert.match(workflow, /docker run --rm --privileged --detach --name "\$BUILDKIT_CONTAINER" "\$BUILDKIT_IMAGE"/);
assert.match(workflow, /docker exec "\$BUILDKIT_CONTAINER" buildctl debug workers/);
assert.match(workflow, /BUILDKIT_HOST="docker-container:\/\/\$\{BUILDKIT_CONTAINER\}" railpack build --name/);
assert.match(workflow, /Railpack Build prerequisite failed: BuildKit worker did not become ready\./);
assert.match(workflow, /name: Clean up Railpack BuildKit daemon[\s\S]*?if: always\(\) && inputs\.deployment_action == 'deploy'[\s\S]*?docker rm --force "\$BUILDKIT_CONTAINER"/);
assert.doesNotMatch(workflow, /moby\/buildkit:latest/);
assert.match(workflow, /\^\(deploy\|rollback\|destroy\)\$/);
assert.match(workflow, /key=projects\/\$PROJECT_ID\/\$ENVIRONMENT_NAME\/runtime\/terraform\.tfstate/);
assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
assert.match(workflow, /aws ecs wait services-stable/);
assert.match(workflow, /curl --fail/);
assert.doesNotMatch(workflow, /build_plan_base64|generated_dockerfile_base64|terraform:\/\//);
assert.match(deploymentService, /getResultArtifact/);
assert.match(deploymentService, /releaseEvidence/);
assert.match(deploymentService, /RollbackTargetIdentity/);
assert.match(deploymentService, /immutableImage/);
assert.match(deploymentService, /StableReleaseStatus\.ROLLBACK_TARGET/);
assert.match(deploymentService, /awsCapabilities\.ensure/);
assert.match(capabilityContract, /ecs:CreateCluster/);
assert.match(capabilityContract, /elasticloadbalancing:CreateLoadBalancer/);
assert.match(capabilityContract, /iam:AttachRolePolicy/);
assert.match(capabilityContract, /RAILPACK_RUNTIME_AWS_PROVIDER_VERSION = "5\.100\.0"/);
assert.match(providerLock, /version\s+=\s+"5\.100\.0"/);
for (const action of [
  "elasticloadbalancing:DescribeLoadBalancerAttributes", "elasticloadbalancing:ModifyLoadBalancerAttributes", "elasticloadbalancing:DescribeTargetGroupAttributes",
  "elasticloadbalancing:SetSecurityGroups", "elasticloadbalancing:SetSubnets", "ecs:CreateCluster", "ecs:DeleteCluster", "ecs:RegisterTaskDefinition", "ecs:DeleteTaskDefinitions",
  "ec2:UpdateSecurityGroupRuleDescriptionsIngress", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "secretsmanager:UpdateSecret",
  "elasticfilesystem:ModifyMountTargetSecurityGroups", "s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
]) assert.ok(capabilityContract.includes(action), `pinned-provider capability missing: ${action}`);
assert.doesNotMatch(capabilityContract, /sharedEcsClusterArn|sharedAlbArn|sharedAlbListenerArn|service-discovery|CreateRule/);
console.log("RAILPACK_RUNTIME_CONTRACT=PASS");
