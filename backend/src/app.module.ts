import { MiddlewareConsumer, Module, NestModule, RequestMethod } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AdminModule } from "./admin/admin.module";
import { AiAnalysisMessage } from "./ai-troubleshooting/ai-analysis-message.entity";
import { AiAnalysisResult } from "./ai-troubleshooting/ai-analysis-result.entity";
import { AiAnalysisSession } from "./ai-troubleshooting/ai-analysis-session.entity";
import { AiTroubleshootingModule } from "./ai-troubleshooting/ai-troubleshooting.module";
import { AuditLog } from "./audit-log/audit-log.entity";
import { AuditLogModule } from "./audit-log/audit-log.module";
import { AuthModule } from "./auth/auth.module";
import { AuthenticatedUserMiddleware } from "./common/middleware/authenticated-user.middleware";
import { resolveBackendEnvFile } from "./config/backend-env-file";
import { ProjectCostEstimate } from "./finops/project-cost-estimate.entity";
import { ProjectCostResourceBreakdown } from "./finops/project-cost-resource-breakdown.entity";
import { ProjectCostSettings } from "./finops/project-cost-settings.entity";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";
import { ProjectInfrastructureEnvironment } from "./infrastructure/project-infrastructure-environment.entity";
import { ProjectInfrastructureEvent } from "./infrastructure/project-infrastructure-event.entity";
import { ProjectDeploymentReadinessSnapshot } from "./infrastructure/project-deployment-readiness-snapshot.entity";
import { ProjectServiceDiscoveryRecord } from "./infrastructure/project-service-discovery-record.entity";
import { ProjectLogStreamSession } from "./observability/project-log-stream-session.entity";
import { ProjectObservabilityEvent } from "./observability/project-observability-event.entity";
import { ProjectPipelineMetricSummary } from "./observability/project-pipeline-metric-summary.entity";
import { ProjectRuntimeMetricSnapshot } from "./observability/project-runtime-metric-snapshot.entity";
import { ProjectStageMetric } from "./observability/project-stage-metric.entity";
import { ProjectDeployment } from "./orchestration/project-deployment.entity";
import { ProjectOrchestrationEvent } from "./orchestration/project-orchestration-event.entity";
import { ProjectRollbackRecord } from "./orchestration/project-rollback-record.entity";
import { ProjectSpotInterruptionEvent } from "./orchestration/project-spot-interruption-event.entity";
import { ProjectStableRelease } from "./orchestration/project-stable-release.entity";
import { GithubAppInstallation } from "./projects/github-app-installation.entity";
import { ProjectConfigurationSnapshot } from "./projects/project-configuration-snapshot.entity";
import { ProjectDatabaseTier } from "./projects/project-database-tier.entity";
import { ProjectEnvironmentVariable } from "./projects/project-environment-variable.entity";
import { ProjectPipelineEvent } from "./projects/project-pipeline-event.entity";
import { ProjectPipelineRun } from "./projects/project-pipeline-run.entity";
import { ProjectDeploymentGeneration } from "./projects/project-deployment-generation.entity";
import { ProjectEnvironmentRoute } from "./projects/project-environment-route.entity";
import { ProjectServiceBinding } from "./projects/project-service-binding.entity";
import { ProjectUserActivity } from "./projects/project-user-activity.entity";
import { Project } from "./projects/project.entity";
import { ProjectDeployableService } from "./projects/project-deployable-service.entity";
import { ProjectServiceRuntimeConfigRevision } from "./projects/project-service-runtime-config-revision.entity";
import { ProjectGenerationServiceRevision } from "./projects/project-generation-service-revision.entity";
import { ProjectsModule } from "./projects/projects.module";
import { ProjectTerraformLock } from "./state-management/project-terraform-lock.entity";
import { ProjectTerraformState } from "./state-management/project-terraform-state.entity";
import { ProjectDeploymentQueueItem } from "./state-management/project-deployment-queue-item.entity";
import { ProjectStateRecoveryRequest } from "./state-management/project-state-recovery-request.entity";
import { ProjectStateValidationResult } from "./state-management/project-state-validation-result.entity";
import { ProjectBackupRecord } from "./storage/project-backup-record.entity";
import { ProjectPersistentStorage } from "./storage/project-persistent-storage.entity";
import { ProjectStorageEvent } from "./storage/project-storage-event.entity";
import { ProjectStorageRestoreRequest } from "./storage/project-storage-restore-request.entity";
import { TerraformExportArtifact } from "./terraform-export/terraform-export-artifact.entity";
import { TerraformExportModule } from "./terraform-export/terraform-export.module";
import { User } from "./users/user.entity";
import { UsersModule } from "./users/users.module";
import { NotificationDelivery } from "./notifications/notification-delivery.entity";
import { NotificationPreference } from "./notifications/notification-preference.entity";
import { NotificationSubscription } from "./notifications/notification-subscription.entity";
import { ObservabilityModule } from "./observability/observability.module";

/** The supported local product: PostgreSQL + authenticated GitHub App + GitHub Actions. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: resolveBackendEnvFile() }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres" as const,
        host: config.get<string>("DATABASE_HOST", "localhost"),
        port: Number(config.get<string>("DATABASE_PORT", "5432")),
        username: config.get<string>("DATABASE_USERNAME", "mini_paas_user"),
        password: config.get<string>("DATABASE_PASSWORD", "mini_paas_password"),
        database: config.get<string>("DATABASE_NAME", "mini_paas"),
        // Historical deployment/audit rows remain readable. Registering an
        // entity does not activate its retired mutation provider.
        entities: [
          User, AuditLog, Project, ProjectDeployableService, ProjectServiceRuntimeConfigRevision, ProjectGenerationServiceRevision, GithubAppInstallation, ProjectEnvironmentVariable,
          ProjectDatabaseTier,
          ProjectServiceBinding, ProjectConfigurationSnapshot,
          ProjectPipelineRun, ProjectDeploymentGeneration, ProjectEnvironmentRoute,
          ProjectPipelineEvent, ProjectUserActivity,
          ProjectCostEstimate,
          ProjectCostResourceBreakdown, ProjectCostSettings,
          ProjectInfrastructureEnvironment, ProjectInfrastructureEvent,
          ProjectServiceDiscoveryRecord, ProjectDeploymentReadinessSnapshot,
          ProjectTerraformState, ProjectTerraformLock, ProjectDeploymentQueueItem,
          ProjectStateValidationResult, ProjectStateRecoveryRequest,
          ProjectPersistentStorage, ProjectStorageEvent, ProjectBackupRecord,
          ProjectStorageRestoreRequest, ProjectDeployment, ProjectStableRelease,
          ProjectOrchestrationEvent, ProjectSpotInterruptionEvent, ProjectRollbackRecord,
          ProjectStageMetric, ProjectPipelineMetricSummary, ProjectRuntimeMetricSnapshot,
          ProjectLogStreamSession, ProjectObservabilityEvent, TerraformExportArtifact,
          AiAnalysisSession, AiAnalysisMessage, AiAnalysisResult,
          NotificationPreference, NotificationSubscription, NotificationDelivery,
        ],
        synchronize: false,
        logging: ["error", "warn"],
        ssl: config.get<string>("DATABASE_SSL", "false") === "true" ? { rejectUnauthorized: false } : false,
      }),
    }),
    AuthModule, UsersModule, AdminModule, AuditLogModule, ProjectsModule,
    TerraformExportModule, AiTroubleshootingModule, ObservabilityModule,
  ],
  controllers: [HealthController],
  providers: [AuthenticatedUserMiddleware, HealthService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Authentication is attached, never bypassed, for every API route. Public
    // health and OAuth entry points simply continue with an anonymous request.
    consumer.apply(AuthenticatedUserMiddleware).forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}
