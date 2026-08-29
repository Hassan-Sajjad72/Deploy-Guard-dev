import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { InfrastructureModule } from "../infrastructure/infrastructure.module";
import { LogSanitizerService } from "../observability/log-sanitizer.service";
import { UsersModule } from "../users/users.module";
import { DatabaseTierService } from "./database-tier.service";
import { RailpackDeploymentService } from "./railpack-deployment.service";
import { GithubActionsOidcTrustService } from "./github-actions-oidc-trust.service";
import { GithubActionsAwsCapabilityService } from "./github-actions-aws-capability.service";
import { GithubAppInstallation } from "./github-app-installation.entity";
import { GithubAppService } from "./github-app.service";
import { ProjectActivityService } from "./project-activity.service";
import { ProjectConfigurationSnapshot } from "./project-configuration-snapshot.entity";
import { ProjectDatabaseTier } from "./project-database-tier.entity";
import { ProjectEnvironmentCryptoService } from "./project-environment-crypto.service";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { ProjectPipelineEvent } from "./project-pipeline-event.entity";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";
import { GithubActionsService } from "./pipeline/github-actions.service";
import { ProjectServiceBinding } from "./project-service-binding.entity";
import { ProjectUserActivity } from "./project-user-activity.entity";
import { Project } from "./project.entity";
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";
import { ProjectCurrentStateService } from "./current-state/project-current-state.service";
import { PipelineStageResolverService } from "./current-state/pipeline-stage-resolver.service";
import { RepositorySourceService } from "./repository-source.service";
import { User } from "../users/user.entity";
import { ProjectInfrastructureEvent } from "../infrastructure/project-infrastructure-event.entity";
import { ProjectCostEstimate } from "../finops/project-cost-estimate.entity";
import { ProjectCostSettings } from "../finops/project-cost-settings.entity";
import { ProjectTerraformLock } from "../state-management/project-terraform-lock.entity";
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { ProjectStableRelease } from "../orchestration/project-stable-release.entity";
import { ProjectRuntimeMetricSnapshot } from "../observability/project-runtime-metric-snapshot.entity";
import { GithubActionsRuntimeSecretService } from "./github-actions-runtime-secret.service";
import { AwsCliModule } from "../state-management/aws-cli.module";
import { ProjectBackupRecord } from "../storage/project-backup-record.entity";
import { ProjectDeploymentGeneration } from "./project-deployment-generation.entity";
import { ProjectEnvironmentRoute } from "./project-environment-route.entity";
import { DeploymentGenerationService } from "./deployment-generation.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { GithubActionsCostEvidenceService } from "./github-actions-cost-evidence.service";
import { InfracostService } from "../finops/infracost.service";
import { GenerationRetentionService } from "./generation-retention.service";
import { NotificationSubscription } from "../notifications/notification-subscription.entity";
import { ProjectDeletionService } from "./project-deletion.service";
import { SharedPlatformFoundationService } from "./shared-platform-foundation.service";
import { ProductStartSchemaIntegrityService } from "./product-start-schema-integrity.service";
import { LiveRuntimeIdentityRecoveryService } from "./current-state/live-runtime-identity-recovery.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project, User, GithubAppInstallation, ProjectEnvironmentVariable,
      ProjectDatabaseTier, ProjectPipelineRun, ProjectPipelineEvent,
      ProjectServiceBinding, ProjectConfigurationSnapshot, ProjectUserActivity,
      // Historical infrastructure/storage records are not part of ordinary
      // project state authority. Current routing uses generation records.
      ProjectInfrastructureEvent, ProjectCostEstimate, ProjectCostSettings, ProjectTerraformLock,
      ProjectDeployment, ProjectStableRelease, ProjectRuntimeMetricSnapshot,
      ProjectBackupRecord,
      ProjectDeploymentGeneration,
      ProjectEnvironmentRoute,
      NotificationSubscription,
    ]),
    AuditLogModule,
    InfrastructureModule,
    UsersModule,
    AwsCliModule,
    NotificationsModule,
  ],
  controllers: [ProjectsController],
  providers: [
    ProjectsService, GithubAppService, GithubActionsService, RailpackDeploymentService, GithubActionsRuntimeSecretService,
    GithubActionsOidcTrustService, GithubActionsAwsCapabilityService, ProjectEnvironmentCryptoService,
    DatabaseTierService,
    RepositorySourceService,
    PipelineStageResolverService,
    ProjectCurrentStateService,
    ProjectActivityService, LogSanitizerService,
    DeploymentGenerationService,
    InfracostService,
    GithubActionsCostEvidenceService,
    GenerationRetentionService,
    ProjectDeletionService,
    SharedPlatformFoundationService,
    ProductStartSchemaIntegrityService,
    LiveRuntimeIdentityRecoveryService,
  ],
  exports: [ProjectActivityService, ProjectsService, ProjectCurrentStateService, LiveRuntimeIdentityRecoveryService],
})
export class ProjectsModule {}
