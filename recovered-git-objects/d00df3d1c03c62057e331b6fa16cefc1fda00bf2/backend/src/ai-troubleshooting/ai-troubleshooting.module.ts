import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { BillingModule } from "../billing/billing.module";
import { ProjectInfrastructureEvent } from "../infrastructure/project-infrastructure-event.entity";
import { ObservabilityModule } from "../observability/observability.module";
import { ProjectOrchestrationEvent } from "../orchestration/project-orchestration-event.entity";
import { ProjectDetectionProfile } from "../projects/project-detection-profile.entity";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { ProjectSecurityFinding } from "../projects/project-security-finding.entity";
import { ProjectSecurityScan } from "../projects/project-security-scan.entity";
import { Project } from "../projects/project.entity";
import { AiAnalysisMessage } from "./ai-analysis-message.entity";
import { AiAnalysisResult } from "./ai-analysis-result.entity";
import { AiAnalysisSession } from "./ai-analysis-session.entity";
import { AiEvidencePreprocessorService } from "./ai-evidence-preprocessor.service";
import { AiEvidenceService } from "./ai-evidence.service";
import { AiProviderAdapter } from "./ai-provider.adapter";
import { AiTroubleshootingController } from "./ai-troubleshooting.controller";
import { AiTroubleshootingService } from "./ai-troubleshooting.service";

@Module({
  imports: [TypeOrmModule.forFeature([Project, ProjectPipelineRun, ProjectPipelineEvent, ProjectInfrastructureEvent, ProjectOrchestrationEvent, ProjectSecurityScan, ProjectSecurityFinding, ProjectDetectionProfile, ProjectEnvironmentVariable, AiAnalysisSession, AiAnalysisMessage, AiAnalysisResult]), AuditLogModule, BillingModule, ObservabilityModule],
  controllers: [AiTroubleshootingController],
  providers: [AiTroubleshootingService, AiEvidenceService, AiEvidencePreprocessorService, AiProviderAdapter],
  exports: [AiTroubleshootingService],
})
export class AiTroubleshootingModule {}
