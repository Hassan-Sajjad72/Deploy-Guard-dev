import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { LogSanitizerService } from "../observability/log-sanitizer.service";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project } from "../projects/project.entity";
import { ProjectDeploymentGeneration } from "../projects/project-deployment-generation.entity";
import { ProjectStableRelease } from "../orchestration/project-stable-release.entity";
import { ObservabilityModule } from "../observability/observability.module";
import { ProjectEnvironmentCryptoService } from "../projects/project-environment-crypto.service";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { ProjectObservabilityEvent } from "../observability/project-observability-event.entity";
import { AiAnalysisMessage } from "./ai-analysis-message.entity";
import { AiAnalysisResult } from "./ai-analysis-result.entity";
import { AiAnalysisSession } from "./ai-analysis-session.entity";
import { AiEvidencePreprocessorService } from "./ai-evidence-preprocessor.service";
import { AiEvidenceService } from "./ai-evidence.service";
import { AiProviderAdapter } from "./ai-provider.adapter";
import { AiTroubleshootingController } from "./ai-troubleshooting.controller";
import { AiTroubleshootingService } from "./ai-troubleshooting.service";

@Module({
  imports: [TypeOrmModule.forFeature([Project, ProjectPipelineRun, ProjectPipelineEvent, ProjectObservabilityEvent, ProjectEnvironmentVariable, ProjectDeploymentGeneration, ProjectStableRelease, AiAnalysisSession, AiAnalysisMessage, AiAnalysisResult]), AuditLogModule, ObservabilityModule],
  controllers: [AiTroubleshootingController],
  providers: [AiTroubleshootingService, AiEvidenceService, AiEvidencePreprocessorService, AiProviderAdapter, LogSanitizerService, ProjectEnvironmentCryptoService],
  exports: [AiTroubleshootingService],
})
export class AiTroubleshootingModule {}
