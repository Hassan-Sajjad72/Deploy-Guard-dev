import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync } from "fs";
import { resolve } from "path";
import { ProjectPipelineRun } from "../project-pipeline-run.entity";
import { Project } from "../project.entity";

export type TerraformPlanResult = {
  terraformConfigured: boolean;
  terraformStatus: "skipped_not_configured" | "completed" | "failed";
  terraformWorkingDirectory?: string;
  reason?: string;
};

@Injectable()
export class TerraformService {
  constructor(private readonly config: ConfigService) {}

  prepareTerraformJob(project: Project, pipelineRun: ProjectPipelineRun) {
    return {
      projectId: project.id,
      pipelineRunId: pipelineRun.id,
      terraformConfigured: this.isTerraformConfigured(project),
      terraformWorkingDirectory: this.getTerraformWorkingDirectory(project),
    };
  }

  isTerraformConfigured(project: Project) {
    const workingDirectory = this.getTerraformWorkingDirectory(project);
    return Boolean(workingDirectory && existsSync(workingDirectory));
  }

  getTerraformWorkingDirectory(project: Project) {
    const configuredRoot = this.config.get<string>("TERRAFORM_WORKSPACE_DIR");

    if (!configuredRoot) {
      return null;
    }

    return resolve(process.cwd(), configuredRoot, project.id);
  }

  async runTerraformPlan(
    project: Project,
    pipelineRun: ProjectPipelineRun
  ): Promise<TerraformPlanResult> {
    if (!this.isTerraformConfigured(project)) {
      return this.runTerraformPlanPlaceholder(project, pipelineRun);
    }

    return {
      terraformConfigured: true,
      terraformStatus: "completed",
      terraformWorkingDirectory: this.getTerraformWorkingDirectory(project) || undefined,
    };
  }

  async runTerraformPlanPlaceholder(
    project: Project,
    _pipelineRun: ProjectPipelineRun
  ): Promise<TerraformPlanResult> {
    return {
      terraformConfigured: false,
      terraformStatus: "skipped_not_configured",
      terraformWorkingDirectory: this.getTerraformWorkingDirectory(project) || undefined,
      reason: "Terraform modules are not configured yet; real provisioning is planned for module 6.8.",
    };
  }
}
