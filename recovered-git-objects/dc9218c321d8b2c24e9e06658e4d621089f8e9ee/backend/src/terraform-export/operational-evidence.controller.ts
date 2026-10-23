import { Controller, Get, Param, ParseUUIDPipe, Req, Res, UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { DataSource, In } from "typeorm";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { ProjectStableRelease } from "../orchestration/project-stable-release.entity";
import { DeploymentPlan, DeploymentPlanDecision } from "../planning/deployment-plan.entity";
import { AuditLogService } from "../audit-log/audit-log.service";
import { renderPdfLines } from "../common/pdf";
import { requireRole } from "../common/rbac/require-role.guard";
import { ProjectCurrentStateService } from "../projects/current-state/project-current-state.service";
import { ProjectsService } from "../projects/projects.service";
import { UserRole } from "../users/user.entity";
import { evidencePdfLines, operationalEvidence } from "./operational-evidence";
import { buildDeterministicZip } from "./zip-builder";
import { IntelligenceRecord } from "../operational-intelligence/intelligence-record.entity";
import { GovernedRecoveryDecision, GovernedRecoveryRequest, SupervisedRepairProposal } from "../recovery/recovery.entity";

@Controller("api/projects/:projectId/evidence")
@UseGuards(requireRole([UserRole.DEVELOPER, UserRole.READONLY]))
export class OperationalEvidenceController {
  constructor(private readonly projects: ProjectsService, private readonly state: ProjectCurrentStateService, private readonly audit: AuditLogService, private readonly database: DataSource) {}

  @Get("json")
  async json(@Req() req: Request, @Res() res: Response, @Param("projectId", ParseUUIDPipe) projectId: string) {
    const report = await this.report(req, projectId, "json");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `attachment; filename="deployguard-${projectId}-evidence.json"`);
    res.json(report);
  }

  @Get("pdf")
  async pdf(@Req() req: Request, @Res() res: Response, @Param("projectId", ParseUUIDPipe) projectId: string) {
    const report = await this.report(req, projectId, "pdf");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="deployguard-${projectId}-evidence.pdf"`);
    res.send(renderPdfLines(evidencePdfLines(report)));
  }

  @Get("zip")
  async zip(@Req() req: Request, @Res() res: Response, @Param("projectId", ParseUUIDPipe) projectId: string) {
    const report = await this.report(req, projectId, "zip");
    const files = [
      { path: "operational-evidence.json", content: Buffer.from(JSON.stringify(report, null, 2)) },
      { path: "operational-evidence.pdf", content: renderPdfLines(evidencePdfLines(report)) },
      { path: "README.txt", content: Buffer.from("DeployGuard operational handoff\n\nReview account, region, environment, source SHA, plan approvals and resource IDs in operational-evidence.json. Configuration requirements contain names and scopes; configure values through authorized secret references. Unknown prices and missing health evidence remain unverified. This archive does not grant AWS access or authorize deployment, recovery or cleanup. Terraform exports are available separately for verified infrastructure.\n") },
    ];
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="deployguard-${projectId}-evidence.zip"`);
    res.send(buildDeterministicZip(files));
  }

  private async report(req: Request, projectId: string, format: string) {
    const project = await this.projects.getProjectForView(req.user!, projectId);
    const current = await this.state.getCurrentState(req.user!, projectId);
    const [variables, releases, plans, operations, intelligence, recovery, repairs] = await Promise.all([
      this.database.getRepository(ProjectEnvironmentVariable).find({ where: { projectId, environment: project.environmentName, isActive: true }, order: { serviceId: "ASC", key: "ASC" } }),
      this.database.getRepository(ProjectStableRelease).find({ where: { projectId, environmentName: project.environmentName }, order: { deployedAt: "DESC" }, take: 50 }),
      this.database.getRepository(DeploymentPlan).find({ where: { projectId }, order: { version: "DESC" }, take: 50 }),
      this.database.getRepository(ProjectPipelineRun).find({ where: { projectId }, order: { createdAt: "DESC" }, take: 50 }),
      this.database.getRepository(IntelligenceRecord).find({ where: { projectId }, order: { createdAt: "DESC" }, take: 50 }),
      this.database.getRepository(GovernedRecoveryRequest).find({ where: { projectId }, order: { createdAt: "DESC" }, take: 50 }),
      this.database.getRepository(SupervisedRepairProposal).find({ where: { projectId }, order: { createdAt: "DESC" }, take: 50 }),
    ]);
    const decisions = plans.length ? await this.database.getRepository(DeploymentPlanDecision).find({ where: { planId: In(plans.map((plan) => plan.id)) } }) : [];
    const recoveryDecisions = recovery.length ? await this.database.getRepository(GovernedRecoveryDecision).find({ where: { requestId: In(recovery.map((request) => request.id)) } }) : [];
    const scans = operations.flatMap((operation) => {
      const artifact = operation.metadata?.releaseArtifact as Record<string, unknown> | undefined;
      const scan = (artifact?.securityScan || operation.metadata?.securityScan) as Record<string, unknown> | undefined;
      if (!scan || scan.deploymentOperationId !== operation.id || scan.projectId !== projectId || scan.commitSha !== operation.commitSha) return [];
      return [{ operationId: operation.id, sourceSha: operation.commitSha, status: ["passed", "advisory", "error"].includes(String(scan.status)) ? String(scan.status) : "unverified",
        evidenceHash: typeof scan.evidenceHash === "string" && /^[a-f0-9]{64}$/.test(scan.evidenceHash) ? scan.evidenceHash : null, recordedAt: operation.updatedAt }];
    });
    await this.audit.record({ actorUser: req.user!, action: "OPERATIONAL_EVIDENCE_EXPORTED", resourceType: "project", resourceId: projectId, status: "success", metadata: { projectId, organizationId: project.organizationId, format }, req });
    return operationalEvidence(project, current, {
      configurationRequirements: variables.map((item) => ({ serviceId: item.serviceId, key: item.key, scope: item.scope, required: item.isRequired, secret: item.isSecret })),
      releases: releases.map((item) => ({ id: item.id, sourceSha: item.commitSha, operationId: item.deployedByPipelineRunId, generationId: item.generationId, status: item.status, deployedAt: item.deployedAt })),
      approvals: decisions.map((item) => ({ planId: item.planId, actorUserId: item.actorUserId, actorRole: item.actorRole, decision: item.decision, fingerprint: item.fingerprint, environment: item.environment, operationId: item.operationId, monthlyBudgetUsd: item.monthlyBudgetUsd, createdAt: item.createdAt })),
      scans, rollbackHistory: operations.filter((operation) => operation.metadata?.deploymentAction === "rollback").map((item) => ({ operationId: item.id, sourceSha: item.commitSha, generationId: item.generationId, status: item.status, completedAt: item.completedAt })),
      plans: plans.map((item) => ({ id: item.id, version: item.version, fingerprint: item.fingerprint, sourceSha: item.content.repository.sourceSha, operationId: item.content.operationId, createdAt: item.createdAt })),
      intelligence: intelligence.map((item) => ({ id: item.id, kind: item.kind, fingerprint: item.fingerprint, createdAt: item.createdAt })),
      recovery: recovery.map((item) => ({ id: item.id, incidentId: item.incidentId, fingerprint: item.fingerprint, status: item.status, operationId: item.operationId, createdAt: item.createdAt, completedAt: item.completedAt })),
      recoveryApprovals: recoveryDecisions.map((item) => ({ requestId: item.requestId, actorUserId: item.actorUserId, actorRole: item.actorRole, fingerprint: item.fingerprint, decision: item.decision, createdAt: item.createdAt })),
      repairs: repairs.map((item) => ({ id: item.id, fingerprint: item.fingerprint, status: item.status, pullRequestUrl: item.pullRequestUrl, createdAt: item.createdAt })),
    });
  }
}
