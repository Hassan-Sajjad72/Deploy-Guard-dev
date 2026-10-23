import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { FinopsService } from "../src/finops/finops.service";
import { CostEstimateStatus, ProjectCostEstimate } from "../src/finops/project-cost-estimate.entity";
import { DeploymentProfileService } from "../src/projects/detection/deployment-profile.service";
import { PipelineService } from "../src/projects/pipeline/pipeline.service";
import { PipelineWorkerService } from "../src/projects/pipeline/pipeline-worker.service";
import { PIPELINE_QUEUE } from "../src/projects/pipeline/pipeline.types";
import { isPipelineTerminal } from "../src/projects/pipeline/pipeline-status";
import { ProjectPipelineEvent } from "../src/projects/project-pipeline-event.entity";
import { PipelineRunStatus, ProjectPipelineRun } from "../src/projects/project-pipeline-run.entity";
import { Project } from "../src/projects/project.entity";
import { PreflightService } from "../src/projects/templates/preflight.service";
import { User } from "../src/users/user.entity";

const SAFE_PROJECT_ID = process.env.VERSION14_E2E_PROJECT_ID || "1f9df568-ef7f-4646-8197-054491445df3";
const expected = [
  ["STATE_MOCK_MODE", "true"], ["FINOPS_MOCK_MODE", "true"],
  ["TERRAFORM_APPLY_ENABLED", "false"], ["GITHUB_ACTIONS_REQUIRED", "false"],
  ["PIPELINE_QUEUE_NAME", "pipelineQueueVersion14E2E"],
  ["AUTOMATION_MANUAL_APPROVALS_ENABLED", "true"],
  ["VERSION14_E2E_FORCE_NEW_RUN", "true"],
] as const;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn", "log"] });
  const dataSource = app.get(DataSource);
  const config = app.get(ConfigService);
  const worker = app.get(PipelineWorkerService);
  try {
    for (const [key, value] of expected) {
      if (config.get<string>(key, "") !== value) throw new Error(`${key}=${value} is required for the safe E2E run.`);
    }
    const project = await dataSource.getRepository(Project).findOne({ where: { id: SAFE_PROJECT_ID } });
    if (!project) throw new Error(`Safe E2E project ${SAFE_PROJECT_ID} does not exist.`);
    const user = await dataSource.getRepository(User).findOne({ where: { id: project.ownerUserId } });
    if (!user) throw new Error("Safe E2E project owner does not exist.");
    const pipelineService = app.get(PipelineService);
    const runs = dataSource.getRepository(ProjectPipelineRun);
    const previousPaused = await runs.findOne({
      where: { projectId: project.id, status: PipelineRunStatus.APPLY_DISABLED },
      order: { createdAt: "DESC" },
    });
    if (previousPaused) {
      await pipelineService.cancelRun(user, project.id, previousPaused.id);
      console.log(`SAFE_E2E_PRIOR_PAUSE_CANCELLED=${previousPaused.id}`);
    }

    const profile = await app.get(DeploymentProfileService).getOrRunDetection(user, project.id);
    if (profile.detectionStatus !== "success") throw new Error(`Detection stopped with ${profile.detectionStatus}.`);
    const preflight = await app.get(PreflightService).getOrGenerateReport(user, project.id);
    if (!["passed", "passed_with_warnings"].includes(preflight.validationStatus)) throw new Error(`Pre-flight stopped with ${preflight.validationStatus}.`);
    const queued = await pipelineService.startRun(user, project.id, { triggerGithubActions: false });
    console.log(`SAFE_E2E_RUN_ID=${queued.id}`);
    worker.start();

    const estimates = dataSource.getRepository(ProjectCostEstimate);
    const deadline = Date.now() + 30 * 60_000;
    let last = "";
    let costApproved = false;
    let run: ProjectPipelineRun | null = null;
    while (Date.now() < deadline) {
      run = await runs.findOne({ where: { id: queued.id } });
      if (!run) throw new Error("Safe E2E pipeline run disappeared.");
      const snapshot = `${run.status}:${run.currentStage}`;
      if (snapshot !== last) { console.log(`SAFE_E2E_PROGRESS=${snapshot}`); last = snapshot; }
      if (run.status === PipelineRunStatus.WAITING_FOR_COST_APPROVAL && !costApproved) {
        const estimate = await estimates.findOne({
          where: { pipelineRunId: run.id, status: CostEstimateStatus.APPROVAL_REQUIRED },
          order: { createdAt: "DESC" },
        });
        if (!estimate) throw new Error("Safe E2E reached the cost gate without an approvable estimate.");
        await app.get(FinopsService).approveEstimate(user, project.id, estimate.id);
        costApproved = true;
        console.log(`SAFE_E2E_COST_APPROVED=${estimate.id}`);
      }
      if (run.status === PipelineRunStatus.APPLY_DISABLED || isPipelineTerminal(run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!run || run.status !== PipelineRunStatus.APPLY_DISABLED) {
      throw new Error(`Safe E2E expected apply_disabled, reached ${run?.status || "timeout"}:${run?.currentStage || "unknown"}.`);
    }
    const events = await dataSource.getRepository(ProjectPipelineEvent).find({ where: { pipelineRunId: run.id }, order: { createdAt: "ASC" } });
    console.log(`SAFE_E2E_FINAL=${run.status}:${run.currentStage}`);
    console.log(`SAFE_E2E_EVENTS=${events.map((event) => `${event.stage}:${event.status}`).join(",")}`);
  } finally {
    await worker.onModuleDestroy();
    await app.get<Queue>(PIPELINE_QUEUE).close();
    await app.close();
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
