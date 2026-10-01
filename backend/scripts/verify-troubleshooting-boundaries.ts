import "reflect-metadata";
import { strict as assert } from "node:assert";
import { ParseUUIDPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiEvidencePreprocessorService, ProcessedEvidence } from "../src/ai-troubleshooting/ai-evidence-preprocessor.service";
import { AiEvidenceService } from "../src/ai-troubleshooting/ai-evidence.service";
import { AiProviderAdapter } from "../src/ai-troubleshooting/ai-provider.adapter";
import { TROUBLESHOOTING_QUESTIONS } from "../src/ai-troubleshooting/ai-troubleshooting-contract";
import { AiTroubleshootingService, isAiRuntimeTroubleshootingCandidate, isAiTroubleshootingEligible } from "../src/ai-troubleshooting/ai-troubleshooting.service";
import { LogSanitizerService } from "../src/observability/log-sanitizer.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";

const user = { id: 7 } as any;
const projectId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const generationId = "44444444-4444-4444-8444-444444444444";
const sanitizer = new LogSanitizerService();
const preprocessor = new AiEvidencePreprocessorService(sanitizer);

async function verifyMalformedUuidStopsAtBoundary() {
  const pipe = new ParseUUIDPipe();
  await assert.rejects(() => pipe.transform("[object Event]", { type: "param", data: "sessionId", metatype: String }), (error: any) => error?.getStatus?.() === 400);
  assert.equal(await pipe.transform(sessionId, { type: "param", data: "sessionId", metatype: String }), sessionId);
}

function reference(row: ProcessedEvidence) { return { source: row.source, eventId: row.eventId, stage: row.stage }; }

function validModelResult(evidence: ProcessedEvidence[], overrides: Record<string, unknown> = {}) {
  const passed = evidence.find((row) => row.text.startsWith("[passed]"))!;
  return {
    summary: "The application template failed after platform deployment completed.",
    rootCause: "Flask raised TemplateNotFound: index.html.",
    technicalDetails: "The supplied CloudWatch event contains the exception while deterministic lifecycle evidence remains LIVE.",
    remediationSteps: ["Add or correctly package index.html."], confidence: 0.91,
    limitations: "No repository source file was supplied.", evidenceReferences: evidence.map(reference),
    likelyResponsibility: "REPOSITORY_APPLICATION", affectedComponent: "application template",
    completedStages: [{ stage: passed.stage, evidenceReference: reference(passed) }],
    recommendedAction: "Correct the Flask template packaging.",
    retryRecommendation: { decision: "SAFE_AFTER_FIX", reason: "Reproduce the request after correcting the template." },
    problemType: "LIVE_RUNTIME_ISSUE", ...overrides,
  };
}

function verifyPreprocessingAndValidation() {
  const secret = "runtime-secret-value";
  assert.equal(preprocessor.sanitizeText("PIN=abc", ["abc"]), "PIN=[REDACTED_ENV_VALUE]", "short protected ENV values are never exempt from redaction");
  const evidence = preprocessor.preprocess([
    { source: "github_actions_stage", stage: "terraform_apply", eventId: "stage-1", text: "[passed] Terraform apply completed" },
    { source: "github_actions_stage", stage: "terraform_apply", eventId: "stage-1-duplicate", text: "[passed] Terraform apply completed" },
    { source: "cloudwatch_runtime", stage: "application_runtime", eventId: "log-1", text: `progress\nHTTP 500\njinja2.exceptions.TemplateNotFound: index.html\nTOKEN=${secret}` },
    { source: "github_actions", stage: "build", eventId: "noise", text: "heartbeat" },
  ], [secret]);
  assert.equal(evidence.some((row) => row.text === "heartbeat"), false, "routine noise is removed");
  assert.equal(evidence.filter((row) => row.stage === "terraform_apply").length, 1, "repeated evidence is deduplicated");
  assert.match(evidence.find((row) => row.source === "cloudwatch_runtime")!.text, /TemplateNotFound: index\.html/);
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(secret)); assert.match(JSON.stringify(evidence), /REDACTED/);
  const context = { failureOwner: "UNVERIFIED", problemType: "LIVE_RUNTIME_ISSUE" };
  const valid = preprocessor.validate(validModelResult(evidence), evidence, context);
  assert.equal(valid?.likelyResponsibility, "REPOSITORY_APPLICATION", "UNVERIFIED authority permits clearly labeled AI likely responsibility");
  assert.equal(context.failureOwner, "UNVERIFIED", "AI validation cannot mutate authoritative ownership");
  assert.equal(preprocessor.validate(validModelResult(evidence, { confidence: 1.2 }), evidence, context), null, "out-of-range confidence is rejected, not clamped");
  assert.equal(preprocessor.validate(validModelResult(evidence, { remediationSteps: [{ unsafe: true }] }), evidence, context), null, "non-string remediation is rejected");
  const referencesFiltered = preprocessor.validate(validModelResult(evidence, { evidenceReferences: [reference(evidence[0]), { source: "invented", eventId: "none", stage: "fake" }] }), evidence, context);
  assert.deepEqual(referencesFiltered?.evidenceReferences, [{ ...reference(evidence[0]), lineReference: null }], "unsupported optional references are removed while the valid response is retained");
  assert.deepEqual(preprocessor.validate(validModelResult(evidence, { evidenceReferences: [{ source: "invented", eventId: "none", stage: "fake" }] }), evidence, context)?.evidenceReferences, [], "hallucinated evidence references are never accepted");
  assert.deepEqual(preprocessor.validate(validModelResult(evidence, { completedStages: [] }), [], context)?.evidenceReferences, [], "references are removed when no evidence was supplied");
  assert.equal(preprocessor.validate(validModelResult(evidence), evidence, { failureOwner: "DEPLOYGUARD_PLATFORM", problemType: "LIVE_RUNTIME_ISSUE" }), null, "AI cannot contradict deterministic ownership");
  for (const question of TROUBLESHOOTING_QUESTIONS) {
    const prompt = preprocessor.buildPrompt(context, evidence, question.label, question.type);
    assert.match(prompt, new RegExp(`QUESTION_TYPE=${question.type}`)); assert.ok(prompt.includes(question.contract));
  }
  assert.deepEqual(TROUBLESHOOTING_QUESTIONS.slice(0, 6).map((question) => question.label), ["What actually failed?", "Why did it fail?", "Is this likely an application, DeployGuard, or external-provider problem?", "What completed successfully before the problem?", "What should I do to fix it?", "Is it safe to retry now?"]);
  return evidence;
}

async function verifyPersistedOperationEvidence() {
  const secret = "persisted-operation-secret"; const failedAt = new Date("2026-09-03T00:00:00.000Z");
  const securityScan = { contractVersion: "deployguard.security-result/v1", deploymentOperationId: runId, projectId, commitSha: "c".repeat(40), status: "blocked", critical: 2 };
  const run: any = {
    id: runId, projectId, status: PipelineRunStatus.FAILED, generationId: null, commitSha: "c".repeat(40), currentStage: "terraform_plan", failedAt, updatedAt: failedAt,
    githubWorkflowRunId: "456", failureOwner: "REPOSITORY_APPLICATION", failureCode: "DG_TERRAFORM_PLAN_FAILED", failureServiceId: null, errorMessage: "Terraform plan failed",
    metadata: { deploymentAction: "deploy", failedStage: "terraform_plan", safeLog: `terraform plan exited with code 1 TOKEN=${secret}`, terraformPlanSummary: { create: 2 }, terraformDiagnostics: [{ severity: "error", summary: "Unsupported argument" }], buildIdentity: { serviceName: "web", buildTargetFingerprint: "abc" }, securityScan },
  };
  let cloudWatchCalls = 0;
  const service = new AiEvidenceService(
    { findOne: async ({ where }: any) => where.id === runId && where.projectId === projectId ? run : null } as any,
    { find: async () => [{ id: "pipeline-1", projectId, pipelineRunId: runId, stage: "terraform_plan", status: "failed", message: "Terraform plan failed", source: "deployguard", occurredAt: failedAt }] } as any,
    { find: async () => [] } as any,
    { createQueryBuilder: () => ({ addSelect() { return this; }, where() { return this; }, andWhere() { return this; }, getMany: async () => [{ value: secret }] }) } as any,
    preprocessor, { decrypt: (value: string) => value } as any,
    { getRecentLogs: async () => { cloudWatchCalls += 1; return { available: true, generationId: "wrong", events: [] }; } } as any,
  );
  const collected = await service.collect(projectId, runId, user);
  assert.equal(cloudWatchCalls, 0, "pre-runtime failed operations never query CloudWatch");
  assert.equal(collected.context.pipelineRunId, runId); assert.equal(collected.context.commitSha, run.commitSha); assert.equal(collected.context.generationId, null);
  assert.match(collected.evidence.find((row) => row.source === "terraform" && /plan summary/i.test(row.text))!.text, /"create":2/);
  assert.match(collected.evidence.find((row) => row.source === "terraform" && /diagnostics/i.test(row.text))!.text, /Unsupported argument/);
  assert.match(collected.evidence.find((row) => row.source === "security_scan")!.text, /"critical":2/);
  assert.match(collected.evidence.find((row) => row.source === "deployguard_build_identity")!.text, /"serviceName":"web"/);
  assert.match(collected.evidence.find((row) => /terraform plan exited/i.test(row.text))!.text, /REDACTED/, "sanitized safeLog reaches the AI evidence snapshot");
  assert.doesNotMatch(JSON.stringify(collected.evidence), new RegExp(secret));
  assert.ok(collected.evidence.every((row) => !row.eventId || [runId, "456", "pipeline-1"].includes(row.eventId)), "every persisted evidence item remains operation-correlated");
}

async function verifyCorrelatedLiveEvidence() {
  const secret = "live-runtime-secret"; const completedAt = new Date("2026-09-02T00:00:00.000Z");
  const run: any = { id: runId, projectId, status: PipelineRunStatus.COMPLETED, generationId, commitSha: "a".repeat(40), currentStage: "release_complete", completedAt, updatedAt: completedAt, failedAt: null, githubWorkflowRunId: "123", failureOwner: null, metadata: { deploymentAction: "deploy", releaseEvidenceVerified: true, workflowStages: [{ key: "terraform_apply", label: "Terraform Apply", status: "passed", completedAt: completedAt.toISOString() }] } };
  let cloudWatchCalls = 0;
  const service = new AiEvidenceService(
    { findOne: async ({ where }: any) => where.id === runId && where.projectId === projectId ? run : null } as any,
    { find: async () => [{ id: "event-1", stage: "release_complete", status: "success", message: "Release finalization completed", source: "deployguard", occurredAt: completedAt }] } as any,
    { find: async () => [] } as any,
    { createQueryBuilder: () => ({ addSelect() { return this; }, where() { return this; }, andWhere() { return this; }, getMany: async () => [{ value: secret }] }) } as any,
    preprocessor, { decrypt: (value: string) => value } as any,
    { getRecentLogs: async (_user: any, id: string, options: any, serviceId: string) => { cloudWatchCalls += 1; assert.equal(id, projectId); assert.equal(options.since, completedAt.toISOString()); assert.equal(serviceId, "service-a"); return { available: true, generationId, serviceId, events: [{ id: "cw-1", timestamp: "2026-09-02T00:01:00.000Z", source: "application/task", message: `HTTP 500 TemplateNotFound: index.html ${secret}` }] }; } } as any,
  );
  const collected = await service.collect(projectId, runId, user, "service-a");
  assert.equal(cloudWatchCalls, 1); assert.equal(collected.context.pipelineRunId, runId); assert.equal(collected.context.generationId, generationId); assert.equal(collected.context.commitSha, run.commitSha); assert.equal(collected.context.runtimeServiceId, "service-a"); assert.equal(collected.context.problemType, "LIVE_RUNTIME_ISSUE");
  assert.deepEqual(new Set(collected.evidence.map((row) => row.source)), new Set(["deployguard_lifecycle", "github_actions_stage", "cloudwatch_runtime"]));
  assert.match(JSON.stringify(collected.evidence), /TemplateNotFound: index\.html/); assert.doesNotMatch(JSON.stringify(collected.evidence), new RegExp(secret));
  assert.equal(await service.sanitizeUserInput(projectId, `please inspect ${secret}`), "please inspect [REDACTED_ENV_VALUE]", "protected ENV values are redacted before conversation persistence or display");
  return { collected, run };
}

async function verifyServiceBoundaries(collected: any, run: any) {
  const failed = { status: PipelineRunStatus.FAILED, githubWorkflowRunId: "123", metadata: { safeLog: "failed" } } as any;
  assert.equal(isAiTroubleshootingEligible(failed), true); assert.equal(isAiRuntimeTroubleshootingCandidate(run), true);
  const service = Object.create(AiTroubleshootingService.prototype) as any;
  assert.doesNotThrow(() => service.assertEligibleRun(run, collected));
  assert.throws(() => service.assertEligibleRun(run, { ...collected, evidence: collected.evidence.filter((row: any) => row.source !== "cloudwatch_runtime") }), /generation-correlated CloudWatch/);
  let recollections = 0; let saves = 0;
  const session: any = { id: sessionId, pipelineRunId: run.id, projectId, initialContext: { evidenceSnapshot: collected, requestedServiceId: "service-a" } };
  service.evidenceService = { collect: async () => { recollections += 1; return collected; } }; service.sessions = { save: async () => { saves += 1; } };
  assert.equal(await service.collectedForSession(session, run, user), collected); assert.equal(await service.collectedForSession(session, run, user), collected);
  assert.equal(recollections, 0, "follow-ups reuse the same evidence snapshot"); assert.equal(saves, 0);

  const historicalDiagnosis = { terminalFailureCode: "DG_APPLICATION_EXTERNAL_BINDING_FAILED", rootCauseCode: "DG_FAILURE_CAUSE_UNVERIFIED", retryDecision: "INSUFFICIENT_EVIDENCE" };
  const historicalSnapshot: any = {
    context: { pipelineRunId: "failed-operation", failureOwner: "UNVERIFIED", failureCode: "DG_APPLICATION_EXTERNAL_BINDING_FAILED", failureDiagnostic: historicalDiagnosis, rootCauseCode: historicalDiagnosis.rootCauseCode, retryDecision: historicalDiagnosis.retryDecision },
    evidence: [{ source: "deployguard_diagnosis", text: JSON.stringify(historicalDiagnosis) }],
    groups: { deployguard_diagnosis: [] },
  };
  const failedRun: any = {
    id: "failed-operation", status: PipelineRunStatus.FAILED, commitSha: "f".repeat(40), currentStage: "application_runtime",
    failureCode: "DG_APPLICATION_EXTERNAL_BINDING_FAILED", failureOwner: "UNVERIFIED", externalProvider: null,
    failedAt: new Date("2026-09-02T00:02:00.000Z"),
    metadata: { deploymentAction: "deploy", failedStage: "application_runtime", safeLog: "DG_FAILURE code=DG_APPLICATION_EXTERNAL_BINDING_FAILED stage=application_runtime", failureDiagnostic: historicalDiagnosis },
  };
  const failedSession: any = { pipelineRunId: failedRun.id, initialContext: { evidenceSnapshot: historicalSnapshot } };
  const immutableSnapshot = JSON.stringify(historicalSnapshot);
  const current = await service.collectedForSession(failedSession, failedRun, user);
  assert.equal(current.context.failureOwner, "REPOSITORY_APPLICATION");
  assert.equal(current.context.retryDecision, "SAFE_AFTER_FIX");
  assert.equal(current.context.rootCauseCode, "DG_APPLICATION_EXTERNAL_BINDING_FAILED");
  assert.equal(JSON.stringify(historicalSnapshot), immutableSnapshot, "current troubleshooting recovery projection must not rewrite its historical evidence snapshot");
  assert.equal(saves, 0, "reclassification of a persisted snapshot is read-only");
}

async function verifyProviderFallbackAndStateAuthority(evidence: ProcessedEvidence[]) {
  const adapter = new AiProviderAdapter(new ConfigService({ AI_ASSISTANT_ENABLED: "true", GOOGLE_AI_API_KEY: "configured-for-test" }), preprocessor) as any;
  assert.equal(adapter.temperature(), 0.3); assert.equal(adapter.maxOutputTokens(), 1000);
  let attempts = 0; adapter.request = async () => { attempts += 1; return { content: JSON.stringify({ summary: "malformed" }), usage: null }; };
  await assert.rejects(() => adapter.analyze("bounded prompt", { evidence, facts: { failureOwner: "UNVERIFIED", problemType: "LIVE_RUNTIME_ISSUE" } }), /invalid response after retry/);
  assert.equal(attempts, 2, "malformed provider output gets one bounded repair attempt before fallback");
  const run: any = { id: runId, projectId, status: PipelineRunStatus.FAILED, commitSha: "b".repeat(40), generationId: null, currentStage: "railpack_build", errorMessage: "sanitized failure", failureOwner: "REPOSITORY_APPLICATION", externalProvider: null, failureCode: "DG_RAILPACK_BUILD_FAILED", failureServiceId: null, metadata: { deploymentAction: "deploy", safeLog: "build failed" } };
  const authoritativeBefore = JSON.stringify({ status: run.status, failureOwner: run.failureOwner, failureCode: run.failureCode });
  const collected: any = { context: { pipelineRunId: run.id, problemType: "FAILED_DEPLOYMENT", failureOwner: run.failureOwner }, evidence, groups: {} };
  const service = Object.create(AiTroubleshootingService.prototype) as any; const savedResults: any[] = []; const savedMessages: any[] = [];
  service.projects = { findOne: async () => ({ name: "Example", repositoryFullName: "example/app" }) };
  service.messages = { find: async () => [], create: (value: any) => value, save: async (value: any) => { savedMessages.push(value); return value; } };
  service.results = { count: async () => 0, create: (value: any) => value, save: async (value: any) => { savedResults.push(value); return value; } };
  service.sessions = { save: async (value: any) => value }; service.provider = { analyze: async () => { throw new Error("provider unavailable"); }, status: () => ({ configured: false }) }; service.audit = { record: async () => undefined }; service.sanitizer = sanitizer; service.preprocessor = preprocessor; service.trimMessages = async () => undefined;
  const session: any = { id: sessionId, projectId, pipelineRunId: run.id, initialContext: { evidenceSnapshot: collected }, status: "processing" };
  const response = await service.generate(session, run, user, null, null, collected);
  assert.equal(response.result.resultMode, "evidence_only"); assert.equal(savedResults[0].diagnosticDetails.likelyResponsibility, "REPOSITORY_APPLICATION"); assert.equal(savedMessages.at(-1).role, "assistant");
  assert.equal(session.lastError, "AI provider unavailable.", "fallback stores a short sanitized reason instead of provider payloads");
  assert.equal(JSON.stringify({ status: run.status, failureOwner: run.failureOwner, failureCode: run.failureCode }), authoritativeBefore, "AI fallback never mutates deterministic deployment facts");
}

function verifyQuestionSpecificAnswers(evidence: ProcessedEvidence[]) {
  const service = Object.create(AiTroubleshootingService.prototype) as any;
  const value = preprocessor.fallback({ failureOwner: "UNVERIFIED", problemType: "FAILED_DEPLOYMENT", failedStage: "deployment_contract_admission" }, evidence);
  const context = { failureServiceId: null, failedStage: "deployment_contract_admission", failedStageLabel: "Deployment contract admission" };
  const answers = new Map(TROUBLESHOOTING_QUESTIONS.map((question) => [question.type, service.answer(value, question.type, context, evidence)]));
  assert.equal(answers.size, 10); for (const answer of answers.values()) assert.notEqual(answer, value.summary, "typed follow-ups must not collapse to the generic summary");
  assert.match(answers.get("failure_summary")!, /Failure summary:/); assert.match(answers.get("root_cause")!, /Root cause/); assert.match(answers.get("responsibility")!, /Likely responsibility/);
  assert.match(answers.get("deployment_progress")!, /completed stage/i); assert.match(answers.get("remediation")!, new RegExp(value.recommendedAction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(answers.get("retry_safety")!, /Retry recommendation/); assert.match(answers.get("infrastructure_change")!, /Infrastructure change assessment/); assert.match(answers.get("previous_live_generation")!, /Previous LIVE generation assessment/);
  assert.match(answers.get("failed_service")!, /No runtime service failure is proven/); assert.match(answers.get("failed_service")!, /Deployment contract admission/); assert.match(answers.get("supporting_evidence")!, /Supporting evidence|No validated supporting evidence/);
}

async function verifyGeminiStructuredSchema() {
  const adapter = new AiProviderAdapter(new ConfigService({ AI_ASSISTANT_ENABLED: "true", GOOGLE_AI_API_KEY: "configured-for-test" }), preprocessor) as any;
  const originalFetch = globalThis.fetch; let requestBody: any = null;
  globalThis.fetch = (async (_url: any, init: any) => { requestBody = JSON.parse(init.body); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }) } as any; }) as any;
  try { await adapter.requestGoogle("bounded prompt"); } finally { globalThis.fetch = originalFetch; }
  assert.equal(requestBody.generationConfig.temperature, 0.3); assert.equal(requestBody.generationConfig.maxOutputTokens, 1000); assert.equal(requestBody.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(requestBody.generationConfig.responseSchema.required.includes("evidenceReferences"), true, "Gemini receives the existing analysis-result JSON schema");
}

async function verifySessionOperationTimestamps() {
  const failedAt = new Date("2026-08-29T10:02:00.000Z"); const completedAt = new Date("2026-08-29T10:03:00.000Z"); const startedAt = new Date("2026-08-29T10:00:00.000Z"); const createdAt = new Date("2026-08-29T09:59:00.000Z");
  const run: any = { id: runId, commitSha: "a".repeat(40), generationId: null, currentStage: "build_immutable_railpack_image", failedAt, completedAt, startedAt, createdAt, errorMessage: "sanitized failure", metadata: { deploymentAction: "deploy", failedStage: "build_immutable_railpack_image" } };
  const snapshot = { context: { pipelineRunId: run.id }, evidence: [], groups: {} };
  const service = Object.create(AiTroubleshootingService.prototype) as any;
  service.sessionFor = async () => ({ id: sessionId, pipelineRunId: run.id, initialContext: { evidenceSnapshot: snapshot } }); service.messages = { find: async () => [] }; service.results = { find: async () => [] }; service.runs = { findOne: async () => run }; service.provider = { availability: async () => ({ available: false }) }; service.projects = { findOne: async () => ({ name: "Example", repositoryFullName: "example/app" }) };
  const response = await service.get(user, projectId, sessionId);
  assert.equal(response.operation.failedAt, failedAt); assert.equal(response.operation.failedStageLabel, "Build Application"); assert.equal(response.operation.failureOwner, "UNVERIFIED");
}

void (async () => {
  await verifyMalformedUuidStopsAtBoundary(); const evidence = verifyPreprocessingAndValidation(); await verifyPersistedOperationEvidence(); const live = await verifyCorrelatedLiveEvidence();
  await verifyServiceBoundaries(live.collected, live.run); verifyQuestionSpecificAnswers(evidence); await verifyGeminiStructuredSchema(); await verifyProviderFallbackAndStateAuthority(evidence); await verifySessionOperationTimestamps();
  console.log("TROUBLESHOOTING_BOUNDARIES=PASS MULTI_SOURCE_CORRELATED=1 NOISE_REDUCED=1 SECRETS_REDACTED=1 QUESTION_CONTRACTS=10 MALFORMED_REJECTED=1 HALLUCINATED_REFERENCES_REJECTED=1 AUTHORITY_PRESERVED=1 UNVERIFIED_AI_LIKELIHOOD=1 SNAPSHOT_BOUNDED_FOLLOWUP=1 PROVIDER_FALLBACK=1 FAILED_DEPLOYMENT=1 LIVE_RUNTIME_EVIDENCE_GATED=1 AI_STATE_MUTATIONS=0");
})().catch((error) => { console.error(error); process.exitCode = 1; });
