import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "child_process";
import { promisify } from "util";
import { getStateManagementConfig } from "./state-management.config";

const execFileAsync = promisify(execFile);

@Injectable()
export class AwsCliService {
  constructor(private readonly config: ConfigService) {}

  async run(args: string[]) {
    const stateConfig = getStateManagementConfig(this.config);

    if (stateConfig.mockMode) {
      return { stdout: "{}", stderr: "" };
    }

    try {
      const result = await execFileAsync("aws", args, {
        env: {
          ...process.env,
          AWS_REGION: stateConfig.region,
          AWS_ACCESS_KEY_ID: this.config.get<string>("AWS_ACCESS_KEY_ID", ""),
          AWS_SECRET_ACCESS_KEY: this.config.get<string>("AWS_SECRET_ACCESS_KEY", ""),
        },
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024,
      });

      return {
        stdout: this.sanitize(String(result.stdout || "")),
        stderr: this.sanitize(String(result.stderr || "")),
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };

      if (err.code === "ENOENT") {
        throw new Error("AWS CLI is not installed or not available in PATH.");
      }

      throw new Error(this.sanitize(err.stderr || err.stdout || "AWS CLI command failed."));
    }
  }

  sanitize(value: string) {
    return value
      .replace(/AWS_ACCESS_KEY_ID[=:\s]+[^\s"]+/gi, "AWS_ACCESS_KEY_ID=[REDACTED]")
      .replace(/AWS_SECRET_ACCESS_KEY[=:\s]+[^\s"]+/gi, "AWS_SECRET_ACCESS_KEY=[REDACTED]")
      .replace(/token[=:\s]+[^\s"]+/gi, "token=[REDACTED]");
  }
}
