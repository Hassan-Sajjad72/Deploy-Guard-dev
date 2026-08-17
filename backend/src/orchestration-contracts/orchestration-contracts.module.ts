import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { ProjectDeploymentContract } from "../projects/project-deployment-contract.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { ProjectPreflightReport } from "../projects/project-preflight-report.entity";
import { ProjectSecurityScan } from "../projects/project-security-scan.entity";
import { Project } from "../projects/project.entity";
import { DeploymentIntent } from "./entities/deployment-intent.entity";
import { DeploymentSideEffect } from "./entities/deployment-side-effect.entity";
import { InfrastructureManifest } from "./entities/infrastructure-manifest.entity";
import { InitialReleaseDraft } from "./entities/initial-release-draft.entity";
import { OrchestrationOutbox } from "./entities/orchestration-outbox.entity";
import { ReleaseManifest } from "./entities/release-manifest.entity";
import { NormalReleaseLaneStatusService } from "./release-lane/normal-release-lane-status.service";

const readModelEntities = [
  Project,
  ProjectPipelineRun,
  ProjectDeploymentContract,
  ProjectPreflightReport,
  ProjectSecurityScan,
  ProjectDeployment,
  DeploymentIntent,
  DeploymentSideEffect,
  InfrastructureManifest,
  InitialReleaseDraft,
  OrchestrationOutbox,
  ReleaseManifest,
];

@Module({
  imports: [TypeOrmModule.forFeature(readModelEntities)],
  providers: [NormalReleaseLaneStatusService],
  exports: [TypeOrmModule, NormalReleaseLaneStatusService],
})
export class OrchestrationContractsModule {}
