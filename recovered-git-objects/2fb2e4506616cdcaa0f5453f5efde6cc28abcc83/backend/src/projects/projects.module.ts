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
import { RepoDeployabilityScannerService } from "./detection/repo-deployability-scanner.service";
import { TemplateMatchingService } from "./detection/template-matching.service";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { ProjectDeploymentContract } from "./project-deployment-contract.entity";
import { ProjectDatabaseTier } from "./project-database-tier.entity";
import { DatabaseTierService } from "./database-tier.service";
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
import { PipelineActivityService } from "./pipeline/pipeline-activity.service";
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
import { ProjectInfrastructureEvent } from "../infrastructure/project-infrastructure-event.entity";
import { ProjectRuntimeMetricSnapshot } from "../observability/project-runtime-metric-snapshot.entity";
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { ProjectStableRelease } from "../orchestration/project-stable-release.entity";
import { ProjectTerraformLock } from "../state-management/project-terraform-lock.entity";
import { ProjectPersistentStorage } from "../storage/project-persistent-storage.entity";
import { ProjectCurrentStateService } from "./current-state/project-current-state.service";
import { PipelineStageResolverService } from "./current-state/pipeline-stage-resolver.service";
import { UsersModule } from "../users/users.module";
import { DockerfileSecurityService } from "./security/dockerfile-security.service";
import { BillingModule } from "../billing/billing.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { DeploymentContractService } from "./deployment-contract.service";
import { ProjectEnvironmentCryptoService } from "./project-environment-crypto.service";
import { ResourceRegistryModule } from "../resource-registry/resource-registry.module";
import { InfrastructureLifecycleModule } from "../infrastructure-lifecycle/infrastructure-lifecycle.module";
import { DeploymentCheckpointService } from "./recovery/deployment-checkpoint.service";
import { DeploymentRecoveryPlanner } from "./recovery/deployment-recovery-planner.service";
import { DatabaseRequirementAnalyzer } from "./recovery/database-requirement-analyzer.service";
import { EcsDiagnosticsClassifier } from "./recovery/ecs-diagnostics-classifier.service";
import { PreflightIssueMapper } from "./recovery/preflight-issue-mapper.service";
import { ProjectStageCheckpoint } from "./recovery/project-stage-checkpoint.entity";
import { StageCheckpointService } from "./recovery/stage-checkpoint.service";
import { StageSelectiveResumeService } from "./recovery/stage-selective-resume.service";
import { StorageRequirementAnalyzer } from "./recovery/storage-requirement-analyzer.service";
import { ProjectDeploymentRequirements } from "./project-deployment-requirements.entity";
import { DeploymentRequirementsService } from "./deployment-requirements.service";
import { StateManagementModule } from "../state-management/state-management.module";
import { ProjectUserActivity } from "./project-user-activity.entity";
import { ProjectActivityService } from "./project-activity.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectEnvironmentVariable,
      ProjectDeploymentContract,
      ProjectDatabaseTier,
      ProjectDetectionProfile,
      ProjectPreflightReport,
      ProjectPipelineRun,
      ProjectPipelineEvent,
      ProjectSecurityScan,
      ProjectSecurityFinding,
      ProjectCostEstimate,
      ProjectInfrastructureEnvironment,
      ProjectInfrastructureEvent,
      ProjectTerraformLock,
      ProjectPersistentStorage,
      ProjectDeployment,
      ProjectStableRelease,
      ProjectRuntimeMetricSnapshot,
      ProjectStageCheckpoint,
      ProjectDeploymentRequirements,
      ProjectUserActivity,
      User,
    ]),
    AuditLogModule,
    FinopsModule,
    InfrastructureModule,
    OrchestrationModule,
    ObservabilityModule,
    StorageModule,
    UsersModule,
    BillingModule,
    NotificationsModule,
    ResourceRegistryModule,
    InfrastructureLifecycleModule,
    StateManagementModule,
  ],
  controllers: [ProjectsController, TemplatesController],
  providers: [
    ProjectsService,
    ProjectEnvironmentCryptoService,
    DeploymentContractService,
    DatabaseTierService,
    DeploymentProfileService,
    RepositoryWorkspaceService,
    StackDetectionService,
    RepoDeployabilityScannerService,
    TemplateMatchingService,
    TemplateRegistryService,
    DockerTemplateEngineService,
    PreflightService,
    pipelineQueueProvider,
    PipelineActivityService,
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
    DeploymentCheckpointService,
    PreflightIssueMapper,
    EcsDiagnosticsClassifier,
    DatabaseRequirementAnalyzer,
    StorageRequirementAnalyzer,
    DeploymentRecoveryPlanner,
    StageCheckpointService,
    StageSelectiveResumeService,
    DeploymentRequirementsService,
    ProjectCurrentStateService,
    ProjectActivityService,
  ],
  exports: [ProjectActivityService],
})
export class ProjectsModule {}
