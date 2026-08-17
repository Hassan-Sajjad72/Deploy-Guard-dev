import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Request } from "express";
import { FindOptionsWhere, ILike, Repository } from "typeorm";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { User } from "../../users/user.entity";
import { ApproveSecurityScanDto } from "../dto/approve-security-scan.dto";
import { StartSecurityScanDto } from "../dto/start-security-scan.dto";
import { ProjectDetectionProfile } from "../project-detection-profile.entity";
import { ProjectPipelineRun } from "../project-pipeline-run.entity";
import { ProjectSecurityFinding } from "../project-security-finding.entity";
import {
  ProjectSecurityScan,
  SecurityPolicyDecision,
  SecurityScanStatus,
} from "../project-security-scan.entity";
import { Project } from "../project.entity";
import { ProjectsService } from "../projects.service";
import { RemediationService } from "./remediation.service";
import { SecurityPolicyService } from "./security-policy.service";
import { TrivyParserService } from "./trivy-parser.service";
import { TrivyScannerService } from "./trivy-scanner.service";

type RequestInfo = Request | undefined;

type ScanImageInput = {
  project: Project;
  imageName: string;
  pipelineRun?: ProjectPipelineRun | null;
  actorUser?: User | null;
  req?: RequestInfo;
};

type FindingQuery = {
  severity?: string;
  packageName?: string;
  vulnerabilityId?: string;
  origin?: string;
  fixability?: string;
  policyAction?: string;
  page?: string | number;
  limit?: string | number;
};

@Injectable()
export class SecurityScanService {
  constructor(
    @InjectRepository(ProjectSecurityScan)
    private readonly scanRepository: Repository<ProjectSecurityScan>,
    @InjectRepository(ProjectSecurityFinding)
    private readonly findingRepository: Repository<ProjectSecurityFinding>,
    @InjectRepository(ProjectPipelineRun)
    private readonly pipelineRunRepository: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectDetectionProfile)
    private readonly profileRepository: Repository<ProjectDetectionProfile>,
    private readonly projectsService: ProjectsService,
    private readonly trivyScannerService: TrivyScannerService,
    private readonly trivyParserService: TrivyParserService,
    private readonly securityPolicyService: SecurityPolicyService,
    private readonly remediationService: RemediationService,
    private readonly auditLogService: AuditLogService,
    private readonly config: ConfigService
  ) {}

  async triggerScan(
    user: User,
    projectId: string,
    dto: StartSecurityScanDto,
    req?: RequestInfo
  ) {
    const project = await this.projectsService.getProjectEntityForManage(
      user,
      projectId
    );
    const pipelineRun = dto.pipelineRunId
      ? await this.findPipelineRun(project.id, dto.pipelineRunId)
      : await this.findLatestPipelineRun(project.id);
    const imageName = dto.imageName || this.imageFromPipelineRun(pipelineRun);

    if (!imageName) {
      throw new BadRequestException("No built image is available to scan");
    }

    const scan = await this.scanImage({
      project,
      imageName,
      pipelineRun,
      actorUser: user,
      req,
    });

    return this.toScanResponse(scan);
  }

  async scanImage(input: ScanImageInput) {
    const scanEnabled = this.config.get<string>(
      "TRIVY_SCAN_ENABLED",
      this.config.get<string>("TRIVY_ENABLED", "true")
    ) !== "false";
    if (!scanEnabled) {
      throw new BadRequestException("Security scan is disabled for this demo run.");
    }
    const image = this.parseImageName(input.imageName);
    const scan = await this.scanRepository.save(
      this.scanRepository.create({
        projectId: input.project.id,
        pipelineRunId: input.pipelineRun?.id || null,
        imageName: image.name,
        imageTag: image.tag,
        imageUri: input.imageName,
        scanner: "trivy",
        scanStatus: SecurityScanStatus.QUEUED,
      })
    );

    await this.audit("SECURITY_SCAN_STARTED", scan, input.actorUser, "success", {
      projectId: input.project.id,
      pipelineRunId: input.pipelineRun?.id,
      scanId: scan.id,
      imageName: scan.imageName,
      imageTag: scan.imageTag,
    }, input.req);

    try {
      scan.scanStatus = SecurityScanStatus.RUNNING;
      scan.startedAt = new Date();
      await this.scanRepository.save(scan);

      const rawScan = await this.trivyScannerService.scanImage(input.imageName);
      scan.scannerVersion = rawScan.scannerVersion || null;

      const parsed = this.trivyParserService.parse(rawScan.rawJson);
      const profile = await this.profileRepository.findOne({
        where: { projectId: input.project.id },
      });
      const policy = this.securityPolicyService.evaluate(parsed.findings);

      scan.scanStatus = SecurityScanStatus.COMPLETED;
      scan.completedAt = new Date();
      scan.totalVulnerabilities = parsed.counts.total;
      scan.criticalCount = parsed.counts.critical;
      scan.highCount = parsed.counts.high;
      scan.mediumCount = parsed.counts.medium;
      scan.lowCount = parsed.counts.low;
      scan.unknownCount = parsed.counts.unknown;
      scan.policyDecision = policy.policyDecision;
      scan.policyReason = policy.policyReason;
      scan.manualApprovalRequired = policy.manualApprovalRequired;
      scan.rawSummary = {
        ...parsed.summary,
        classification: this.classificationSummary(parsed.findings),
        policy: {
          ...this.securityPolicyService.publicPolicy(),
          blockingCount: policy.blockingCount,
          warningCount: policy.warningCount,
        },
      };
      const savedScan = await this.scanRepository.save(scan);

      await this.findingRepository.delete({ scanId: savedScan.id });
      const findings = parsed.findings.map((finding) =>
        this.findingRepository.create({
          scanId: savedScan.id,
          projectId: input.project.id,
          pipelineRunId: input.pipelineRun?.id || null,
          vulnerabilityId: finding.vulnerabilityId,
          severity: finding.severity,
          packageName: finding.packageName,
          installedVersion: finding.installedVersion,
          fixedVersion: finding.fixedVersion,
          target: finding.target,
          type: finding.type,
          title: finding.title,
          description: finding.description,
          primaryUrl: finding.primaryUrl,
          remediation: this.remediationService.remediate(finding, profile),
          origin: finding.origin,
          fixability: finding.fixability,
          policyAction: this.securityPolicyService.findingAction(finding),
        })
      );

      if (findings.length > 0) {
        await this.findingRepository.save(findings);
      }

      await this.audit("SECURITY_FINDINGS_NORMALIZED", savedScan, input.actorUser, "success", {
        projectId: input.project.id,
        pipelineRunId: input.pipelineRun?.id,
        scanId: savedScan.id,
        criticalCount: savedScan.criticalCount,
        highCount: savedScan.highCount,
        mediumCount: savedScan.mediumCount,
        lowCount: savedScan.lowCount,
      }, input.req);
      await this.audit("SECURITY_POLICY_EVALUATED", savedScan, input.actorUser, "success", {
        projectId: input.project.id,
        pipelineRunId: input.pipelineRun?.id,
        scanId: savedScan.id,
        policyDecision: savedScan.policyDecision,
        criticalCount: savedScan.criticalCount,
        highCount: savedScan.highCount,
        mediumCount: savedScan.mediumCount,
        lowCount: savedScan.lowCount,
      }, input.req);

      if (savedScan.policyDecision === SecurityPolicyDecision.BLOCKED) {
        await this.audit("SECURITY_DEPLOYMENT_BLOCKED", savedScan, input.actorUser, "failed", {
          projectId: input.project.id,
          pipelineRunId: input.pipelineRun?.id,
          scanId: savedScan.id,
          policyDecision: savedScan.policyDecision,
          reason: savedScan.policyReason,
        }, input.req);
      } else if (
        savedScan.policyDecision === SecurityPolicyDecision.REQUIRES_APPROVAL
      ) {
        await this.audit("SECURITY_APPROVAL_REQUIRED", savedScan, input.actorUser, "success", {
          projectId: input.project.id,
          pipelineRunId: input.pipelineRun?.id,
          scanId: savedScan.id,
          policyDecision: savedScan.policyDecision,
          reason: savedScan.policyReason,
        }, input.req);
      } else {
        await this.audit("SECURITY_GATE_PASSED", savedScan, input.actorUser, "success", {
          projectId: input.project.id,
          pipelineRunId: input.pipelineRun?.id,
          scanId: savedScan.id,
          policyDecision: savedScan.policyDecision,
        }, input.req);
      }

      await this.audit("SECURITY_SCAN_COMPLETED", savedScan, input.actorUser, "success", {
        projectId: input.project.id,
        pipelineRunId: input.pipelineRun?.id,
        scanId: savedScan.id,
        policyDecision: savedScan.policyDecision,
        criticalCount: savedScan.criticalCount,
        highCount: savedScan.highCount,
        mediumCount: savedScan.mediumCount,
        lowCount: savedScan.lowCount,
      }, input.req);

      return savedScan;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Security scan failed.";
      scan.scanStatus = SecurityScanStatus.FAILED;
      scan.failedAt = new Date();
      scan.policyDecision = SecurityPolicyDecision.BLOCKED;
      scan.policyReason = this.publicError(message);
      scan.manualApprovalRequired = false;
      const failedScan = await this.scanRepository.save(scan);

      await this.audit("SECURITY_SCAN_FAILED", failedScan, input.actorUser, "failed", {
        projectId: input.project.id,
        pipelineRunId: input.pipelineRun?.id,
        scanId: failedScan.id,
        policyDecision: failedScan.policyDecision,
        reason: failedScan.policyReason,
      }, input.req);

      throw new BadRequestException(failedScan.policyReason);
    }
  }

  async listScans(user: User, projectId: string) {
    const project = await this.projectsService.getProjectEntityForView(user, projectId);
    const scans = await this.scanRepository.find({
      where: { projectId: project.id },
      order: { createdAt: "DESC" },
      take: 50,
    });

    return scans.map((scan) => this.toScanResponse(scan));
  }

  async getScan(user: User, projectId: string, scanId: string) {
    const project = await this.projectsService.getProjectEntityForView(user, projectId);
    const scan = await this.findScan(project.id, scanId);
    return this.toScanResponse(scan);
  }

  async listFindings(
    user: User,
    projectId: string,
    scanId: string,
    query: FindingQuery
  ) {
    const project = await this.projectsService.getProjectEntityForView(user, projectId);
    await this.findScan(project.id, scanId);
    const page = Math.max(Number(query.page || 1), 1);
    const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
    const where: FindOptionsWhere<ProjectSecurityFinding> = {
      projectId: project.id,
      scanId,
    };

    if (query.severity) {
      where.severity = String(query.severity).toUpperCase();
    }

    if (query.packageName) {
      where.packageName = ILike(`%${query.packageName}%`);
    }

    if (query.vulnerabilityId) {
      where.vulnerabilityId = ILike(`%${query.vulnerabilityId}%`);
    }

    if (query.origin) {
      where.origin = query.origin;
    }

    if (query.fixability) {
      where.fixability = query.fixability;
    }

    if (query.policyAction) {
      where.policyAction = query.policyAction;
    }

    const [findings, total] = await this.findingRepository.findAndCount({
      where,
      order: { severity: "ASC", createdAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      findings,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async approveScan(
    user: User,
    projectId: string,
    scanId: string,
    dto: ApproveSecurityScanDto,
    req?: RequestInfo
  ) {
    const project = await this.projectsService.getProjectEntityForManage(
      user,
      projectId
    );
    const scan = await this.findScan(project.id, scanId);

    if (!this.securityPolicyService.canApprove(scan)) {
      await this.audit("SECURITY_SCAN_OVERRIDE_REJECTED", scan, user, "failed", {
        projectId: project.id,
        pipelineRunId: scan.pipelineRunId,
        scanId: scan.id,
        policyDecision: scan.policyDecision,
        approvalUserId: user.id,
      }, req);
      throw new ForbiddenException("This security scan cannot be approved");
    }

    if (!dto.reason?.trim()) {
      throw new BadRequestException("Approval reason is required");
    }

    scan.policyDecision = SecurityPolicyDecision.APPROVED_OVERRIDE;
    scan.manualApprovalRequired = false;
    scan.approvedByUserId = user.id;
    scan.approvedAt = new Date();
    scan.approvalReason = this.limitUserText(dto.reason.trim());
    const savedScan = await this.scanRepository.save(scan);

    await this.audit("SECURITY_SCAN_APPROVED", savedScan, user, "success", {
      projectId: project.id,
      pipelineRunId: savedScan.pipelineRunId,
      scanId: savedScan.id,
      policyDecision: savedScan.policyDecision,
      approvalUserId: user.id,
      reason: this.sanitizeUserEnteredReason(savedScan.approvalReason),
    }, req);

    return this.toScanResponse(savedScan);
  }

  private async findPipelineRun(projectId: string, pipelineRunId: string) {
    const run = await this.pipelineRunRepository.findOne({
      where: { id: pipelineRunId, projectId },
    });

    if (!run) {
      throw new NotFoundException("Pipeline run not found");
    }

    return run;
  }

  private async findLatestPipelineRun(projectId: string) {
    return this.pipelineRunRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });
  }

  private imageFromPipelineRun(run: ProjectPipelineRun | null) {
    if (!run?.imageName || !run.imageTag) {
      return null;
    }

    return `${run.imageName}:${run.imageTag}`;
  }

  private async findScan(projectId: string, scanId: string) {
    const scan = await this.scanRepository.findOne({
      where: { id: scanId, projectId },
    });

    if (!scan) {
      throw new NotFoundException("Security scan not found");
    }

    return scan;
  }

  private parseImageName(imageName: string) {
    const lastSlash = imageName.lastIndexOf("/");
    const lastColon = imageName.lastIndexOf(":");

    if (lastColon > lastSlash) {
      return {
        name: imageName.slice(0, lastColon),
        tag: imageName.slice(lastColon + 1),
      };
    }

    return { name: imageName, tag: null };
  }

  private async audit(
    action: string,
    scan: ProjectSecurityScan,
    actorUser: User | null | undefined,
    status: string,
    metadata: Record<string, unknown>,
    req?: RequestInfo
  ) {
    await this.auditLogService.record({
      actorUser,
      action,
      resourceType: "security_scan",
      resourceId: scan.id,
      status,
      metadata: this.safeMetadata(metadata),
      req,
    });
  }

  private safeMetadata(metadata: Record<string, unknown>) {
    const allowed = [
      "projectId",
      "pipelineRunId",
      "scanId",
      "imageName",
      "imageTag",
      "criticalCount",
      "highCount",
      "mediumCount",
      "lowCount",
      "policyDecision",
      "approvalUserId",
      "reason",
    ];

    return Object.entries(metadata).reduce(
      (safe, [key, value]) => {
        if (allowed.includes(key) && value !== undefined) {
          safe[key] = value;
        }

        return safe;
      },
      {} as Record<string, unknown>
    );
  }

  private publicError(message: string) {
    if (/token|secret|password|credential|authorization|cookie/i.test(message)) {
      return "Security scan failed because required scanner credentials or access are invalid.";
    }

    return message;
  }

  private limitUserText(value: string) {
    return value.slice(0, 500);
  }

  private sanitizeUserEnteredReason(value: string | null | undefined) {
    if (!value) {
      return value;
    }

    return this.limitUserText(value)
      .replace(/-----BEGIN [\s\S]+?-----END [^-]+-----/g, "[REDACTED_SECRET]")
      .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_SECRET]")
      .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_SECRET]")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_SECRET]")
      .replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, "[REDACTED_SECRET]")
      .replace(
        /\b(password|token|secret|credential|authorization|oauth[_-]?code|session)[\s:=]+[^\s,;]+/gi,
        "$1=[REDACTED_SECRET]"
      );
  }

  private toScanResponse(scan: ProjectSecurityScan) {
    return {
      id: scan.id,
      projectId: scan.projectId,
      pipelineRunId: scan.pipelineRunId,
      imageName: scan.imageName,
      imageTag: scan.imageTag,
      imageUri: scan.imageUri,
      scanner: scan.scanner,
      scannerVersion: scan.scannerVersion,
      scanStatus: scan.scanStatus,
      startedAt: scan.startedAt,
      completedAt: scan.completedAt,
      failedAt: scan.failedAt,
      totalVulnerabilities: scan.totalVulnerabilities,
      criticalCount: scan.criticalCount,
      highCount: scan.highCount,
      mediumCount: scan.mediumCount,
      lowCount: scan.lowCount,
      unknownCount: scan.unknownCount,
      policyDecision: scan.policyDecision,
      policyReason: scan.policyReason,
      manualApprovalRequired: scan.manualApprovalRequired,
      approvedByUserId: scan.approvedByUserId,
      approvedAt: scan.approvedAt,
      approvalReason: scan.approvalReason,
      rawSummary: scan.rawSummary,
      createdAt: scan.createdAt,
      updatedAt: scan.updatedAt,
    };
  }

  private classificationSummary(
    findings: Array<{
      origin: string;
      fixability: string;
    }>
  ) {
    const count = (key: "origin" | "fixability", value: string) =>
      findings.filter((finding) => finding[key] === value).length;

    return {
      appDependency: count("origin", "app_dependency"),
      baseImage: count("origin", "base_image"),
      osPackage: count("origin", "os_package"),
      unknownOrigin: count("origin", "unknown"),
      fixAvailable: count("fixability", "fix_available"),
      noFixAvailable: count("fixability", "no_fix_available"),
      unknownFixability: count("fixability", "unknown"),
    };
  }
}
