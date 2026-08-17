import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Request } from "express";
import { Brackets, Repository } from "typeorm";
import { User } from "../users/user.entity";
import { AuditLogQueryDto } from "./dto/audit-log-query.dto";
import { AuditLog } from "./audit-log.entity";

type RecordAuditLogInput = {
  actorUser?: User | null;
  actorEmail?: string | null;
  action: string;
  category?: string;
  resourceType: string;
  resourceId?: string | number | null;
  status: string;
  metadata?: Record<string, unknown> | null;
  req?: Request;
};

const SENSITIVE_KEYS = [
  "password",
  "token",
  "secret",
  "authorization",
  "accessToken",
  "refreshToken",
  "apiKey",
  "credential",
  "env",
  "cookie",
];

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>
  ) {}

  async record(input: RecordAuditLogInput): Promise<void> {
    try {
      const actorUser = input.actorUser;
      const resourceId = input.resourceId === undefined || input.resourceId === null
        ? null
        : String(input.resourceId);
      const metadata = { ...(input.metadata || {}) };
      if (input.resourceType === "project" && resourceId && !metadata.projectId) metadata.projectId = resourceId;
      if (input.resourceType === "pipeline_run" && resourceId && !metadata.pipelineRunId) metadata.pipelineRunId = resourceId;
      const auditLog = this.auditLogRepository.create({
        actorUserId: actorUser?.id || null,
        actorEmail: actorUser?.email || input.actorEmail?.trim().toLowerCase() || null,
        actorRole: actorUser?.role || null,
        action: input.action,
        category: input.category || this.categoryFor(input.action, input.resourceType),
        resourceType: input.resourceType,
        resourceId,
        status: input.status,
        ipAddress: this.getIpAddress(input.req),
        userAgent: input.req?.header("user-agent") || null,
        metadata: Object.keys(metadata).length
          ? (this.maskSensitiveMetadata(metadata) as Record<string, unknown>)
          : null,
      });

      await this.auditLogRepository.save(auditLog);
    } catch (error) {
      this.logger.error("Failed to record audit log", error as Error);
    }
  }

  async findForUser(user: User, query: AuditLogQueryDto) {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const queryBuilder = this.auditLogRepository
      .createQueryBuilder("auditLog")
      .orderBy("auditLog.createdAt", "DESC")
      .skip((page - 1) * limit)
      .take(limit);

    if (user.role !== "admin") {
      const projectScope = user.role === "readonly"
        ? `(project.owner_user_id = :currentUserId OR project.visibility = 'workspace')`
        : "project.owner_user_id = :currentUserId";
      queryBuilder.andWhere(
        `(auditLog.actorUserId = :currentUserId OR auditLog.metadata ->> 'projectId' IN (SELECT project.id::text FROM projects project WHERE project.status <> 'archived' AND ${projectScope}))`,
        { currentUserId: user.id }
      );
    } else if (query.actorUserId) {
      queryBuilder.andWhere("auditLog.actorUserId = :actorUserId", {
        actorUserId: query.actorUserId,
      });
    }

    if (query.action) {
      queryBuilder.andWhere("auditLog.action = :action", { action: query.action });
    }

    if (query.category) {
      queryBuilder.andWhere("auditLog.category = :category", { category: query.category });
    }

    if (query.resourceType) {
      queryBuilder.andWhere("auditLog.resourceType = :resourceType", {
        resourceType: query.resourceType,
      });
    }

    if (query.resourceId) {
      queryBuilder.andWhere("auditLog.resourceId = :resourceId", {
        resourceId: query.resourceId,
      });
    }

    if (query.projectId) {
      queryBuilder.andWhere("auditLog.metadata ->> 'projectId' = :projectId", {
        projectId: query.projectId,
      });
    }

    if (query.severity) {
      const severityCondition = query.severity === "error"
        ? "auditLog.status = 'failed'"
        : query.severity === "warning"
          ? "auditLog.status IN ('warning', 'blocked', 'cancelled', 'pending')"
          : "auditLog.status NOT IN ('failed', 'warning', 'blocked', 'cancelled', 'pending')";
      queryBuilder.andWhere(severityCondition);
    }

    if (query.search?.trim()) {
      const search = `%${query.search.trim().replace(/[%_\\]/g, "\\$&")}%`;
      queryBuilder.andWhere(new Brackets((searchBuilder) => {
        searchBuilder
          .where("auditLog.action ILIKE :search ESCAPE '\\'", { search })
          .orWhere("auditLog.actorEmail ILIKE :search ESCAPE '\\'", { search })
          .orWhere("auditLog.resourceType ILIKE :search ESCAPE '\\'", { search })
          .orWhere("auditLog.resourceId ILIKE :search ESCAPE '\\'", { search });
      }));
    }

    if (query.status) {
      queryBuilder.andWhere("auditLog.status = :status", { status: query.status });
    }

    if (query.from) {
      queryBuilder.andWhere("auditLog.createdAt >= :from", {
        from: new Date(query.from),
      });
    }

    if (query.to) {
      queryBuilder.andWhere("auditLog.createdAt <= :to", {
        to: new Date(query.to),
      });
    }

    const [logs, total] = await queryBuilder.getManyAndCount();

    return {
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  private getIpAddress(req?: Request): string | null {
    if (!req) {
      return null;
    }

    return req.ip || req.socket.remoteAddress || null;
  }

  private categoryFor(action: string, resourceType: string): string {
    const value = `${action} ${resourceType}`.toLowerCase();
    if (value.includes("auth") || value.includes("login") || value.includes("logout") || value.includes("oauth")) return "authentication";
    if (value.includes("repository")) return "repository";
    if (value.includes("detect") || value.includes("profile") || value.includes("template") || value.includes("preflight")) return "preparation";
    if (value.includes("security") || value.includes("scan") || value.includes("approval")) return "security";
    if (value.includes("billing") || value.includes("cost") || value.includes("finops")) return "billing";
    if (value.includes("rollback") || value.includes("release") || value.includes("orchestration")) return "release";
    if (value.includes("destroy") || value.includes("terraform") || value.includes("infrastructure") || value.includes("state") || value.includes("storage")) return "infrastructure";
    if (value.includes("pipeline") || value.includes("deployment") || value.includes("automation")) return "deployment";
    if (value.includes("notification") || value.includes("setting") || value.includes("environment") || value.includes("env_")) return "settings";
    if (value.includes("export")) return "export";
    if (value.includes("project")) return "project";
    return "activity";
  }

  private maskSensitiveMetadata(value: unknown): unknown {
    if (typeof value === "string") {
      return value.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_GOOGLE_AI_KEY]");
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.maskSensitiveMetadata(item));
    }

    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).reduce(
        (masked, [key, nestedValue]) => {
          const normalizedKey = key.toLowerCase();
          const isSensitive = SENSITIVE_KEYS.some((sensitiveKey) =>
            normalizedKey.includes(sensitiveKey.toLowerCase())
          );

          masked[key] = isSensitive
            ? "[REDACTED]"
            : this.maskSensitiveMetadata(nestedValue);

          return masked;
        },
        {} as Record<string, unknown>
      );
    }

    return value;
  }
}
