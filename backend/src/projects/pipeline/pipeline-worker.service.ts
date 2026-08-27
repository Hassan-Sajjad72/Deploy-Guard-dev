import { Injectable } from "@nestjs/common";
import { DatabaseServiceBindingService } from "../../infrastructure/database-service-binding.service";
import { ProjectDeploymentContract } from "../project-deployment-contract.entity";
import { ProjectPipelineRun } from "../project-pipeline-run.entity";

/**
 * Compatibility boundary for retired local-pipeline consumers.
 *
 * GitHub Actions is the production deployment executor. These pure helpers are
 * retained for historical recovery tests and configuration-ownership checks;
 * this class is deliberately not registered as a running queue worker.
 */
@Injectable()
export class PipelineWorkerService {
  constructor(private readonly databaseBindings: DatabaseServiceBindingService) {}

  private assertContractCommit(
    run: ProjectPipelineRun,
    contract: ProjectDeploymentContract,
  ) {
    if (
      !contract.detectionSourceCommit
      || run.commitSha !== contract.detectionSourceCommit
    ) {
      throw new Error(
        "Repository changed after stack detection. Re-run detection and pre-flight for the latest commit before deploying.",
      );
    }
  }

  private async publicBuildArguments(
    run: ProjectPipelineRun,
    contract: ProjectDeploymentContract,
  ) {
    const secretKeys = new Set(contract.secretEnvVars);
    const keys = new Set(
      contract.buildTimeEnvVars.filter((key) => !secretKeys.has(key)),
    );
    if (!keys.size) return {};
    const effective = await this.databaseBindings
      .resolveEffectiveDeploymentConfiguration(run.projectId, run.id, "production");
    return Object.fromEntries(
      Object.entries(effective.buildArguments).filter(
        ([key]) => keys.has(key) && /^[A-Z][A-Z0-9_]*$/.test(key),
      ),
    );
  }

  private async checkDockerfile() {
    return undefined;
  }
}
