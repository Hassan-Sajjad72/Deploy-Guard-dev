import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DeploymentIntent } from "./entities/deployment-intent.entity";
import { InfrastructureManifest } from "./entities/infrastructure-manifest.entity";
import { OrchestrationOutbox } from "./entities/orchestration-outbox.entity";
import { ProjectOperationLease } from "./entities/project-operation-lease.entity";
import { ProjectStateRevision } from "./entities/project-state-revision.entity";
import { ReleaseManifest } from "./entities/release-manifest.entity";
import { WorkerCapability } from "./entities/worker-capability.entity";
import { TransactionalDeploymentPlannerService } from "./planner/transactional-deployment-planner.service";

const entities = [
  InfrastructureManifest,
  ReleaseManifest,
  DeploymentIntent,
  OrchestrationOutbox,
  ProjectOperationLease,
  ProjectStateRevision,
  WorkerCapability,
];

@Module({
  imports: [TypeOrmModule.forFeature(entities)],
  providers: [TransactionalDeploymentPlannerService],
  exports: [TypeOrmModule, TransactionalDeploymentPlannerService],
})
export class OrchestrationContractsModule {}
