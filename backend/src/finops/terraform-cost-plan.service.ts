import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { promisify } from "util";
import { Project } from "../projects/project.entity";
import { getFinopsConfig } from "./finops.config";

const execFileAsync = promisify(execFile);

@Injectable()
export class TerraformCostPlanService {
  constructor(private readonly config: ConfigService) {}

  getTerraformWorkingDirectory(project: Project) {
    const finopsConfig = getFinopsConfig(this.config);

    if (!finopsConfig.terraformWorkdir) {
      return null;
    }

    return resolve(process.cwd(), finopsConfig.terraformWorkdir, project.id);
  }

  ensureConfigured(project: Project) {
    const workdir = this.getTerraformWorkingDirectory(project);

    if (!workdir || !existsSync(workdir)) {
      throw new Error("Terraform modules are not configured for cost estimation.");
    }

    return workdir;
  }

  async generateTerraformPlan(project: Project) {
    const workdir = this.ensureConfigured(project);
    const planPath = join(workdir, "tfplan");

    await this.run("terraform", ["init", "-input=false"], workdir);
    await this.run("terraform", ["plan", "-out=tfplan", "-input=false"], workdir);

    return { workdir, planPath };
  }

  async convertTerraformPlanToJson(planPath: string, workdir: string) {
    const { stdout } = await this.run("terraform", ["show", "-json", planPath], workdir);
    return stdout;
  }

  private async run(command: string, args: string[], cwd: string) {
    try {
      return await execFileAsync(command, args, {
        cwd,
        timeout: 10 * 60 * 1000,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;

      if (err.code === "ENOENT") {
        throw new Error(`${command} CLI is not installed or not available in PATH.`);
      }

      throw new Error(`${command} cost planning command failed.`);
    }
  }
}
