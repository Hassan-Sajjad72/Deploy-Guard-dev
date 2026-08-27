import { BadRequestException, Injectable } from "@nestjs/common";
import { CentralCloudResource } from "./central-cloud-resource.entity";

@Injectable()
export class CloudCleanupSafetyService {
  assertCleanupAllowed(resource: CentralCloudResource, orphanOnly = false) {
    if (resource.protected || resource.resourceName === "deployguard-state-bucket" || resource.resourceType === "terraform_state") {
      throw new BadRequestException("Shared platform and Terraform state resources are protected.");
    }
    if (!resource.safeToCleanup || !resource.cleanupSupported) throw new BadRequestException("Resource is not eligible for automatic cleanup.");
    if (!resource.projectId) throw new BadRequestException("An exact ProjectId is required for cleanup.");
    if (orphanOnly && resource.status !== "orphan") throw new BadRequestException("Only safe orphan resources are eligible for this action.");
    const id = resource.projectId;
    if (resource.resourceType === "secret" && !resource.resourceName.startsWith(`deployguard/${id}/`)) throw new BadRequestException("Secret is outside the exact project prefix.");
    if (resource.resourceType === "log_group" && !resource.resourceName.startsWith(`/deployguard/${id}/`)) throw new BadRequestException("Log group is outside the exact project prefix.");
    if (resource.resourceType === "ecs_task_definition" && !this.taskFamily(resource.arn || resource.resourceKey).startsWith(`dg-${id.replace(/-/g, "").slice(0, 20)}-`)) throw new BadRequestException("Task definition is outside the project family prefix.");
    if (["ecs_service", "ecs_task"].includes(resource.resourceType) && !/:(?:service|task)\/[^/]+\/[^/]+$/.test(resource.arn || "")) throw new BadRequestException("ECS resource does not contain an exact cluster-scoped ARN.");
    if (resource.resourceType === "ecs_cluster" && !(resource.arn || "").includes(":cluster/")) throw new BadRequestException("ECS cluster ARN is invalid.");
    if (resource.resourceType === "ecr_repository" && !/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(resource.resourceName)) throw new BadRequestException("ECR repository name is unsafe.");
    if (resource.resourceType === "terraform_lockfile" && resource.metadata?.stale !== true) throw new BadRequestException("Only a confirmed stale lockfile can be removed.");
  }

  private taskFamily(value: string) { return value.split("task-definition/")[1]?.split(":")[0] || value; }
}
