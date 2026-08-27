import { Injectable } from "@nestjs/common";
import { ProjectDatabaseTier } from "../project-database-tier.entity";
import { ProjectDeploymentContract } from "../project-deployment-contract.entity";

export type DatabaseRecoverySignal = { code: string; message: string };

@Injectable()
export class DatabaseRequirementAnalyzer {
  analyze(contract: ProjectDeploymentContract | null, tier: ProjectDatabaseTier | null, evidence: string): DatabaseRecoverySignal | null {
    if (/DB_HOST[^\n]*(?:127\.0\.0\.1|localhost)|DATABASE_URL[^\n]*(?:127\.0\.0\.1|localhost)|database (?:host|endpoint)[^\n]*(?:127\.0\.0\.1|localhost)/i.test(evidence)) {
      return { code: "database_localhost_config", message: this.line(evidence, /DB_HOST|DATABASE_URL|database (?:host|endpoint)/i) };
    }
    if (contract?.databaseRequired && (!tier?.provider || tier.provider === "none")) {
      return { code: "database_required_but_not_configured", message: `Detected database engine: ${contract.databaseEngine || "database"}.` };
    }
    if (!tier) return null;
    const problem = [tier.lastError, evidence].filter(Boolean).join("\n");
    if (/database[^\n]*(?:EFS|mount)|(?:EFS|mount)[^\n]*database/i.test(problem)) return { code: "database_efs_mount_failed", message: tier.lastError || this.line(problem, /EFS|mount/i) };
    if (tier.status === "unhealthy" || /database[^\n]*(?:credentials|connection|migration|backup|unhealthy)|password authentication failed|authentication failed|ECONNREFUSED[^\n]*(?:5432|3306|27017)/i.test(problem)) {
      const code = /credential|password authentication/i.test(problem)
        ? "database_credentials_invalid"
        : /migration/i.test(problem)
          ? "database_migration_failed"
          : /backup/i.test(problem)
            ? "database_backup_not_configured"
            : /connection refused|ECONNREFUSED/i.test(problem)
              ? "database_connection_refused"
              : "database_service_unhealthy";
      return { code, message: tier.lastError || this.line(problem, /database|credential|migration|backup|ECONNREFUSED/i) };
    }
    return null;
  }

  private line(value: string, pattern: RegExp) {
    return value.split(/\r?\n/).find((line) => pattern.test(line))?.trim().slice(0, 320) || "A database requirement needs attention.";
  }
}
