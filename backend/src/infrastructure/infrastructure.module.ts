import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ProjectConfigurationSnapshot } from "../projects/project-configuration-snapshot.entity";
import { ProjectDatabaseTier } from "../projects/project-database-tier.entity";
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
 * module only resolves encrypted runtime application configuration.
 */
@Module({
  imports: [TypeOrmModule.forFeature([
    ProjectServiceBinding,
    ProjectPipelineRun,
    ProjectDatabaseTier,
    ProjectEnvironmentVariable,
    ProjectConfigurationSnapshot,
    ProjectPersistentStorage,
    Project,
    ProjectDeploymentGeneration,
  ])],
  providers: [ProjectEnvironmentCryptoService, DatabaseServiceBindingService],
  exports: [DatabaseServiceBindingService],
})
export class InfrastructureModule {}
