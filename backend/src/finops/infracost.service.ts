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

@Injectable()
export class InfracostService {
  constructor(private readonly config: ConfigService) {}

  async runInfracostBreakdown(planJson: string, workdir: string) {
    const apiKey = this.config.get<string>("INFRACOST_API_KEY");

    if (!apiKey) {
      throw new Error("INFRACOST_API_KEY is required when FINOPS_MOCK_MODE=false.");
    }

    const planJsonPath = join(workdir, "tfplan.json");
    await writeFile(planJsonPath, planJson, "utf8");

    try {
      const { stdout } = await execFileAsync(
        "infracost",
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
      const err = error as NodeJS.ErrnoException;

      if (err.code === "ENOENT") {
        throw new Error("infracost CLI is not installed or not available in PATH.");
      }

      throw new Error("Infracost cost breakdown failed.");
    }
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
