import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { MoreThan, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { PipelineRunStatus, ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project } from "../projects/project.entity";
import { User, UserRole } from "../users/user.entity";
import { AiAnalysisMessage } from "./ai-analysis-message.entity";
import { AiAnalysisResult } from "./ai-analysis-result.entity";
import { AiAnalysisSession } from "./ai-analysis-session.entity";
import { AiEvidencePreprocessorService } from "./ai-evidence-preprocessor.service";
import { AiEvidenceService } from "./ai-evidence.service";
import { AiProviderAdapter } from "./ai-provider.adapter";
import { LogSanitizerService } from "../observability/log-sanitizer.service";
import { presentPipelineStage } from "../projects/pipeline/pipeline-stage-presenter";
import { deployguardOperationStagePresentation } from "../projects/pipeline/github-actions-stage-presentation";
import { TROUBLESHOOTING_QUESTIONS, troubleshootingQuestion, TroubleshootingQuestionType } from "./ai-troubleshooting-contract";

export function isAiTroubleshootingEligible(run: Pick<ProjectPipelineRun, "status" | "githubWorkflowRunId" | "metadata">) {
  if (run.status !== PipelineRunStatus.FAILED || typeof run.metadata?.safeLog !== "string" || !run.metadata.safeLog.trim()) return false;
  // A platform dispatch failure is authoritative evidence even though GitHub
  // never created a run. Do not mislabel it as a GitHub Actions failure.
  return Boolean(run.githubWorkflowRunId) || run.metadata?.dispatchState === "failed";
}

export function isAiRuntimeTroubleshootingCandidate(run: Pick<ProjectPipelineRun, "status" | "generationId" | "metadata">) {
  return run.status === PipelineRunStatus.COMPLETED && Boolean(run.generationId) && run.metadata?.releaseEvidenceVerified === true;
}

@Injectable()
export class AiTroubleshootingService {
  constructor(
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(AiAnalysisSession) private readonly sessions: Repository<AiAnalysisSession>,
    @InjectRepository(AiAnalysisMessage) private readonly messages: Repository<AiAnalysisMessage>,
    @InjectRepository(AiAnalysisResult) private readonly results: Repository<AiAnalysisResult>,
    private readonly evidenceService: AiEvidenceService,
    private readonly preprocessor: AiEvidencePreprocessorService,
    private readonly provider: AiProviderAdapter,
    private readonly audit: AuditLogService,
    private readonly sanitizer: LogSanitizerService,
  ) {}

  async providerStatus(user: User, projectId: string) {
    await this.assertAccess(user, projectId, false);
    return this.provider.availability();
  }

  async start(user: User, projectId: string, pipelineRunId: string, serviceId?: string) {
    await this.assertAccess(user, projectId, true);
    const run = await this.runs.findOne({ where: { id: pipelineRunId, projectId } });
    if (!run) throw new NotFoundException("Pipeline run not found for this project.");
    const collected = await this.evidenceService.collect(projectId, pipelineRunId, user, serviceId);
    this.assertEligibleRun(run, collected);
    await this.assertRate(user.id, "analysis");
    const session = await this.sessions.save(this.sessions.create({ userId: user.id, projectId, pipelineRunId, status: "processing", provider: null, model: null, providerMode: "unavailable", initialContext: { requestedServiceId: serviceId || null, evidenceSnapshot: collected }, lastError: null, closedAt: null }));
    await this.audit.record({ actorUser: user, action: "ai.analysis.started", resourceType: "ai_analysis_session", resourceId: session.id, status: "success", metadata: { projectId, pipelineRunId, problemType: collected.context.problemType } });
    return this.generate(session, run, user, null, null, collected);
  }

  async regenerate(user: User, projectId: string, sessionId: string) {
    const session = await this.sessionFor(user, projectId, sessionId, true);
    if (session.closedAt) throw new BadRequestException("This troubleshooting session is closed.");
    await this.assertRate(user.id, "analysis");
    const run = await this.runs.findOne({ where: { id: session.pipelineRunId, projectId } });
    if (!run) throw new NotFoundException("Pipeline run not found.");
    const collected = await this.collectedForSession(session, run, user);
    this.assertEligibleRun(run, collected);
    await this.audit.record({ actorUser: user, action: "ai.analysis.regenerated", resourceType: "ai_analysis_session", resourceId: session.id, status: "success", metadata: { projectId, pipelineRunId: run.id } });
    return this.generate(session, run, user, null, null, collected);
  }

  async followUp(user: User, projectId: string, sessionId: string, message: string, questionType?: TroubleshootingQuestionType) {
    const session = await this.sessionFor(user, projectId, sessionId, true);
    if (session.closedAt) throw new BadRequestException("This troubleshooting session is closed.");
    await this.assertRate(user.id, "followup");
    const safeMessage = await this.evidenceService.sanitizeUserInput(projectId, message);
    const question = troubleshootingQuestion(questionType);
    await this.messages.save(this.messages.create({ sessionId, role: "user", content: safeMessage, usageMetadata: question ? { questionType: question.type } : null }));
    await this.audit.record({ actorUser: user, action: "ai.analysis.follow_up", resourceType: "ai_analysis_session", resourceId: session.id, status: "success", metadata: { projectId, pipelineRunId: session.pipelineRunId } });
    const run = await this.runs.findOne({ where: { id: session.pipelineRunId, projectId } });
    if (!run) throw new NotFoundException("Pipeline run not found.");
    const collected = await this.collectedForSession(session, run, user);
    this.assertEligibleRun(run, collected);
    return this.generate(session, run, user, safeMessage, question?.type || null, collected);
  }

  async list(user: User, projectId: string, page = 1, limit = 20) {
    await this.assertAccess(user, projectId, false);
    const take = Math.min(Math.max(limit, 1), 50);
    const [items, total] = await this.sessions.findAndCount({ where: { projectId }, order: { updatedAt: "DESC" }, skip: (Math.max(page, 1) - 1) * take, take });
    // Session history is a persisted page read. A live Gemini availability
    // probe belongs to an explicit troubleshooting action, never Pipeline's
    // initial rendering path.
    return { items, total, page: Math.max(page, 1), limit: take, provider: this.provider.status(), suggestedQuestions: TROUBLESHOOTING_QUESTIONS };
  }

  async get(user: User, projectId: string, sessionId: string) {
    const session = await this.sessionFor(user, projectId, sessionId, false);
    const run = await this.runs.findOne({ where: { id: session.pipelineRunId, projectId } });
    const [messages, results, collected, provider, project] = await Promise.all([
      this.messages.find({ where: { sessionId }, order: { createdAt: "ASC" }, take: 20 }),
      this.results.find({ where: { sessionId }, order: { revision: "DESC" }, take: 10 }),
      run ? this.collectedForSession(session, run, user) : this.evidenceService.collect(projectId, session.pipelineRunId, user),
      this.provider.availability(),
      this.projects.findOne({ where: { id: projectId } }),
    ]);
    const operationAction = (run?.metadata?.deploymentAction || "deploy") as "deploy" | "rollback" | "destroy";
    const failedStage = run?.metadata?.failedStage || run?.currentStage;
    const safeMessages = await Promise.all(messages.map(async (message) => ({ ...message, content: await this.evidenceService.sanitizeUserInput(projectId, message.content) })));
    return {
      session,
      messages: safeMessages,
      results,
      provider,
      operation: run ? { id: run.id, action: operationAction, commitSha: run.commitSha, generationId: run.generationId, failedStage, failedStageLabel: deployguardOperationStagePresentation(failedStage, operationAction).label, failedAt: run.failedAt, completedAt: run.completedAt, startedAt: run.startedAt, createdAt: run.createdAt, summary: run.errorMessage, failureOwner: run.failureOwner || "UNVERIFIED", externalProvider: run.externalProvider, failureCode: run.failureCode, failureServiceId: run.failureServiceId } : null,
      evidence: { context: { ...collected.context, project: project ? { name: project.name, repository: project.repositoryFullName } : null }, groups: collected.groups },
      suggestedQuestions: TROUBLESHOOTING_QUESTIONS,
    };
  }

  async close(user: User, projectId: string, sessionId: string) {
    const session = await this.sessionFor(user, projectId, sessionId, true);
    session.closedAt = new Date(); session.status = "closed";
    await this.sessions.save(session);
    await this.audit.record({ actorUser: user, action: "ai.analysis.closed", resourceType: "ai_analysis_session", resourceId: session.id, status: "success", metadata: { projectId } });
    return { id: session.id, status: session.status, closedAt: session.closedAt };
  }

  private async generate(session: AiAnalysisSession, run: ProjectPipelineRun, user: User, followUp: string | null, questionType: TroubleshootingQuestionType | null, collected: Awaited<ReturnType<AiEvidenceService["collect"]>>) {
    const failedEvidence = [...collected.evidence].reverse().find((item) => /fail|error|blocked|denied/i.test(item.text));
    const failedPresentation = presentPipelineStage(failedEvidence?.stage || run.currentStage || "pipeline");
    const [project, conversation] = await Promise.all([
      this.projects.findOne({ where: { id: session.projectId } }),
      this.messages.find({ where: { sessionId: session.id }, order: { createdAt: "DESC" }, take: 6 }),
    ]);
    const safeConversation = await Promise.all(conversation.reverse().map(async (item) => ({ role: item.role, content: await this.evidenceService.sanitizeUserInput(session.projectId, item.content) })));
    const context = {
      ...collected.context,
      projectId: session.projectId,
      project: project ? { name: project.name, repository: project.repositoryFullName } : null,
      runStatus: run.status,
      failedStage: failedPresentation.key,
      failedStageLabel: failedPresentation.label,
      failureMessage: run.errorMessage,
      failureOwner: run.failureOwner || "UNVERIFIED",
      externalProvider: run.externalProvider,
      failureCode: run.failureCode,
      failureServiceId: run.failureServiceId,
      problemType: collected.context.problemType,
      conversation: safeConversation,
    };
    let output: {
      value: ReturnType<AiEvidencePreprocessorService["fallback"]> | NonNullable<ReturnType<AiEvidencePreprocessorService["validate"]>>;
      mode: string;
      provider: string;
      model: string | null;
      usage: Record<string, unknown> | null;
    };
    try { output = await this.provider.analyze(this.preprocessor.buildPrompt(context, collected.evidence, followUp || undefined, questionType), { evidence: collected.evidence, facts: context }); }
    catch (error) {
      session.lastError = error instanceof Error ? this.sanitizer.sanitize(error.message).slice(0, 500) : "AI provider request failed.";
      output = {
        value: this.preprocessor.fallback(context, collected.evidence),
        mode: "evidence_only",
        provider: "local_evidence",
        model: null,
        usage: null,
      };
      await this.audit.record({ actorUser: user, action: "ai.provider.fallback", resourceType: "ai_analysis_session", resourceId: session.id, status: "success", metadata: { projectId: session.projectId, pipelineRunId: run.id, resultMode: "evidence_only" } });
    }
    const value = output.value as ReturnType<AiEvidencePreprocessorService["fallback"]>;
    const revision = await this.results.count({ where: { sessionId: session.id } }) + 1;
    const diagnosticDetails = { likelyResponsibility: value.likelyResponsibility, affectedComponent: value.affectedComponent, completedStages: value.completedStages, recommendedAction: value.recommendedAction, retryRecommendation: value.retryRecommendation, problemType: value.problemType };
    const result = await this.results.save(this.results.create({ sessionId: session.id, summary: value.summary, rootCause: value.rootCause, technicalDetails: value.technicalDetails, remediationSteps: value.remediationSteps, evidenceReferences: value.evidenceReferences, limitations: value.limitations, confidence: value.confidence, resultMode: output.mode, diagnosticDetails, revision }));
    await this.messages.save(this.messages.create({ sessionId: session.id, role: "assistant", content: this.answer(value, questionType), usageMetadata: { ...(output.usage || {}), ...(questionType ? { questionType } : {}) } }));
    session.status = "completed"; session.provider = output.provider; session.model = output.model; session.providerMode = output.mode; session.initialContext = { ...(session.initialContext || {}), diagnosticContext: context, evidenceSnapshot: collected }; if (output.mode === "live") session.lastError = null;
    await this.sessions.save(session);
    await this.trimMessages(session.id);
    return { session, result, provider: this.provider.status(), suggestedQuestions: TROUBLESHOOTING_QUESTIONS };
  }

  private assertEligibleRun(run: ProjectPipelineRun, collected: Awaited<ReturnType<AiEvidenceService["collect"]>>) {
    if (isAiTroubleshootingEligible(run)) return;
    if (isAiRuntimeTroubleshootingCandidate(run) && collected.evidence.some((item) => item.source === "cloudwatch_runtime")) return;
    throw new BadRequestException(isAiRuntimeTroubleshootingCandidate(run)
      ? "LIVE runtime troubleshooting requires current generation-correlated CloudWatch application evidence."
      : "Troubleshooting requires a failed deployment attempt with sanitized persisted evidence.");
  }

  private async collectedForSession(session: AiAnalysisSession, run: ProjectPipelineRun, user: User) {
    const snapshot = session.initialContext?.evidenceSnapshot as Awaited<ReturnType<AiEvidenceService["collect"]>> | undefined;
    if (snapshot?.context?.pipelineRunId === run.id && Array.isArray(snapshot.evidence) && snapshot.groups && typeof snapshot.groups === "object") return snapshot;
    const serviceId = typeof session.initialContext?.requestedServiceId === "string" ? session.initialContext.requestedServiceId : undefined;
    const collected = await this.evidenceService.collect(session.projectId, run.id, user, serviceId);
    session.initialContext = { ...(session.initialContext || {}), requestedServiceId: serviceId || null, evidenceSnapshot: collected };
    await this.sessions.save(session);
    return collected;
  }

  private answer(value: ReturnType<AiEvidencePreprocessorService["fallback"]>, questionType: TroubleshootingQuestionType | null) {
    if (questionType === "responsibility") return `Likely responsibility: ${value.likelyResponsibility}. ${value.technicalDetails} Confidence: ${Math.round(value.confidence * 100)}%.`;
    if (questionType === "deployment_progress") return value.completedStages.length ? `Evidence-proven completed stages: ${value.completedStages.map((stage) => stage.stage).join(", ")}. Unresolved problem: ${value.rootCause}` : `No completed stage is proven by the supplied evidence. Unresolved problem: ${value.rootCause}`;
    if (questionType === "retry_safety") return `Retry recommendation: ${value.retryRecommendation.decision}. ${value.retryRecommendation.reason}`;
    if (questionType === "remediation") return `${value.recommendedAction} ${value.remediationSteps.join(" ")}`;
    return value.summary;
  }

  private async sessionFor(user: User, projectId: string, id: string, manage: boolean) {
    await this.assertAccess(user, projectId, manage);
    const session = await this.sessions.findOne({ where: { id, projectId } });
    if (!session) throw new NotFoundException("Troubleshooting session not found.");
    return session;
  }
  private async assertAccess(user: User, projectId: string, manage: boolean) {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found.");
    const allowed = user.role === UserRole.ADMIN || project.ownerUserId === user.id;
    if (!allowed || (manage && user.role === UserRole.READONLY)) {
      await this.audit.record({ actorUser: user, action: "ai.analysis.access_denied", resourceType: "project", resourceId: projectId, status: "denied" });
      throw new ForbiddenException("You do not have access to troubleshoot this project.");
    }
  }
  private async assertRate(userId: number, kind: "analysis" | "followup") {
    const since = new Date(Date.now() - 60_000);
    const count = kind === "analysis" ? await this.sessions.count({ where: { userId, createdAt: MoreThan(since) } }) : await this.messages.createQueryBuilder("message").innerJoin(AiAnalysisSession, "session", "session.id = message.session_id").where("session.user_id = :userId", { userId }).andWhere("message.role = 'user'").andWhere("message.created_at > :since", { since }).getCount();
    if (count >= (kind === "analysis" ? 3 : 10)) throw new HttpException("AI troubleshooting rate limit reached. Try again in one minute.", HttpStatus.TOO_MANY_REQUESTS);
  }
  private async trimMessages(sessionId: string) {
    const rows = await this.messages.find({ where: { sessionId }, order: { createdAt: "DESC" } });
    if (rows.length > 10) await this.messages.delete(rows.slice(10).map((row) => row.id));
  }
}
