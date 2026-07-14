import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "child_process";
import { promisify } from "util";
import { getInfrastructureConfig } from "./infrastructure.config";

const execFileAsync = promisify(execFile);

export type TerraformRunResult = {
  stdout: string;
  stderr: string;
};

@Injectable()
export class TerraformRunnerService {
  constructor(private readonly config: ConfigService) {}

  async runTerraformInit(
    workdir: string,
    env: NodeJS.ProcessEnv = {},
    backendConfigPath?: string | null
  ) {
    const args = ["init", "-input=false"];

    if (backendConfigPath) {
      args.push(`-backend-config=${backendConfigPath}`);
    } else if (backendConfigPath === null) {
      args.push("-backend=false");
    }

    return this.run(args, workdir, env);
  }

  async runTerraformValidate(workdir: string, env: NodeJS.ProcessEnv = {}) {
    return this.run(["validate", "-no-color"], workdir, env);
  }

  async runTerraformPlan(workdir: string, env: NodeJS.ProcessEnv = {}) {
    return this.run(
      ["plan", "-input=false", "-no-color", "-out=tfplan", "-var-file=terraform.tfvars.json"],
      workdir,
      env
    );
  }

  async runTerraformShowJson(workdir: string, env: NodeJS.ProcessEnv = {}) {
    return this.run(["show", "-json", "tfplan"], workdir, env, true);
  }

  async runTerraformApply(workdir: string, env: NodeJS.ProcessEnv = {}) {
    const infraConfig = getInfrastructureConfig(this.config);
    const args = ["apply", "-input=false", "-no-color"];

    if (infraConfig.terraformAutoApprove) {
      args.push("-auto-approve");
    }

    args.push("tfplan");

    return this.run(args, workdir, env);
  }

  async parseOutputs(workdir: string, env: NodeJS.ProcessEnv = {}) {
    const result = await this.run(["output", "-json"], workdir, env, true);
    const parsed = JSON.parse(result.stdout || "{}") as Record<string, { value?: unknown }>;

    return Object.entries(parsed).reduce(
      (outputs, [key, value]) => {
        outputs[key] = value?.value ?? null;
        return outputs;
      },
      {} as Record<string, unknown>
    );
  }

  async pullTerraformState(workdir: string, env: NodeJS.ProcessEnv = {}) {
    return this.run(["state", "pull"], workdir, env, true);
  }

  sanitizeTerraformLogs(logs: string) {
    return logs
      .replace(/AWS_ACCESS_KEY_ID=[^\s]+/gi, "AWS_ACCESS_KEY_ID=[REDACTED]")
      .replace(/AWS_SECRET_ACCESS_KEY=[^\s]+/gi, "AWS_SECRET_ACCESS_KEY=[REDACTED]")
      .replace(/token[=:][^\s]+/gi, "token=[REDACTED]")
      .slice(-12000);
  }

  private async run(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    preserveStdout = false
  ) {
    const infraConfig = getInfrastructureConfig(this.config);

    try {
      const result = await execFileAsync(infraConfig.terraformBin, args, {
        cwd,
        env: { ...process.env, ...env },
        timeout: 20 * 60 * 1000,
        maxBuffer: 32 * 1024 * 1024,
      });

      return {
        stdout: preserveStdout
          ? String(result.stdout || "")
          : this.sanitizeTerraformLogs(result.stdout),
        stderr: this.sanitizeTerraformLogs(result.stderr),
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
      };

      if (err.code === "ENOENT") {
        throw new Error("Terraform CLI is not installed or not available in PATH.");
      }

      const details = this.sanitizeTerraformLogs(err.stderr || err.stdout || "");
      throw new Error(details || "Terraform command failed.");
    }
  }
}
