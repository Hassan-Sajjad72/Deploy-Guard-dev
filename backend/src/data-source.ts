import "reflect-metadata";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { DataSource } from "typeorm";
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
import { ProjectDetectionProfile } from "./projects/project-detection-profile.entity";
import { ProjectEnvironmentVariable } from "./projects/project-environment-variable.entity";
import { ProjectPipelineEvent } from "./projects/project-pipeline-event.entity";
import { ProjectPipelineRun } from "./projects/project-pipeline-run.entity";
import { ProjectPreflightReport } from "./projects/project-preflight-report.entity";
import { ProjectSecurityFinding } from "./projects/project-security-finding.entity";
import { ProjectSecurityScan } from "./projects/project-security-scan.entity";
import { Project } from "./projects/project.entity";
import { User } from "./users/user.entity";

function loadBackendEnv() {
  const envPath = resolve(__dirname, "..", ".env");

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
  const value = process.env.DATABASE_PORT || process.env.DB_PORT || "5433";
  const port = Number(value);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Invalid database port configuration");
  }

  return port;
}

loadBackendEnv();

export default new DataSource({
  type: "postgres",
  host: process.env.DATABASE_HOST || process.env.DB_HOST || "localhost",
  port: getDatabasePort(),
  username:
    process.env.DATABASE_USERNAME || process.env.DB_USERNAME || "mini_paas_user",
  password:
    process.env.DATABASE_PASSWORD || process.env.DB_PASSWORD || "mini_paas_password",
  database: process.env.DATABASE_NAME || process.env.DB_NAME || "mini_paas",
  ssl:
    process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
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
  migrations: ["src/migrations/*.ts"],
});
