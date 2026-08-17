import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectSecurityFinding } from "../projects/project-security-finding.entity";
import { ProjectSecurityScan } from "../projects/project-security-scan.entity";
import { LogSanitizerService } from "./log-sanitizer.service";
import { PipelineMetricsService } from "./pipeline-metrics.service";
import { StageMetricSource } from "./project-stage-metric.entity";

@Injectable()
export class TrivyMetricsService {
  constructor(
    @InjectRepository(ProjectSecurityScan)
    private readonly scanRepository: Repository<ProjectSecurityScan>,
    @InjectRepository(ProjectSecurityFinding)
    private readonly findingRepository: Repository<ProjectSecurityFinding>,
    private readonly metrics: PipelineMetricsService,
    private readonly sanitizer: LogSanitizerService
  ) {}

  async saveTrivyMetric(projectId: string, pipelineRunId: string) {
    const scan = await this.scanRepository.findOne({
      where: { projectId, pipelineRunId },
      order: { createdAt: "DESC" },
    });

    if (!scan) {
      return null;
    }

    const remediationCount = await this.findingRepository.count({
      where: { projectId, pipelineRunId },
    });
    const durationMs = scan.startedAt && (scan.completedAt || scan.failedAt)
      ? Math.max(0, (scan.completedAt || scan.failedAt).getTime() - scan.startedAt.getTime())
      : null;
    const metadata = this.sanitizer.sanitizeMetadata({
      scanId: scan.id,
      totalVulnerabilities: scan.totalVulnerabilities,
      criticalCount: scan.criticalCount,
      highCount: scan.highCount,
      mediumCount: scan.mediumCount,
      lowCount: scan.lowCount,
      unknownCount: scan.unknownCount,
      policyDecision: scan.policyDecision,
      remediationCount,
      durationMs,
    });

    await this.metrics.startStage(projectId, pipelineRunId, "trivy_image_scan", StageMetricSource.TRIVY, metadata);

    if (scan.scanStatus === "failed") {
      return this.metrics.failStage(projectId, pipelineRunId, "trivy_image_scan", scan.policyReason || "Trivy scan failed.", metadata);
    }

    return this.metrics.completeStage(projectId, pipelineRunId, "trivy_image_scan", metadata);
  }

  async getLatest(projectId: string, pipelineRunId?: string) {
    return this.scanRepository.findOne({
      where: { projectId, ...(pipelineRunId ? { pipelineRunId } : {}) },
      order: { createdAt: "DESC" },
    });
  }
}
