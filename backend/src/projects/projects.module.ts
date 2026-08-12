import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { InfrastructureModule } from "../infrastructure/infrastructure.module";
import { LogSanitizerService } from "../observability/log-sanitizer.service";
import { UsersModule } from "../users/users.module";
import { DeploymentContractService } from "./deployment-contract.service";
import { DeploymentRequirementsService } from "./deployment-requirements.service";
import { DatabaseTierService } from "./database-tier.service";
import { GithubActionsDeploymentService } from "./github-actions-deployment.service";
import { GithubActionsOidcTrustService } from "./github-actions-oidc-trust.service";
import { GithubActionsAwsCapabilityService } from "./github-actions-aws-capability.service";
import { GithubAppInstallation } from "./github-app-installation.entity";
import { GithubAppService } from "./github-app.service";
import { ProjectActivityService } from "./project-activity.service";
import { ProjectConfigurationSnapshot } from "./project-configuration-snapshot.entity";
import { ProjectDatabaseTier } from "./project-database-tier.entity";
import { ProjectDeploymentContract } from "./project-deployment-contract.entity";
import { ProjectDeploymentRequirements } from "./project-deployment-requirements.entity";
import { ProjectDetectionProfile } from "./project-detection-profile.entity";
import { ProjectEnvironmentCryptoService } from "./project-environment-crypto.service";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { ProjectPipelineEvent } from "./project-pipeline-event.entity";
import { ProjectPipelineJobFinality } from "./pipeline/project-pipeline-job-finality.entity";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";
import { GithubActionsService } from "./pipeline/github-actions.service";
import { ProjectPreflightReport } from "./project-preflight-report.entity";
import { ProjectServiceBinding } from "./project-service-binding.entity";
import { ProjectSecurityScan } from "./project-security-scan.entity";
import { ProjectUserActivity } from "./project-user-activity.entity";
import { Project } from "./project.entity";
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";
import { ProjectCurrentStateService } from "./current-state/project-current-state.service";
import { PipelineStageResolverService } from "./current-state/pipeline-stage-resolver.service";
import { DeploymentProfileService } from "./detection/deployment-profile.service";
import { RepoDeployabilityScannerService } from "./detection/repo-deployability-scanner.service";
import { RepositoryWorkspaceService } from "./detection/repository-workspace.service";
import { StackDetectionService } from "./detection/stack-detection.service";
import { TemplateMatchingService } from "./detection/template-matching.service";
import { MainstreamDetectorResolverService } from "./detection/mainstream-detector-resolver.service";
import { SecurityPolicyService } from "./security/security-policy.service";
import { DockerTemplateEngineService } from "./templates/docker-template-engine.service";
import { PreflightService } from "./templates/preflight.service";
import { TemplateRegistryService } from "./templates/template-registry.service";
import { TemplatesController } from "./templates/templates.controller";
import { User } from "../users/user.entity";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectInfrastructureEvent } from "../infrastructure/project-infrastructure-event.entity";
import { ProjectCostEstimate } from "../finops/project-cost-estimate.entity";
import { ProjectTerraformLock } from "../state-management/project-terraform-lock.entity";
import { ProjectPersistentStorage } from "../storage/project-persistent-storage.entity";
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { ProjectStableRelease } from "../orchestration/project-stable-release.entity";
import { ProjectRuntimeMetricSnapshot } from "../observability/project-runtime-metric-snapshot.entity";
import { GithubActionsRuntimeSecretService } from "./github-actions-runtime-secret.service";
import { AwsCliModule } from "../state-management/aws-cli.module";
import { ProjectBackupRecord } from "../storage/project-backup-record.entity";
import { ManagedDatabaseReconciliationService } from "./managed-database-reconciliation.service";
import { ManagedDatabaseResetService } from "./managed-database-reset.service";
import { DeploymentRecoveryDecisionService } from "./deployment-recovery-decision.service";
import { ProjectDeploymentGeneration } from "./project-deployment-generation.entity";
import { DeploymentGenerationService } from "./deployment-generation.service";
import { LegacyDestroyReadVerifierService } from "./legacy-destroy-read-verifier.service";
import { LegacyDestroyReconciliationService } from "./legacy-destroy-reconciliation.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { GithubActionsCostEvidenceService } from "./github-actions-cost-evidence.service";
import { InfracostService } from "../finops/infracost.service";
import { GenerationRetentionService } from "./generation-retention.service";
import { NotificationSubscription } from "../notifications/notification-subscription.entity";
import { ProjectExtinctionService } from "./project-extinction.service";
import { ProjectDestroyLifecycle } from "./project-destroy-lifecycle.entity";
import { DestroyLifecycleService } from "./destroy-lifecycle.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project, User, GithubAppInstallation, ProjectEnvironmentVariable,
      ProjectDeploymentContract, ProjectDatabaseTier, ProjectDetectionProfile,
      ProjectPreflightReport, ProjectPipelineRun, ProjectPipelineEvent,
      ProjectPipelineJobFinality, ProjectDeploymentRequirements,
      ProjectServiceBinding, ProjectConfigurationSnapshot, ProjectUserActivity, ProjectSecurityScan,
      // Read-only historical evidence remains queryable, but none of its
      // retired mutation providers is registered in this module.
      ProjectInfrastructureEnvironment, ProjectInfrastructureEvent,
      ProjectPersistentStorage, ProjectCostEstimate, ProjectTerraformLock,
      ProjectDeployment, ProjectStableRelease, ProjectRuntimeMetricSnapshot,
      ProjectBackupRecord,
      ProjectDeploymentGeneration,
      NotificationSubscription,
      ProjectDestroyLifecycle,
    ]),
    AuditLogModule,
    InfrastructureModule,
    UsersModule,
    AwsCliModule,
    NotificationsModule,
  ],
  controllers: [ProjectsController, TemplatesController],
  providers: [
    ProjectsService, GithubAppService, GithubActionsService, GithubActionsDeploymentService, GithubActionsRuntimeSecretService,
    GithubActionsOidcTrustService, GithubActionsAwsCapabilityService, ProjectEnvironmentCryptoService,
    DeploymentContractService, DatabaseTierService, DeploymentProfileService,
    RepositoryWorkspaceService, StackDetectionService, RepoDeployabilityScannerService, MainstreamDetectorResolverService,
    TemplateMatchingService, TemplateRegistryService, DockerTemplateEngineService,
    PreflightService, SecurityPolicyService, PipelineStageResolverService,
    DeploymentRequirementsService, ProjectCurrentStateService,
    ProjectActivityService, LogSanitizerService,
    ManagedDatabaseReconciliationService,
    ManagedDatabaseResetService,
    DeploymentRecoveryDecisionService,
    DeploymentGenerationService,
    LegacyDestroyReadVerifierService,
    LegacyDestroyReconciliationService,
    InfracostService,
    GithubActionsCostEvidenceService,
    GenerationRetentionService,
    ProjectExtinctionService,
    DestroyLifecycleService,
  ],
  exports: [ProjectActivityService],
})
export class ProjectsModule {}
