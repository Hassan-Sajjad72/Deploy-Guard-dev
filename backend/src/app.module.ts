import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AdminModule } from "./admin/admin.module";
import { AuditLogModule } from "./audit-log/audit-log.module";
import { AuditLog } from "./audit-log/audit-log.entity";
import { AuthModule } from "./auth/auth.module";
import { AuthenticatedUserMiddleware } from "./common/middleware/authenticated-user.middleware";
import { FinopsModule } from "./finops/finops.module";
import { ProjectCostEstimate } from "./finops/project-cost-estimate.entity";
import { ProjectCostResourceBreakdown } from "./finops/project-cost-resource-breakdown.entity";
import { ProjectCostSettings } from "./finops/project-cost-settings.entity";
import { InfrastructureModule } from "./infrastructure/infrastructure.module";
import { ProjectDeploymentReadinessSnapshot } from "./infrastructure/project-deployment-readiness-snapshot.entity";
import { OrchestrationModule } from "./orchestration/orchestration.module";
import { ObservabilityModule } from "./observability/observability.module";
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
import { ProjectInfrastructureEnvironment } from "./infrastructure/project-infrastructure-environment.entity";
import { ProjectInfrastructureEvent } from "./infrastructure/project-infrastructure-event.entity";
import { ProjectServiceDiscoveryRecord } from "./infrastructure/project-service-discovery-record.entity";
import { StateManagementModule } from "./state-management/state-management.module";
import { ProjectDeploymentQueueItem } from "./state-management/project-deployment-queue-item.entity";
import { ProjectStateRecoveryRequest } from "./state-management/project-state-recovery-request.entity";
import { ProjectStateValidationResult } from "./state-management/project-state-validation-result.entity";
import { ProjectTerraformLock } from "./state-management/project-terraform-lock.entity";
import { ProjectTerraformState } from "./state-management/project-terraform-state.entity";
import { StorageModule } from "./storage/storage.module";
import { ProjectBackupRecord } from "./storage/project-backup-record.entity";
import { ProjectPersistentStorage } from "./storage/project-persistent-storage.entity";
import { ProjectStorageEvent } from "./storage/project-storage-event.entity";
import { ProjectStorageRestoreRequest } from "./storage/project-storage-restore-request.entity";
import { ProjectEnvironmentVariable } from "./projects/project-environment-variable.entity";
import { ProjectDetectionProfile } from "./projects/project-detection-profile.entity";
import { ProjectPreflightReport } from "./projects/project-preflight-report.entity";
import { ProjectPipelineEvent } from "./projects/project-pipeline-event.entity";
import { ProjectPipelineRun } from "./projects/project-pipeline-run.entity";
import { ProjectSecurityFinding } from "./projects/project-security-finding.entity";
import { ProjectSecurityScan } from "./projects/project-security-scan.entity";
import { Project } from "./projects/project.entity";
import { ProjectsModule } from "./projects/projects.module";
import { UsersModule } from "./users/users.module";
import { User } from "./users/user.entity";

/**
 * AppModule
 * ---------
 * The ROOT module — the starting point of the entire NestJS app.
 * Every other module is imported here.
 *
 * Key parts:
 * 1. ConfigModule → reads .env file and makes variables available everywhere
 * 2. TypeOrmModule → connects to PostgreSQL using the env variables
 * 3. AuthModule → authentication routes
 * 4. UsersModule → user database operations
 */
@Module({
  imports: [
    /**
     * ConfigModule
     * Reads the .env file and loads all variables.
     * isGlobal: true = no need to import ConfigModule in every other module.
     */
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
    }),

    /**
     * TypeOrmModule — THE DATABASE CONNECTION
     * ----------------------------------------
     * This is where we connect to PostgreSQL.
     * useFactory lets us use ConfigService to read .env values.
     *
     * What each option does:
     * - type: "postgres"       → we're using PostgreSQL
     * - host: DB_HOST          → usually "localhost"
     * - port: DB_PORT          → usually 5432 (PostgreSQL's default port)
     * - username: DB_USERNAME  → your PostgreSQL username (usually "postgres")
     * - password: DB_PASSWORD  → your PostgreSQL password
     * - database: DB_NAME      → the database name you created in pgAdmin
     * - entities              → which TypeScript classes = database tables
     * - synchronize            → local convenience only; forced off by default in production
     * - logging: true          → prints SQL queries to console (helps debugging)
     */
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres",
        host: config.get<string>(
          "DATABASE_HOST",
          config.get<string>("DB_HOST", "localhost")
        ),
        port: Number(
          config.get<string>("DATABASE_PORT", config.get<string>("DB_PORT", "5432"))
        ),
        username: config.get<string>(
          "DATABASE_USERNAME",
          config.get<string>("DB_USERNAME", "mini_paas_user")
        ),
        password: config.get<string>(
          "DATABASE_PASSWORD",
          config.get<string>("DB_PASSWORD", "mini_paas_password")
        ),
        database: config.get<string>(
          "DATABASE_NAME",
          config.get<string>("DB_NAME", "mini_paas")
        ),
        entities: [
          User,
          AuditLog,
          Project,
          ProjectEnvironmentVariable,
          ProjectDetectionProfile,
          ProjectPreflightReport,
          ProjectPipelineRun,
          ProjectPipelineEvent,
          ProjectSecurityScan,
          ProjectSecurityFinding,
          ProjectCostEstimate,
          ProjectCostResourceBreakdown,
          ProjectCostSettings,
          ProjectInfrastructureEnvironment,
          ProjectInfrastructureEvent,
          ProjectServiceDiscoveryRecord,
          ProjectDeploymentReadinessSnapshot,
          ProjectTerraformState,
          ProjectTerraformLock,
          ProjectDeploymentQueueItem,
          ProjectStateValidationResult,
          ProjectStateRecoveryRequest,
          ProjectPersistentStorage,
          ProjectStorageEvent,
          ProjectBackupRecord,
          ProjectStorageRestoreRequest,
          ProjectDeployment,
          ProjectStableRelease,
          ProjectOrchestrationEvent,
          ProjectSpotInterruptionEvent,
          ProjectRollbackRecord,
          ProjectStageMetric,
          ProjectPipelineMetricSummary,
          ProjectRuntimeMetricSnapshot,
          ProjectLogStreamSession,
          ProjectObservabilityEvent,
        ],
        synchronize:
          config.get<string>(
            "TYPEORM_SYNCHRONIZE",
            config.get<string>("NODE_ENV") === "production" ? "false" : "true"
          ) === "true",
        logging: ["error", "warn"],
        ssl:
          config.get<string>("DATABASE_SSL", "false") === "true"
            ? { rejectUnauthorized: false }
            : false,
      }),
    }),

    AuthModule,
    UsersModule,
    AdminModule,
    AuditLogModule,
    ProjectsModule,
    FinopsModule,
    InfrastructureModule,
    StateManagementModule,
    StorageModule,
    OrchestrationModule,
    ObservabilityModule,
  ],
  providers: [AuthenticatedUserMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthenticatedUserMiddleware).forRoutes(
      { path: "api/admin/users", method: RequestMethod.ALL },
      { path: "api/admin/users/:userId/role", method: RequestMethod.ALL },
      { path: "api/audit-logs", method: RequestMethod.ALL },
      { path: "api/auth/me", method: RequestMethod.ALL },
      { path: "auth/me", method: RequestMethod.ALL },
      { path: "api/projects", method: RequestMethod.ALL },
      { path: "api/projects/github/repositories", method: RequestMethod.ALL },
      { path: "api/projects/github/repositories/:owner/:repository/branches", method: RequestMethod.ALL },
      { path: "api/projects/:projectId", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/detect-stack", method: RequestMethod.ALL },
      {
        path: "api/projects/:projectId/detection-profile",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/current-state",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/automation/start",
        method: RequestMethod.ALL,
      },
      { path: "api/projects/:projectId/preflight", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/pipeline/runs", method: RequestMethod.ALL },
      {
        path: "api/projects/:projectId/pipeline/runs/:runId",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/pipeline/runs/:runId/events",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/pipeline/runs/:runId/cancel",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/pipeline/runs/:runId/retry",
        method: RequestMethod.ALL,
      },
      { path: "api/projects/:projectId/security-scans", method: RequestMethod.ALL },
      {
        path: "api/projects/:projectId/security-scans/:scanId",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/security-scans/:scanId/findings",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/security-scans/:scanId/approve",
        method: RequestMethod.ALL,
      },
      { path: "api/projects/:projectId/cost-estimates", method: RequestMethod.ALL },
      {
        path: "api/projects/:projectId/cost-estimates/latest",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/cost-estimates/:estimateId",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/cost-estimates/:estimateId/approve",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/cost-estimates/:estimateId/reject",
        method: RequestMethod.ALL,
      },
      { path: "api/projects/:projectId/cost-settings", method: RequestMethod.ALL },
      {
        path: "api/projects/:projectId/deployment-readiness",
        method: RequestMethod.ALL,
      },
      { path: "api/projects/:projectId/deploy", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/infrastructure", method: RequestMethod.ALL },
      {
        path: "api/projects/:projectId/infrastructure/plan",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/infrastructure/apply",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/infrastructure/events",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/service-discovery",
        method: RequestMethod.ALL,
      },
      { path: "api/projects/:projectId/state", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/state/versions", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/state/locks", method: RequestMethod.ALL },
      {
        path: "api/projects/:projectId/state/locks/:lockId/force-release",
        method: RequestMethod.ALL,
      },
      { path: "api/projects/:projectId/state/validation", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/state/validate", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/state/recover", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/storage", method: RequestMethod.ALL },
      {
        path: "api/projects/:projectId/storage/recommendation",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/storage/settings",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/storage/provision",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/storage/events",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/storage/mount-config",
        method: RequestMethod.ALL,
      },
      { path: "api/projects/:projectId/backups", method: RequestMethod.ALL },
      {
        path: "api/projects/:projectId/backups/restore-request",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/orchestration",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/orchestration/status",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/orchestration/events",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/orchestration/releases",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/orchestration/deploy",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/orchestration/rollback",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/orchestration/target-health",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/orchestration/scaling",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/observability",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/observability/summary",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/observability/pipeline-metrics",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/observability/runtime-metrics",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/observability/logs",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/observability/logs/stream",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/observability/health",
        method: RequestMethod.ALL,
      },
      { path: "api/projects/:projectId/repository", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/branches", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/branch", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/env", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/env/:envId", method: RequestMethod.ALL },
      { path: "api/templates", method: RequestMethod.ALL }
    );
  }
}
