import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, Repository } from "typeorm";
import { ProjectDeploymentContract } from "./project-deployment-contract.entity";
import { Project } from "./project.entity";

/** Transitional release-record access while the workflow moves to Railpack. */
@Injectable()
export class DeploymentContractService {
  constructor(@InjectRepository(ProjectDeploymentContract) private readonly contracts: Repository<ProjectDeploymentContract>) {}

  getForProject(projectId: string, manager?: EntityManager) {
    return (manager?.getRepository(ProjectDeploymentContract) || this.contracts).findOne({ where: { projectId } });
  }

  async requireForProject(projectId: string) {
    const contract = await this.getForProject(projectId);
    if (!contract) throw new NotFoundException("No prior release record exists for this project.");
    return contract;
  }

  assertDeployable(contract: ProjectDeploymentContract, project: Project) {
    if (contract.projectId !== project.id || contract.repositoryFullName !== project.repositoryFullName || contract.branch !== project.targetBranch) {
      throw new BadRequestException("The stored release record does not match the selected repository and branch.");
    }
  }
}
