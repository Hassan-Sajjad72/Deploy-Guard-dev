import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GithubActionsDeploymentService } from "../src/projects/github-actions-deployment.service";
import {
  githubActionsExecutionStageFromLog,
  githubActionsPlatformCapabilityFailure,
  githubActionsStagePresentation,
  githubActionsWorkflowStepPresentation,
} from "../src/projects/pipeline/github-actions-stage-presentation";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";

assert.deepEqual(githubActionsStagePresentation("terraform_plan_and_apply", "deploy"), {
  key: "terraform_plan_and_apply",
  label: "Provisioning infrastructure",
});
assert.deepEqual(githubActionsStagePresentation("terraform_plan_and_apply", "destroy"), {
  key: "terraform_plan_and_apply",
  label: "Destroying infrastructure",
});
assert.deepEqual(githubActionsStagePresentation("workflow_run_discovery", "destroy"), {
  key: "workflow_run_discovery",
  label: "GitHub Actions run was not created",
});
assert.equal(githubActionsWorkflowStepPresentation("Terraform plan and apply", "deploy")?.label, "Terraform plan and apply");
assert.equal(githubActionsWorkflowStepPresentation("Terraform plan and apply", "destroy")?.label, "Terraform destroy plan and apply");
const failureLog = "2026-08-12T16:15:46.800Z DEPLOYGUARD_STAGE=terraform_plan_and_apply\n2026-08-12T16:16:03.849Z AccessDeniedException: not authorized to perform: ecs:DeleteService";
assert.equal(githubActionsExecutionStageFromLog(failureLog), "terraform_plan_and_apply");
assert.equal(githubActionsExecutionStageFromLog(`${failureLog}\n2026-08-12T16:16:05.000Z DEPLOYGUARD_STAGE=verify_exact_project_deletion`), "verify_exact_project_deletion");
assert.deepEqual(githubActionsPlatformCapabilityFailure(failureLog), { action: "ecs:DeleteService", classification: "platform_configuration" });
assert.deepEqual(
  githubActionsWorkflowStepPresentation("Verify exact project deletion and write result", "destroy"),
  { key: "verify_exact_project_deletion", label: "Verifying exact project deletion" },
);

const service: any = Object.create(GithubActionsDeploymentService.prototype);
const historicalDestroy = service.response({
  id: "a00ac1b1-161d-4248-b92c-a5f074990edc",
  status: PipelineRunStatus.RUNNING,
  currentStage: "terraform_plan_and_apply",
  githubWorkflowRunId: "31367513372",
  githubWorkflowStatus: "in_progress",
  commitSha: "afe926246a900ab5230adf6c0245e836cc0feb8b",
  metadata: { deploymentAction: "destroy", attempt: 17 },
  createdAt: new Date("2026-08-10T07:50:34.640Z"),
}, null);
assert.equal(historicalDestroy.deploymentAction, "destroy");
assert.equal(historicalDestroy.stageLabel, "Destroying infrastructure");

const workflow = readFileSync(join(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
assert.match(workflow, /terraform plan -destroy -detailed-exitcode/);
assert.match(workflow, /terraform apply -input=false -auto-approve deployguard\.tfplan/);
assert.match(workflow, /DEPLOYGUARD_STAGE=verify_exact_project_deletion/);
const deploymentService = readFileSync(join(__dirname, "../src/projects/github-actions-deployment.service.ts"), "utf8");
assert.match(deploymentService, /deployment_action: action/);
assert.match(deploymentService, /this\.dispatch\(user, projectId, runRepository, "destroy", null, \{ generationId: generation\.id \}\)/);

console.log("Destroy stage presentation checks passed: action-aware summary/timeline labels, current verification stage, historical metadata rendering, and unchanged routing/Terraform commands.");
