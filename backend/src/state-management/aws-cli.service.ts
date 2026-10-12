import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "child_process";
import { promisify } from "util";
import { getStateManagementConfig } from "./state-management.config";
import { CustomerAwsContext } from "../planning/customer-aws-session.service";

const execFileAsync = promisify(execFile);

@Injectable()
export class AwsCliService {
  constructor(private readonly config: ConfigService) {}

  async runScoped(args: string[], context: CustomerAwsContext) {
    const readCommands = new Set(["efs describe-file-systems", "efs describe-access-points", "secretsmanager describe-secret", "s3api get-object", "ec2 describe-vpcs", "ec2 describe-subnets", "ec2 describe-route-tables", "s3api get-bucket-location"]);
    if (!readCommands.has(args.slice(0, 2).join(" ")) || args.some((arg) => /^--(?:endpoint-url|profile|region|no-sign-request|cli-input-json|cli-input-yaml)(?:=|$)/.test(arg)) || !/^\d{12}$/.test(context.accountId) || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(context.region) || context.credentials.expiration.getTime() <= Date.now()) throw new Error("Invalid customer read-only AWS command scope.");
    const redact = (value: unknown) => [context.credentials.accessKeyId, context.credentials.secretAccessKey, context.credentials.sessionToken].reduce((text, secret) => secret ? text.replaceAll(secret, "[REDACTED]") : text, this.sanitize(String(value || "")));
    try {
      const result = await execFileAsync(this.config.get<string>("AWS_CLI_PATH", "aws"), args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, AWS_REGION: context.region, AWS_DEFAULT_REGION: context.region, AWS_ACCESS_KEY_ID: context.credentials.accessKeyId,
          AWS_SECRET_ACCESS_KEY: context.credentials.secretAccessKey, AWS_SESSION_TOKEN: context.credentials.sessionToken,
          AWS_EC2_METADATA_DISABLED: "true", AWS_PAGER: "" } });
      return { stdout: redact(result.stdout), stderr: redact(result.stderr) };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (failure.code === "ENOENT") throw new Error("AWS CLI is not installed or executable.");
      throw new Error(redact(failure.stderr || "Customer AWS read command failed."));
    }
  }

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
          AWS_SESSION_TOKEN: this.config.get<string>("AWS_SESSION_TOKEN", ""),
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

  async validateCredentials() {
    const accessKey = this.config.get<string>("AWS_ACCESS_KEY_ID", "").trim();
    const secretKey = this.config.get<string>("AWS_SECRET_ACCESS_KEY", "").trim();
    const region = this.config.get<string>("AWS_REGION", "").trim();
    if (!accessKey || !secretKey || !region) {
      throw new Error("AWS credentials are missing or invalid. Configure backend AWS credentials before deployment.");
    }
    try {
      const result = await execFileAsync(
        "aws",
        ["sts", "get-caller-identity", "--output", "json"],
        {
          env: {
            ...process.env,
            AWS_REGION: region,
            AWS_ACCESS_KEY_ID: accessKey,
            AWS_SECRET_ACCESS_KEY: secretKey,
            AWS_SESSION_TOKEN: this.config.get<string>("AWS_SESSION_TOKEN", ""),
          },
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        }
      );
      const identity = JSON.parse(String(result.stdout || "{}")) as { Account?: string; Arn?: string };
      if (!identity.Account || !identity.Arn) throw new Error("Invalid AWS identity response");
      return true;
    } catch {
      throw new Error("AWS credentials are missing or invalid. Configure backend AWS credentials before deployment.");
    }
  }

  sanitize(value: string) {
    return value
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_GOOGLE_AI_KEY]")
      .replace(/AWS_ACCESS_KEY_ID[=:\s]+[^\s"]+/gi, "AWS_ACCESS_KEY_ID=[REDACTED]")
      .replace(/AWS_SECRET_ACCESS_KEY[=:\s]+[^\s"]+/gi, "AWS_SECRET_ACCESS_KEY=[REDACTED]")
      .replace(/token[=:\s]+[^\s"]+/gi, "token=[REDACTED]");
  }
}
