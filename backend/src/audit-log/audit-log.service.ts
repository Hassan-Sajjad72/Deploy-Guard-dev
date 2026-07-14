import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Request } from "express";
import { Repository } from "typeorm";
import { User } from "../users/user.entity";
import { AuditLogQueryDto } from "./dto/audit-log-query.dto";
import { AuditLog } from "./audit-log.entity";

type RecordAuditLogInput = {
  actorUser?: User | null;
  action: string;
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
      const auditLog = this.auditLogRepository.create({
        actorUserId: actorUser ? String(actorUser.id) : null,
        actorEmail: actorUser?.email || null,
        actorRole: actorUser?.role || null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId:
          input.resourceId === undefined || input.resourceId === null
            ? null
            : String(input.resourceId),
        status: input.status,
        ipAddress: this.getIpAddress(input.req),
        userAgent: input.req?.header("user-agent") || null,
        metadata: input.metadata
          ? (this.maskSensitiveMetadata(input.metadata) as Record<string, unknown>)
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
      queryBuilder.andWhere("auditLog.actorUserId = :currentUserId", {
        currentUserId: String(user.id),
      });
    } else if (query.actorUserId) {
      queryBuilder.andWhere("auditLog.actorUserId = :actorUserId", {
        actorUserId: query.actorUserId,
      });
    }

    if (query.action) {
      queryBuilder.andWhere("auditLog.action = :action", { action: query.action });
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

  // Future modules should call record() for PROJECT_CREATED, DEPLOYMENT_TRIGGERED,
  // TRIVY_SCAN_FAILED, COST_APPROVAL_CREATED, and COST_APPROVAL_APPROVED.

  private getIpAddress(req?: Request): string | null {
    if (!req) {
      return null;
    }

    return req.ip || req.socket.remoteAddress || null;
  }

  private maskSensitiveMetadata(value: unknown): unknown {
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
