import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "child_process";
import { writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { CostResourceType } from "./project-cost-resource-breakdown.entity";

const execFileAsync = promisify(execFile);

export type NormalizedCostResource = {
  resourceType: string;
  resourceName: string;
  serviceName?: string | null;
  monthlyCost: number;
  hourlyCost?: number | null;
  unit?: string | null;
  quantity?: number | null;
  metadata?: Record<string, unknown>;
};

type InfracostProcessError = NodeJS.ErrnoException & {
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stderr?: string | Buffer;
};

@Injectable()
export class InfracostService {
  constructor(private readonly config: ConfigService) {}

  async runInfracostBreakdown(planJson: string, workdir: string) {
    const apiKey = this.config.get<string>("INFRACOST_API_KEY");

    if (!apiKey) {
      throw new Error("INFRACOST_API_KEY is required when FINOPS_MOCK_MODE=false.");
    }

    const planJsonPath = join(workdir, "tfplan.json");
    await writeFile(planJsonPath, planJson, { encoding: "utf8", mode: 0o600 });
    const executable = this.config.get<string>("INFRACOST_CLI_PATH", "infracost").trim() || "infracost";

    try {
      const { stdout } = await execFileAsync(
        executable,
        ["breakdown", "--path", planJsonPath, "--format", "json"],
        {
          cwd: workdir,
          timeout: 10 * 60 * 1000,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, INFRACOST_API_KEY: apiKey },
        }
      );

      return stdout;
    } catch (error) {
      const err = error as InfracostProcessError;

      if (err.code === "ENOENT") {
        throw new Error("The configured official Infracost CLI is not installed or executable.");
      }

      throw new Error(this.boundedProviderFailure(err, apiKey));
    }
  }

  private boundedProviderFailure(error: InfracostProcessError, apiKey: string) {
    const exitCode = typeof error.code === "number" ? error.code : null;
    const detail = String(error.stderr || "")
      .replaceAll(apiKey, "[redacted]")
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[redacted]")
      .replace(/([?&](?:token|key|signature)=)[^&\s]+/gi, "$1[redacted]")
      .replace(/https?:\/\/\S+/gi, "[provider endpoint]")
      .replace(/[^\x20-\x7E]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const exit = exitCode === null ? "" : ` (exit ${exitCode})`;
    if (/not logged in|CLI_AUTHENTICATION_TOKEN|failed to log in/i.test(detail)) {
      return `INFRACOST_AUTHENTICATION_REQUIRED${exit}: the Infracost CLI requires a valid non-interactive authentication token.`;
    }
    if (/unauthorized|invalid (?:access |authentication )?token|authentication.*(?:failed|rejected)/i.test(detail)) {
      return `INFRACOST_AUTHENTICATION_REJECTED${exit}: Infracost rejected the configured authentication credential.`;
    }
    if (/ENOTFOUND|EAI_AGAIN|connection refused|network is unreachable|TLS|certificate/i.test(detail)) {
      return `INFRACOST_PROVIDER_CONNECTIVITY_FAILED${exit}: Infracost could not be reached over the configured network and TLS path.`;
    }
    if (error.killed || error.signal === "SIGTERM" || /timed?\s*out|deadline exceeded/i.test(detail)) {
      return `INFRACOST_PROVIDER_TIMEOUT${exit}: the bounded Infracost operation did not complete in time.`;
    }
    const bounded = detail.slice(0, 300);
    return `INFRACOST_PROVIDER_FAILED${exit}${bounded ? `: ${bounded}` : "."}`;
  }

  parseInfracostResponse(rawJson: string) {
    try {
      return JSON.parse(rawJson || "{}");
    } catch {
      throw new Error("Invalid Infracost JSON output.");
    }
  }

  normalizeCostBreakdown(raw: Record<string, unknown>): NormalizedCostResource[] {
    const projects = Array.isArray(raw.projects) ? raw.projects : [];
    const resources = projects.flatMap((project) => {
      const breakdown = (project as { breakdown?: { resources?: unknown[] } }).breakdown;

      return Array.isArray(breakdown?.resources) ? breakdown.resources : [];
    });

    return resources.map((resource, index) => {
      const item = resource as Record<string, unknown>;
      const monthlyCost = Number(item.monthlyCost || 0);
      const name = String(item.name || item.resourceType || `resource-${index + 1}`);

      return {
        resourceType: this.mapResourceType(name),
        resourceName: name,
        serviceName: String(item.resourceType || "") || null,
        monthlyCost,
        metadata: { source: "infracost" },
      };
    });
  }

  private mapResourceType(value: string) {
    const normalized = value.toLowerCase();

    if (/ecs|fargate/.test(normalized)) return CostResourceType.ECS_FARGATE_COMPUTE;
    if (/load.?balancer|alb|elb/.test(normalized)) return CostResourceType.LOAD_BALANCER;
    if (/rds|database|db_instance/.test(normalized)) return CostResourceType.DATABASE;
    if (/s3|efs|ebs|storage|ecr/.test(normalized)) return CostResourceType.STORAGE;
    if (/transfer|nat/.test(normalized)) return CostResourceType.DATA_TRANSFER;
    if (/cloudwatch|logs/.test(normalized)) return CostResourceType.CLOUDWATCH_LOGS;

    return CostResourceType.OTHER;
  }
}
