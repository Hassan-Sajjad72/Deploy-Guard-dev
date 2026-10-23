import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { DeploymentProfileService } from "./detection/deployment-profile.service";
import { RepositoryWorkspaceService } from "./detection/repository-workspace.service";
import { StackDetectionService } from "./detection/stack-detection.service";
import { TemplateMatchingService } from "./detection/template-matching.service";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { ProjectDetectionProfile } from "./project-detection-profile.entity";
import { ProjectPreflightReport } from "./project-preflight-report.entity";
import { ProjectPipelineEvent } from "./project-pipeline-event.entity";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";
import { ProjectSecurityFinding } from "./project-security-finding.entity";
import { ProjectSecurityScan } from "./project-security-scan.entity";
import { Project } from "./project.entity";
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";
import { DockerBuildService } from "./pipeline/docker-build.service";
import { EcrService } from "./pipeline/ecr.service";
import { GithubActionsService } from "./pipeline/github-actions.service";
import { PipelineService } from "./pipeline/pipeline.service";
import { PipelineWorkerService } from "./pipeline/pipeline-worker.service";
import { pipelineQueueProvider } from "./pipeline/pipeline.queue";
import { RemediationService } from "./security/remediation.service";
import { SecurityPolicyService } from "./security/security-policy.service";
import { SecurityScanService } from "./security/security-scan.service";
import { TrivyParserService } from "./security/trivy-parser.service";
import { TrivyScannerService } from "./security/trivy-scanner.service";
import { DockerTemplateEngineService } from "./templates/docker-template-engine.service";
import { PreflightService } from "./templates/preflight.service";
import { TemplateRegistryService } from "./templates/template-registry.service";
import { TemplatesController } from "./templates/templates.controller";
import { User } from "../users/user.entity";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectEnvironmentVariable,
      ProjectDetectionProfile,
      ProjectPreflightReport,
      ProjectPipelineRun,
      ProjectPipelineEvent,
      ProjectSecurityScan,
      ProjectSecurityFinding,
      User,
    ]),
    AuditLogModule,
  ],
  controllers: [ProjectsController, TemplatesController],
  providers: [
    ProjectsService,
    DeploymentProfileService,
    RepositoryWorkspaceService,
    StackDetectionService,
    TemplateMatchingService,
    TemplateRegistryService,
    DockerTemplateEngineService,
    PreflightService,
    pipelineQueueProvider,
    PipelineService,
    PipelineWorkerService,
    GithubActionsService,
    DockerBuildService,
    EcrService,
    TrivyScannerService,
    TrivyParserService,
    SecurityPolicyService,
    RemediationService,
    SecurityScanService,
  ],
})
export class ProjectsModule {}
