import "reflect-metadata";
import { existsSync, readFileSync } from "fs";
import { DataSource } from "typeorm";
import { resolveBackendEnvFile } from "./config/backend-env-file";
import { AuditLog } from "./audit-log/audit-log.entity";
import { ProjectCostEstimate } from "./finops/project-cost-estimate.entity";
import { ProjectCostResourceBreakdown } from "./finops/project-cost-resource-breakdown.entity";
import { ProjectCostSettings } from "./finops/project-cost-settings.entity";
import { ProjectDeploymentReadinessSnapshot } from "./infrastructure/project-deployment-readiness-snapshot.entity";
import { ProjectInfrastructureEnvironment } from "./infrastructure/project-infrastructure-environment.entity";
import { ProjectInfrastructureEvent } from "./infrastructure/project-infrastructure-event.entity";
import { ProjectServiceDiscoveryRecord } from "./infrastructure/project-service-discovery-record.entity";
import { ProjectDeployment } from "./orchestration/project-deployment.entity";
import { ProjectOrchestrationEvent } from "./orchestration/project-orchestration-event.entity";
import { ProjectRollbackRecord } from "./orchestration/project-rollback-record.entity";
import { ProjectSpotInterruptionEvent } from "./orchestration/project-spot-interruption-event.entity";
import { ProjectStableRelease } from "./orchestration/project-stable-release.entity";
import { ProjectLogStreamSession } from "./observability/project-log-stream-session.entity";
import { ProjectObservabilityEvent } from "./observability/project-observability-event.entity";
import { ProjectPipelineMetricSummary } from "./observability/project-pipeline-metric-summary.entity";
import { ProjectRuntimeMetricSnapshot } from "./observability/project-runtime-metric-snapshot.entity";
import { ProjectStageMetric } from "./observability/project-stage-metric.entity";
import { ProjectDeploymentQueueItem } from "./state-management/project-deployment-queue-item.entity";
import { ProjectStateRecoveryRequest } from "./state-management/project-state-recovery-request.entity";
import { ProjectStateValidationResult } from "./state-management/project-state-validation-result.entity";
import { ProjectTerraformLock } from "./state-management/project-terraform-lock.entity";
import { ProjectTerraformState } from "./state-management/project-terraform-state.entity";
import { ProjectBackupRecord } from "./storage/project-backup-record.entity";
import { ProjectPersistentStorage } from "./storage/project-persistent-storage.entity";
import { ProjectStorageEvent } from "./storage/project-storage-event.entity";
import { ProjectStorageRestoreRequest } from "./storage/project-storage-restore-request.entity";
import { ProjectDatabaseTier } from "./projects/project-database-tier.entity";
import { ProjectEnvironmentVariable } from "./projects/project-environment-variable.entity";
import { ProjectPipelineEvent } from "./projects/project-pipeline-event.entity";
import { ProjectUserActivity } from "./projects/project-user-activity.entity";
import { ProjectPipelineRun } from "./projects/project-pipeline-run.entity";
import { ProjectDeploymentGeneration } from "./projects/project-deployment-generation.entity";
import { ProjectEnvironmentRoute } from "./projects/project-environment-route.entity";
import { Project } from "./projects/project.entity";
import { User } from "./users/user.entity";
import { AiAnalysisSession } from "./ai-troubleshooting/ai-analysis-session.entity";
import { AiAnalysisMessage } from "./ai-troubleshooting/ai-analysis-message.entity";
import { AiAnalysisResult } from "./ai-troubleshooting/ai-analysis-result.entity";
import { BillingAccount } from "./billing/billing-account.entity";
import { BillingSubscription } from "./billing/billing-subscription.entity";
import { BillingUsageCounter } from "./billing/billing-usage-counter.entity";
import { BillingUsageEvent } from "./billing/billing-usage-event.entity";
import { BillingCheckoutSession } from "./billing/billing-checkout-session.entity";
import { BillingInvoice } from "./billing/billing-invoice.entity";
import { BillingWebhookEvent } from "./billing/billing-webhook-event.entity";
import { NotificationPreference } from "./notifications/notification-preference.entity";
import { NotificationSubscription } from "./notifications/notification-subscription.entity";
import { NotificationDelivery } from "./notifications/notification-delivery.entity";
import { DestroyChallenge } from "./infrastructure-lifecycle/destroy-challenge.entity";
import { DestroyOperation } from "./infrastructure-lifecycle/destroy-operation.entity";
import { CentralCloudResource } from "./infrastructure-lifecycle/central-cloud-resource.entity";
import { CentralCleanupChallenge } from "./infrastructure-lifecycle/central-cleanup-challenge.entity";
import { TerraformExportArtifact } from "./terraform-export/terraform-export-artifact.entity";
import { CloudInventoryScan } from "./infrastructure-lifecycle/cloud-inventory-scan.entity";
import { EmergencyCleanupOperation } from "./infrastructure-lifecycle/emergency-cleanup-operation.entity";
import { CloudCleanupOperation } from "./infrastructure-lifecycle/cloud-cleanup-operation.entity";
import { ProjectCloudState } from "./infrastructure-lifecycle/project-cloud-state.entity";
import { ProjectStageCheckpoint } from "./projects/recovery/project-stage-checkpoint.entity";
import { ProjectServiceBinding } from "./projects/project-service-binding.entity";
import { ProjectConfigurationSnapshot } from "./projects/project-configuration-snapshot.entity";
import { GithubAppInstallation } from "./projects/github-app-installation.entity";
import { ProjectDeployableService } from "./projects/project-deployable-service.entity";
import { ProjectServiceRuntimeConfigRevision } from "./projects/project-service-runtime-config-revision.entity";
import { ProjectGenerationServiceRevision } from "./projects/project-generation-service-revision.entity";

function loadBackendEnv() {
  const envPath = resolveBackendEnvFile();

  if (!existsSync(envPath)) {
    return;
  }

  const envFile = readFileSync(envPath, "utf8");

  for (const line of envFile.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function getDatabasePort() {
  // Migrations and the running API share one explicit canonical endpoint.
  const value = process.env.DATABASE_PORT || "5432";
  const port = Number(value);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Invalid database port configuration");
  }

  return port;
}

loadBackendEnv();

export default new DataSource({
  type: "postgres",
  host: process.env.DATABASE_HOST || "localhost",
  port: getDatabasePort(),
  username:
    process.env.DATABASE_USERNAME || "mini_paas_user",
  password: process.env.DATABASE_PASSWORD || "mini_paas_password",
  database: process.env.DATABASE_NAME || "mini_paas",
  ssl:
    process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
  entities: [
    User,
    AuditLog,
    Project,
    ProjectDeployableService,
    ProjectServiceRuntimeConfigRevision,
    ProjectGenerationServiceRevision,
    ProjectEnvironmentVariable,
    ProjectDatabaseTier,
    ProjectPipelineRun,
    ProjectDeploymentGeneration,
    ProjectEnvironmentRoute,
    ProjectPipelineEvent,
    ProjectUserActivity,
    ProjectStageCheckpoint,
    ProjectServiceBinding,
    ProjectConfigurationSnapshot,
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
    AiAnalysisSession,
    AiAnalysisMessage,
    AiAnalysisResult,
    BillingAccount,
    BillingSubscription,
    BillingUsageCounter,
    BillingUsageEvent,
    BillingCheckoutSession,
    BillingInvoice,
    BillingWebhookEvent,
    NotificationPreference,
    NotificationSubscription,
    NotificationDelivery,
    DestroyChallenge,
    DestroyOperation,
    CentralCloudResource,
    CentralCleanupChallenge,
    TerraformExportArtifact,
    CloudInventoryScan,
    EmergencyCleanupOperation,
    CloudCleanupOperation,
    ProjectCloudState,
    GithubAppInstallation,
  ],
  migrations: ["src/migrations/*.ts"],
});
