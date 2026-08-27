import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "child_process";
import { lstat, readFile, realpath } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
import { promisify } from "util";
import { getInfrastructureConfig } from "./infrastructure.config";

const execFileAsync = promisify(execFile);

export type TerraformRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type TerraformBackendMode = "local" | "s3";

@Injectable()
export class TerraformRunnerService {
  constructor(private readonly config: ConfigService) {}

  async runTerraformInit(
    workdir: string,
    env: NodeJS.ProcessEnv = {},
    backend: { mode: TerraformBackendMode; configPath?: string } = { mode: "local" }
  ) {
    return this.run(this.buildTerraformInitArgs(backend), workdir, env);
  }

  buildTerraformInitArgs(backend: { mode: TerraformBackendMode; configPath?: string }) {
    const args = ["init", "-input=false", "-no-color"];

    if (backend.mode === "s3") {
      if (!backend.configPath) {
        throw new Error("Remote Terraform state requires an explicit backend configuration file.");
      }
      args.push("-reconfigure", `-backend-config=${backend.configPath}`);
    }

    return args;
  }

  async assertBackendMode(workdir: string, expected: TerraformBackendMode) {
    const infraConfig = getInfrastructureConfig(this.config);
    await this.assertSafeWorkspace(workdir, infraConfig.terraformWorkingBaseDir);
    let marker: { mode?: string };
    try {
      marker = JSON.parse(await readFile(join(workdir, ".deployguard-backend-mode.json"), "utf8"));
    } catch {
      throw new Error("Terraform workspace backend mode is unverified. Generate a new plan before this operation.");
    }
    if (marker.mode !== expected) {
      throw new Error(`Terraform workspace backend mode is ${marker.mode || "unknown"}; expected ${expected}. Explicit state migration or a new plan is required.`);
    }
  }

  async runTerraformValidate(workdir: string, env: NodeJS.ProcessEnv = {}) {
    return this.run(["validate", "-no-color"], workdir, env);
  }

  async runTerraformFmtCheck(workdir: string, env: NodeJS.ProcessEnv = {}) {
    return this.run(["fmt", "-check", "-recursive", "-diff"], workdir, env);
  }

  async runTerraformPlan(workdir: string, env: NodeJS.ProcessEnv = {}) {
    return this.run(
      ["plan", "-input=false", "-no-color", "-out=tfplan", "-var-file=terraform.tfvars.json"],
      workdir,
      env
    );
  }

  async runTerraformPlanDetailed(workdir: string, env: NodeJS.ProcessEnv = {}) {
    return this.run(
      ["plan", "-detailed-exitcode", "-input=false", "-no-color", "-out=tfplan", "-var-file=terraform.tfvars.json"],
      workdir,
      env,
      false,
      [0, 2],
    );
  }

  async runTerraformShowJson(workdir: string, env: NodeJS.ProcessEnv = {}) {
    return this.run(["show", "-json", "tfplan"], workdir, env, true);
  }

  async runTerraformShowStateJson(workdir: string, env: NodeJS.ProcessEnv = {}) {
    return this.run(["show", "-json"], workdir, env, true);
  }

  async runTerraformApply(
    workdir: string,
    env: NodeJS.ProcessEnv = {},
    verifiedPlanPath: string = "tfplan",
  ) {
    const infraConfig = getInfrastructureConfig(this.config);
    const args = ["apply", "-input=false", "-no-color"];

    if (infraConfig.terraformAutoApprove) {
      args.push("-auto-approve");
    }

    args.push(verifiedPlanPath);

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

  async listTerraformState(workdir: string, env: NodeJS.ProcessEnv = {}) {
    try {
      const result = await this.run(["state", "list"], workdir, env, true);
      return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    } catch (error) {
      if (/No state file was found|No Terraform state was found/i.test(error instanceof Error ? error.message : String(error))) {
        return [];
      }
      throw error;
    }
  }

  async importTerraformResource(workdir: string, address: string, id: string, env: NodeJS.ProcessEnv = {}) {
    if (!/^module\.(?:database_service|ecs_service)\.aws_secretsmanager_secret(?:_version)?\.[A-Za-z0-9_]+(?:\[(?:0|"[A-Za-z_][A-Za-z0-9_]*")\])$/.test(address)) {
      throw new Error("Managed-secret Terraform address is invalid.");
    }
    if (!id || /[\r\n\0]/.test(id)) throw new Error("Managed-secret import identifier is invalid.");
    return this.run(["import", "-input=false", "-no-color", address, id], workdir, env);
  }

  async importCloudWatchLogGroup(workdir: string, address: string, name: string, env: NodeJS.ProcessEnv = {}) {
    if (!/^module\.(?:database_service|ecs_service)\.aws_cloudwatch_log_group\.(?:app|database|deployment)\[0\]$/.test(address)) {
      throw new Error("CloudWatch log-group Terraform address is invalid.");
    }
    if (!/^\/deployguard\/[0-9a-f-]{36}\/(?:dev|production)\/(?:app|database|deployment)$/.test(name)) {
      throw new Error("CloudWatch log-group name is invalid.");
    }
    return this.run(["import", "-input=false", "-no-color", address, name], workdir, env);
  }

  async importPersistentResource(workdir: string, address: string, id: string, env: NodeJS.ProcessEnv = {}) {
    if (!/^module\.(?:registry|efs|database_service)\.aws_(?:ecr_repository\.this|efs_file_system\.(?:this|database)|efs_access_point\.(?:this|database))\[0\]$/.test(address)) {
      throw new Error("Persistent-resource Terraform address is invalid.");
    }
    if (!/^[A-Za-z0-9._/-]{2,256}$/.test(id)) throw new Error("Persistent-resource import identifier is invalid.");
    return this.run(["import", "-input=false", "-no-color", address, id], workdir, env);
  }

  buildTerraformDestroyArgs(targets: string[]) {
    return [
      "destroy", "-input=false", "-no-color", "-auto-approve",
      ...targets.map((target) => `-target=${target}`),
    ];
  }

  async runTerraformDestroy(workdir: string, targets: string[], env: NodeJS.ProcessEnv = {}, scope?: { sharedStateBucketAbsent: boolean }) {
    if (scope?.sharedStateBucketAbsent !== true) throw new Error("Terraform destroy requires verified project state scope.");
    if (!targets.length || targets.length > 500) throw new Error("A bounded set of Terraform destroy targets is required.");
    const safe = targets.filter((target) => /^[A-Za-z0-9_.\[\]"'-]+$/.test(target));
    if (safe.length !== targets.length) throw new Error("Terraform state contained an unsafe resource address.");
    return this.run(this.buildTerraformDestroyArgs(safe), workdir, env);
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
    preserveStdout = false,
    allowedExitCodes: number[] = [0],
  ) {
    const infraConfig = getInfrastructureConfig(this.config);
    await this.assertSafeWorkspace(cwd, infraConfig.terraformWorkingBaseDir);

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
        exitCode: 0,
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
      };

      if (err.code === "ENOENT") {
        throw new Error("Terraform CLI is not installed or not available in PATH.");
      }

      const exitCode = typeof err.code === "number" ? err.code : Number.NaN;
      if (allowedExitCodes.includes(exitCode)) {
        return {
          stdout: preserveStdout ? String(err.stdout || "") : this.sanitizeTerraformLogs(err.stdout || ""),
          stderr: this.sanitizeTerraformLogs(err.stderr || ""),
          exitCode,
        };
      }

      const details = this.sanitizeTerraformLogs(err.stderr || err.stdout || "");
      throw new Error(details || "Terraform command failed.");
    }
  }

  private async assertSafeWorkspace(workdir: string, configuredRoot: string) {
    if (!isAbsolute(workdir)) {
      throw new Error("Terraform workspace must be an absolute path.");
    }

    const root = await realpath(resolve(configuredRoot));
    const workspace = await realpath(resolve(workdir));
    const pathFromRoot = relative(root, workspace);

    if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
      throw new Error("Terraform workspace is outside the configured workspace root.");
    }

    const stats = await lstat(workspace);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Terraform workspace must be a real directory, not a symlink.");
    }
  }
}
