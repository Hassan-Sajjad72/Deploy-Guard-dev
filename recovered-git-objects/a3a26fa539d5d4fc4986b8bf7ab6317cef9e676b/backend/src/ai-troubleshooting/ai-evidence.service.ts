import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectInfrastructureEvent } from "../infrastructure/project-infrastructure-event.entity";
import { CloudWatchLogsService } from "../observability/cloudwatch-logs.service";
import { ProjectOrchestrationEvent } from "../orchestration/project-orchestration-event.entity";
import { ProjectDetectionProfile } from "../projects/project-detection-profile.entity";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { ProjectSecurityFinding } from "../projects/project-security-finding.entity";
import { ProjectSecurityScan } from "../projects/project-security-scan.entity";
import { AiEvidencePreprocessorService, RawEvidence } from "./ai-evidence-preprocessor.service";

@Injectable()
export class AiEvidenceService {
  constructor(
    @InjectRepository(ProjectPipelineEvent) private readonly pipelineEvents: Repository<ProjectPipelineEvent>,
    @InjectRepository(ProjectInfrastructureEvent) private readonly infrastructureEvents: Repository<ProjectInfrastructureEvent>,
    @InjectRepository(ProjectOrchestrationEvent) private readonly orchestrationEvents: Repository<ProjectOrchestrationEvent>,
    @InjectRepository(ProjectSecurityScan) private readonly scans: Repository<ProjectSecurityScan>,
    @InjectRepository(ProjectSecurityFinding) private readonly findings: Repository<ProjectSecurityFinding>,
    @InjectRepository(ProjectDetectionProfile) private readonly detections: Repository<ProjectDetectionProfile>,
    @InjectRepository(ProjectEnvironmentVariable) private readonly variables: Repository<ProjectEnvironmentVariable>,
    private readonly cloudWatch: CloudWatchLogsService,
    private readonly preprocessor: AiEvidencePreprocessorService,
  ) {}

  async collect(projectId: string, pipelineRunId: string) {
    const [pipeline, infrastructure, orchestration, scan, detection, environmentRows] = await Promise.all([
      this.pipelineEvents.find({ where: { projectId, pipelineRunId }, order: { createdAt: "ASC" }, take: 250 }),
      this.infrastructureEvents.find({ where: { projectId, pipelineRunId }, order: { createdAt: "ASC" }, take: 100 }),
      this.orchestrationEvents.find({ where: { projectId, pipelineRunId }, order: { createdAt: "ASC" }, take: 100 }),
      this.scans.findOne({ where: { projectId, pipelineRunId }, order: { createdAt: "DESC" } }),
      this.detections.findOne({ where: { projectId } }),
      this.variables.createQueryBuilder("variable").addSelect("variable.value").where("variable.projectId = :projectId", { projectId }).getMany(),
    ]);
    const security = scan ? await this.findings.find({ where: { scanId: scan.id }, order: { severity: "ASC" }, take: 100 }) : [];
    const rows: RawEvidence[] = [
      ...pipeline.map((event) => ({ source: "pipeline_event", stage: event.stage, eventId: event.id, timestamp: event.createdAt, text: `${event.status}: ${event.message}` })),
      ...infrastructure.map((event) => ({ source: "infrastructure_event", stage: event.eventType, eventId: event.id, timestamp: event.createdAt, text: `${event.status}: ${event.message}` })),
      ...orchestration.map((event) => ({ source: "orchestration_event", stage: event.eventType, eventId: event.id, timestamp: event.createdAt, text: `${event.status}: ${event.message}` })),
      ...security.map((finding) => ({ source: "security_finding", stage: "trivy_image_scan", eventId: finding.id, timestamp: finding.createdAt, text: `${finding.severity} ${finding.vulnerabilityId} in ${finding.packageName || "unknown package"}. ${finding.title || ""} ${finding.remediation || ""}` })),
    ];
    try {
      const logs = await this.cloudWatch.getRecentLogs(projectId, { pipelineRunId, limit: 100 });
      for (const event of logs.events || []) rows.push({ source: "cloudwatch", stage: "runtime", timestamp: event.timestamp, text: event.message, lineReference: event.logStreamName });
    } catch {
      // CloudWatch is optional; persisted events remain the authoritative fallback.
    }
    return {
      context: {
        pipelineRunId,
        detection: detection ? { ecosystem: detection.ecosystem, language: detection.language, framework: detection.framework, packageManager: detection.packageManager, buildCommand: detection.buildCommand, startCommand: detection.startCommand } : null,
        security: scan ? { status: scan.scanStatus, policyDecision: scan.policyDecision, total: scan.totalVulnerabilities, critical: scan.criticalCount, high: scan.highCount } : null,
        evidenceSources: { pipeline: pipeline.length, infrastructure: infrastructure.length, orchestration: orchestration.length, security: security.length },
      },
      evidence: this.preprocessor.preprocess(rows, environmentRows.map((row) => row.value || "")),
    };
  }
}
