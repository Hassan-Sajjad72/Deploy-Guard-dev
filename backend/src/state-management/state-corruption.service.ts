import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash } from "crypto";
import { Repository } from "typeorm";
import {
  ProjectStateValidationResult,
  StateValidationStatus,
} from "./project-state-validation-result.entity";
import { ProjectTerraformState, TerraformStateStatus } from "./project-terraform-state.entity";
import { getStateManagementConfig } from "./state-management.config";
import { TerraformStateService } from "./terraform-state.service";

@Injectable()
export class StateCorruptionService {
  constructor(
    @InjectRepository(ProjectStateValidationResult)
    private readonly resultRepository: Repository<ProjectStateValidationResult>,
    @InjectRepository(ProjectTerraformState)
    private readonly stateRepository: Repository<ProjectTerraformState>,
    private readonly config: ConfigService,
    private readonly terraformStateService: TerraformStateService
  ) {}

  validateTerraformStateJson(stateJson: string) {
    try {
      const parsed = JSON.parse(stateJson || "{}") as {
        version?: number;
        serial?: number;
        resources?: unknown[];
      };

      return Boolean(
        typeof parsed.version === "number" &&
          typeof parsed.serial === "number" &&
          Array.isArray(parsed.resources)
      );
    } catch {
      return false;
    }
  }

  validateChecksum(stateJson: string, expectedChecksum?: string | null) {
    if (!expectedChecksum) {
      return true;
    }

    return this.sha256(stateJson) === expectedChecksum;
  }

  validateResourceCountConsistency(
    resourceCount: number,
    previousResourceCount?: number | null
  ) {
    if (!previousResourceCount || previousResourceCount <= 0) {
      return true;
    }

    const config = getStateManagementConfig(this.config);
    const dropPercent = ((previousResourceCount - resourceCount) / previousResourceCount) * 100;

    return dropPercent <= config.resourceDropWarningPercent;
  }

  validateDependencyGraph(stateJson: string) {
    try {
      const parsed = JSON.parse(stateJson || "{}") as {
        resources?: Array<{ module?: string; mode?: string; type?: string; name?: string; instances?: Array<{ dependencies?: string[] }> }>;
      };
      const resources = parsed.resources || [];
      const resourceNames = new Set(
        resources.map((resource) => this.resourceAddress(resource))
      );

      for (const resource of resources) {
        for (const instance of resource.instances || []) {
          for (const dependency of instance.dependencies || []) {
            const normalized = dependency.replace(/\[[^\]]+\]/g, "");
            const moduleExists = [...resourceNames].some((address) => address.startsWith(`${normalized}.`));
            if (normalized.includes(".") && !resourceNames.has(normalized) && !moduleExists) {
              return false;
            }
          }
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  async detectCorruption(
    projectId: string,
    environmentName = "dev",
    rawState?: string | null,
    enforceStoredChecksum = true
  ) {
    const state = await this.stateRepository.findOne({ where: { projectId, environmentName } });
    const stateJson = rawState || "{}";
    const parsed = this.safeParse(stateJson);
    const resourceCount = Array.isArray(parsed.resources) ? parsed.resources.length : 0;
    const actualChecksum = this.sha256(stateJson);
    const jsonSchemaValid = this.validateTerraformStateJson(stateJson);
    const checksumValid = enforceStoredChecksum
      ? this.validateChecksum(stateJson, state?.checksum)
      : true;
    const resourceCountValid = this.validateResourceCountConsistency(resourceCount, state?.resourceCount);
    const dependencyGraphValid = this.validateDependencyGraph(stateJson);
    const blockingIssues = [
      !jsonSchemaValid ? "Terraform state JSON schema is invalid." : null,
      !checksumValid ? "Terraform state checksum does not match the last known checksum." : null,
      !resourceCountValid ? "Terraform state resource count dropped beyond configured threshold." : null,
    ].filter(Boolean) as string[];
    const warningIssues = [
      !dependencyGraphValid ? "Terraform state dependency graph contains unresolved advisory references." : null,
    ].filter(Boolean) as string[];
    const issues = [...blockingIssues, ...warningIssues];
    const status = blockingIssues.length
      ? StateValidationStatus.CORRUPTED
      : warningIssues.length
        ? StateValidationStatus.WARNING
        : StateValidationStatus.VALID;

    const result = await this.resultRepository.save(
      this.resultRepository.create({
        projectId,
        environmentName,
        stateVersionId: state?.currentVersionId || null,
        status,
        jsonSchemaValid,
        checksumValid,
        resourceCountValid,
        dependencyGraphValid,
        resourceCount,
        expectedChecksum: state?.checksum || null,
        actualChecksum,
        issues,
      })
    );

    if (state) {
      state.status =
        status === StateValidationStatus.CORRUPTED
          ? TerraformStateStatus.RECOVERY_REQUIRED
          : TerraformStateStatus.ACTIVE;
      state.lastValidatedAt = new Date();
      state.resourceCount = resourceCount;
      state.checksum = actualChecksum;
      state.dependencyGraphHash = this.dependencyGraphHash(stateJson);
      await this.stateRepository.save(state);
    }

    return result;
  }

  async validationResults(projectId: string, environmentName = "dev") {
    return this.resultRepository.find({
      where: { projectId, environmentName },
      order: { createdAt: "DESC" },
      take: 50,
    });
  }

  dependencyGraphHash(stateJson: string) {
    const parsed = this.safeParse(stateJson);
    const dependencies = (parsed.resources || []).flatMap((resource: { instances?: Array<{ dependencies?: string[] }> }) =>
      (resource.instances || []).flatMap((instance) => instance.dependencies || [])
    );
    return this.sha256(JSON.stringify(dependencies.sort()));
  }

  private resourceAddress(resource: { module?: string; mode?: string; type?: string; name?: string }) {
    const prefix = resource.module ? `${resource.module}.` : "";
    const mode = resource.mode === "data" ? "data." : "";
    return `${prefix}${mode}${resource.type}.${resource.name}`;
  }

  private safeParse(value: string) {
    try {
      return JSON.parse(value || "{}");
    } catch {
      return {};
    }
  }

  private sha256(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }
}
