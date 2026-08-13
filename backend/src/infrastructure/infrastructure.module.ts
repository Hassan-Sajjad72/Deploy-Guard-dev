import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ProjectConfigurationSnapshot } from "../projects/project-configuration-snapshot.entity";
import { ProjectDatabaseTier } from "../projects/project-database-tier.entity";
import { ProjectDeploymentContract } from "../projects/project-deployment-contract.entity";
import { ProjectDetectionProfile } from "../projects/project-detection-profile.entity";
import { ProjectEnvironmentCryptoService } from "../projects/project-environment-crypto.service";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { ProjectServiceBinding } from "../projects/project-service-binding.entity";
import { ProjectPersistentStorage } from "../storage/project-persistent-storage.entity";
import { Project } from "../projects/project.entity";
import { DatabaseServiceBindingService } from "./database-service-binding.service";
import { ProjectDeploymentGeneration } from "../projects/project-deployment-generation.entity";

/**
 * Product infrastructure boundary. GitHub Actions owns all mutation; this
 * module only resolves encrypted application configuration for detection and
 * pre-flight. Retired REST, queue and Terraform-runner providers are not
 * registered here.
 */
@Module({
  imports: [TypeOrmModule.forFeature([
    ProjectServiceBinding,
    ProjectPipelineRun,
    ProjectDeploymentContract,
    ProjectDatabaseTier,
    ProjectEnvironmentVariable,
    ProjectConfigurationSnapshot,
    ProjectDetectionProfile,
    ProjectPersistentStorage,
    Project,
    ProjectDeploymentGeneration,
  ])],
  providers: [ProjectEnvironmentCryptoService, DatabaseServiceBindingService],
  exports: [DatabaseServiceBindingService],
})
export class InfrastructureModule {}
