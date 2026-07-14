import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { FinopsModule } from "../finops/finops.module";
import { InfrastructureModule } from "../infrastructure/infrastructure.module";
import { OrchestrationModule } from "../orchestration/orchestration.module";
import { ObservabilityModule } from "../observability/observability.module";
import { StorageModule } from "../storage/storage.module";
import { DeploymentProfileService } from "./detection/deployment-profile.service";
import { RepositoryWorkspaceService } from "./detection/repository-workspace.service";
import { StackDetectionService } from "./detection/stack-detection.service";
import { TemplateMatchingService } from "./detection/template-matching.service";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { ProjectDetectionProfile } from "./project-detection-profile.entity";
import { ProjectPreflightReport } from "./project-preflight-report.entity";
import { ProjectPipelineEvent } from "./project-pipeline-event.entity";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";
import { ProjectSecurityFinding } from "./project-security-finding.entity";
import { ProjectSecurityScan } from "./project-security-scan.entity";
import { Project } from "./project.entity";
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";
import { DockerBuildService } from "./pipeline/docker-build.service";
import { EcrService } from "./pipeline/ecr.service";
import { GithubActionsService } from "./pipeline/github-actions.service";
import { PipelineService } from "./pipeline/pipeline.service";
import { PipelineWorkerService } from "./pipeline/pipeline-worker.service";
import { pipelineQueueProvider } from "./pipeline/pipeline.queue";
import { TerraformService } from "./pipeline/terraform.service";
import { RemediationService } from "./security/remediation.service";
import { SecurityPolicyService } from "./security/security-policy.service";
import { SecurityScanService } from "./security/security-scan.service";
import { TrivyParserService } from "./security/trivy-parser.service";
import { TrivyScannerService } from "./security/trivy-scanner.service";
import { DockerTemplateEngineService } from "./templates/docker-template-engine.service";
import { PreflightService } from "./templates/preflight.service";
import { TemplateRegistryService } from "./templates/template-registry.service";
import { TemplatesController } from "./templates/templates.controller";
import { User } from "../users/user.entity";
import { ProjectCostEstimate } from "../finops/project-cost-estimate.entity";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectRuntimeMetricSnapshot } from "../observability/project-runtime-metric-snapshot.entity";
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { ProjectStableRelease } from "../orchestration/project-stable-release.entity";
import { ProjectTerraformLock } from "../state-management/project-terraform-lock.entity";
import { ProjectPersistentStorage } from "../storage/project-persistent-storage.entity";
import { ProjectCurrentStateService } from "./current-state/project-current-state.service";
import { PipelineStageResolverService } from "./current-state/pipeline-stage-resolver.service";
import { UsersModule } from "../users/users.module";
import { DockerfileSecurityService } from "./security/dockerfile-security.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectEnvironmentVariable,
      ProjectDetectionProfile,
      ProjectPreflightReport,
      ProjectPipelineRun,
      ProjectPipelineEvent,
      ProjectSecurityScan,
      ProjectSecurityFinding,
      ProjectCostEstimate,
      ProjectInfrastructureEnvironment,
      ProjectTerraformLock,
      ProjectPersistentStorage,
      ProjectDeployment,
      ProjectStableRelease,
      ProjectRuntimeMetricSnapshot,
      User,
    ]),
    AuditLogModule,
    FinopsModule,
    InfrastructureModule,
    OrchestrationModule,
    ObservabilityModule,
    StorageModule,
    UsersModule,
  ],
  controllers: [ProjectsController, TemplatesController],
  providers: [
    ProjectsService,
    DeploymentProfileService,
    RepositoryWorkspaceService,
    StackDetectionService,
    TemplateMatchingService,
    TemplateRegistryService,
    DockerTemplateEngineService,
    PreflightService,
    pipelineQueueProvider,
    PipelineService,
    PipelineWorkerService,
    GithubActionsService,
    DockerBuildService,
    EcrService,
    TerraformService,
    TrivyScannerService,
    TrivyParserService,
    SecurityPolicyService,
    DockerfileSecurityService,
    RemediationService,
    SecurityScanService,
    PipelineStageResolverService,
    ProjectCurrentStateService,
  ],
})
export class ProjectsModule {}
