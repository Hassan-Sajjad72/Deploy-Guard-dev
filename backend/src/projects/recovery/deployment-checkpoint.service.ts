import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ProjectDeploymentContract } from "../project-deployment-contract.entity";
import { ProjectPipelineRun } from "../project-pipeline-run.entity";

export type RecoveryResumePlan = Pick<
  import("./recovery-issue.types").RecoveryIssue,
  "resumeFromStage" | "canResume" | "requiresFullRerun" | "affectedStages" | "safeToRetry"
>;

@Injectable()
export class DeploymentCheckpointService {
  fingerprints(contract: ProjectDeploymentContract | null, run: ProjectPipelineRun | null) {
    if (!contract) return {};
    const source = this.hash([contract.detectionSourceCommit, contract.appRoot]);
    const build = this.hash([
      source, contract.dependencyManifest, contract.lockfile, contract.dockerStrategy,
      contract.dockerTemplate, contract.buildCommand, contract.buildTimeEnvVars,
    ]);
    const image = this.hash([build, run?.imageTag, run?.ecrImageUri]);
    const runtime = this.hash([
      image, contract.startCommand, contract.port, contract.bindHost,
      contract.runtimeEnvVars, contract.ecsPlan?.environmentMappings, contract.ecsPlan?.secretMappings,
    ]);
    const database = this.hash([contract.ecsPlan?.database]);
    const storage = this.hash([contract.persistentStorageRequired, contract.ecsPlan?.database?.persistenceEnabled]);
    const health = this.hash([runtime, contract.healthPath, contract.ecsPlan?.healthCheckPath]);
    const infrastructure = this.hash([database, storage, health, contract.ecsPlan?.cpu, contract.ecsPlan?.memory]);
    return { source, build, image, runtime, database, storage, health, infrastructure };
  }

  plan(code: string): RecoveryResumePlan {
    if (["contract_invalid", "plan_policy_failed"].includes(code)) {
      return this.resume("terraform_plan", false, ["terraform_plan", "terraform_apply", "database_tier_setup", "ecs_task_definition", "ecs_deploy", "alb_health"], true);
    }
    if (/configuration_(?:changed|stale)|stale_configuration|plan_(?:expired|stale)/.test(code)) {
      return this.resume("terraform_plan", false, ["terraform_plan", "terraform_apply", "ecs_deploy", "alb_health"], true);
    }
    if (/github|repo|branch|app_directory|monorepo|unsupported_(?:language|framework|repo_structure)|ambiguous_app/.test(code)) {
      return this.resume("repo_clone", true, ["repo_clone", "stack_detection", "preflight", "docker_build", "ecr_push", "terraform", "ecs"], false);
    }
    if (/missing_(?:package_manifest|start_command|build_command)|low_confidence_detection/.test(code)) {
      return this.resume("stack_detection", false, ["stack_detection", "preflight", "docker_build", "ecr_push", "ecs_deploy"], true);
    }
    if (/missing_build_time_env|build_secret|docker|dependency|npm_script|module_not_found|native_dependency/.test(code)) {
      return this.resume("docker_build", false, ["docker_build", "ecr_push", "ecs_deploy"], true);
    }
    if (/database/.test(code) || code === "app_connected_to_localhost_database") {
      return this.resume("database_tier_setup", false, ["database_tier_setup", "terraform_plan", "terraform_apply", "ecs_deploy"], true);
    }
    if (code === "persistent_data_delete_confirmation_required") {
      return { resumeFromStage: "cleanup_inventory", canResume: false, requiresFullRerun: false, affectedStages: ["cleanup_inventory"], safeToRetry: false };
    }
    if (/efs|storage|upload_path/.test(code)) {
      return this.resume("storage_setup", false, ["storage_setup", "terraform_plan", "terraform_apply", "ecs_deploy"], true);
    }
    if (/health|target_group|alb_50|no_targets/.test(code)) {
      return this.resume("alb_health", false, ["terraform_plan", "terraform_apply", "alb_health"], true);
    }
    if (/missing_runtime_env|invalid_env|secret_required|port|bound_to_localhost|container|runtime|command_failed|oom|cpu_memory|task_definition/.test(code)) {
      return this.resume("ecs_task_definition", false, ["ecs_task_definition", "ecs_deploy", "alb_health"], true);
    }
    if (/ecr|image_/.test(code)) return this.resume("ecr_push", false, ["ecr_push", "ecs_deploy"], true);
    if (/secret_leaked|unsafe_dockerfile|privileged|base_image/.test(code)) return this.resume("dockerfile_generation", false, ["dockerfile_generation", "docker_build", "ecr_push", "ecs_deploy"], true);
    if (/cost|infracost|budget|high_cost|nat_gateway_cost/.test(code)) {
      return this.resume("terraform_apply", false, ["terraform_apply", "ecs_deploy", "alb_health"], true);
    }
    if (/terraform|state_|aws_|quota|vpc|subnet|nat_|cloud_map|secrets_manager/.test(code)) {
      return this.resume(code.startsWith("state_") ? "state_recovery" : "terraform_plan", false, ["terraform_plan", "terraform_apply", "ecs_deploy"], true);
    }
    if (/cleanup|residue|leftovers|protected_resources|ttl_expired|destroy/.test(code)) {
      return { resumeFromStage: "cleanup_inventory", canResume: false, requiresFullRerun: false, affectedStages: ["cleanup_inventory"], safeToRetry: false };
    }
    return { resumeFromStage: "failed_stage", canResume: false, requiresFullRerun: false, affectedStages: [], safeToRetry: false };
  }

  private resume(resumeFromStage: string, requiresFullRerun: boolean, affectedStages: string[], safeToRetry: boolean): RecoveryResumePlan {
    return { resumeFromStage, canResume: !requiresFullRerun, requiresFullRerun, affectedStages, safeToRetry };
  }

  private hash(value: unknown) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }
}
