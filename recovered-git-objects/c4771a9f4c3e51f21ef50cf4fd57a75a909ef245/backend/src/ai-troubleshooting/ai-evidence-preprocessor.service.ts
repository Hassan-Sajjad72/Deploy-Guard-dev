import { Injectable } from "@nestjs/common";
import { LogSanitizerService } from "../observability/log-sanitizer.service";

export type RawEvidence = { source: string; stage?: string | null; eventId?: string | null; timestamp?: Date | string | null; text: string; lineReference?: string | null };
export type ProcessedEvidence = RawEvidence & { text: string; signals: string[] };

@Injectable()
export class AiEvidencePreprocessorService {
  constructor(private readonly sanitizer: LogSanitizerService) {}

  preprocess(rows: RawEvidence[], environmentValues: string[] = []) {
    const seen = new Set<string>();
    const sourceUsage = new Map<string, number>();
    const output: ProcessedEvidence[] = [];
    let total = 0;
    for (const row of rows) {
      let text = this.clean(row.text);
      for (const value of environmentValues.filter((item) => item.length >= 4)) text = text.split(value).join("[REDACTED_ENV_VALUE]");
      text = this.sanitizer.sanitize(text).trim();
      if (!text || this.isNoise(text)) continue;
      const key = `${row.source}:${row.stage || ""}:${text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const perSource = sourceUsage.get(row.source) || 0;
      if (perSource >= 12000 || total >= 30000) continue;
      const allowed = Math.min(4000, 12000 - perSource, 30000 - total);
      text = text.slice(0, allowed);
      const signals = this.signals(text);
      output.push({ ...row, text, signals });
      sourceUsage.set(row.source, perSource + text.length);
      total += text.length;
    }
    return output;
  }

  buildPrompt(context: Record<string, unknown>, evidence: ProcessedEvidence[], followUp?: string) {
    const safeFollowUp = followUp ? this.sanitizer.sanitize(this.clean(followUp)).slice(0, 1000) : null;
    return [
      "You are DeployGuard's deployment troubleshooting assistant. Use only supplied evidence; never invent raw logs.",
      "Return strict JSON with keys: summary, rootCause, technicalDetails, remediationSteps (array), confidence (0..1), limitations, evidenceReferences (array of {source,eventId,stage,lineReference}).",
      `Deployment context: ${JSON.stringify(context)}`,
      `Evidence: ${JSON.stringify(evidence.map((item) => ({ source: item.source, stage: item.stage, eventId: item.eventId, timestamp: item.timestamp, lineReference: item.lineReference, text: item.text, signals: item.signals })))}`,
      safeFollowUp ? `User follow-up: ${safeFollowUp}` : "",
    ].filter(Boolean).join("\n\n");
  }

  fallback(context: Record<string, unknown>, evidence: ProcessedEvidence[]) {
    const failed = evidence.find((item) => /fail|error|blocked|exit code|denied/i.test(item.text)) || evidence.at(-1);
    return {
      summary: failed ? `Deployment evidence indicates a failure in ${failed.stage || "the current stage"}.` : "No decisive failure evidence was persisted.",
      rootCause: failed?.text || "The available structured events do not identify a single root cause.",
      technicalDetails: `Analysis used ${evidence.length} synchronized, sanitized GitHub Actions evidence item(s) and no secondary runtime-log source.`,
      remediationSteps: failed ? ["Open the referenced GitHub Actions run and verify the failing command or configuration.", "Correct the project or provider configuration indicated by the sanitized evidence.", "Retry the deployment and confirm the failed stage passes before later stages run."] : ["No root cause can be established from the available evidence.", "Open the GitHub Actions run and review the first failed stage before retrying."],
      confidence: failed ? 0.65 : 0.25,
      limitations: "Fallback diagnostics were generated deterministically because a live AI result was unavailable or invalid.",
      evidenceReferences: evidence.slice(0, 8).map((item) => ({ source: item.source, eventId: item.eventId || null, stage: item.stage || null, lineReference: item.lineReference || null })),
      context,
    };
  }

  validate(value: unknown) {
    const item = value as Record<string, unknown>;
    if (!item || typeof item.summary !== "string" || typeof item.rootCause !== "string" || typeof item.technicalDetails !== "string" || !Array.isArray(item.remediationSteps) || typeof item.limitations !== "string" || !Array.isArray(item.evidenceReferences)) return null;
    const confidence = Math.max(0, Math.min(1, Number(item.confidence ?? 0.5)));
    return { summary: item.summary.slice(0, 2000), rootCause: item.rootCause.slice(0, 4000), technicalDetails: item.technicalDetails.slice(0, 8000), remediationSteps: item.remediationSteps.slice(0, 10).map(String), confidence, limitations: item.limitations.slice(0, 3000), evidenceReferences: item.evidenceReferences.slice(0, 20) as Array<Record<string, unknown>> };
  }

  private clean(value: string) { return String(value || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\r/g, ""); }
  private isNoise(text: string) { return /^(progress|heartbeat|still waiting|polling|downloaded|extracting)[ .:-]*$/i.test(text) || /^\s*\d+%\s*$/.test(text); }
  private signals(text: string) { const patterns = [[/error|failed|failure|exception/i, "error"], [/exit(?:ed)?\s+(?:code|status)\s*[:=]?\s*[1-9]/i, "abnormal_exit"], [/terraform|diagnostic|unsupported argument|undeclared/i, "terraform_diagnostic"], [/access denied|unauthorized|forbidden|permission/i, "permission_error"], [/at\s+\S+\s+\([^\n]+:\d+:\d+\)/i, "stack_trace"]] as const; return patterns.filter(([pattern]) => pattern.test(text)).map(([, label]) => label); }
}
