export const AI_LIKELY_RESPONSIBILITIES = [
  "REPOSITORY_APPLICATION",
  "DEPLOYGUARD_PLATFORM",
  "EXTERNAL_PROVIDER",
  "INSUFFICIENT_EVIDENCE",
] as const;

export const AI_RETRY_DECISIONS = ["SAFE_NOW", "SAFE_AFTER_FIX", "NOT_SAFE_YET", "INSUFFICIENT_EVIDENCE"] as const;
export const AI_PROBLEM_TYPES = ["FAILED_DEPLOYMENT", "LIVE_RUNTIME_ISSUE"] as const;

export const TROUBLESHOOTING_QUESTIONS = [
  { type: "failure_summary", label: "What actually failed?", contract: "Identify the first proven failure or observed runtime problem. Return summary, affectedComponent, rootCause, and evidenceReferences." },
  { type: "root_cause", label: "Why did it fail?", contract: "Explain only the evidence-supported causal chain. Return rootCause, technicalDetails, limitations, evidenceReferences, and confidence." },
  { type: "responsibility", label: "Is this likely an application, DeployGuard, or external-provider problem?", contract: "Return likelyResponsibility, the reason in technicalDetails, supporting evidenceReferences, and confidence. Never contradict deterministic failureOwner." },
  { type: "deployment_progress", label: "What completed successfully before the problem?", contract: "Return only evidence-proven completedStages, the failed or observed component, unresolved problem, and evidenceReferences. Never infer PASS from log order alone." },
  { type: "remediation", label: "What should I do to fix it?", contract: "Return rootCause, affectedComponent, recommendedAction, bounded remediationSteps, retryRecommendation, evidenceReferences, and confidence." },
  { type: "retry_safety", label: "Is it safe to retry now?", contract: "Return retryRecommendation with a decision and evidence-based reason. Do not claim a fix was executed." },
  { type: "infrastructure_change", label: "Did this operation change infrastructure before it failed?", contract: "Use Terraform and lifecycle evidence only. State what infrastructure mutation is proven or report insufficient evidence." },
  { type: "previous_live_generation", label: "Is the previous verified LIVE generation still available?", contract: "Use only supplied generation/release evidence. Do not infer current AWS availability from historical release evidence." },
  { type: "failed_service", label: "Which service actually failed?", contract: "Use failureServiceId and service-correlated evidence. If no service is proven, report insufficient evidence." },
  { type: "supporting_evidence", label: "What evidence supports this diagnosis?", contract: "Explain the diagnosis using only valid evidenceReferences supplied in this session." },
] as const;

export type TroubleshootingQuestionType = typeof TROUBLESHOOTING_QUESTIONS[number]["type"];

export function troubleshootingQuestion(type?: string | null) {
  return TROUBLESHOOTING_QUESTIONS.find((question) => question.type === type) || null;
}
