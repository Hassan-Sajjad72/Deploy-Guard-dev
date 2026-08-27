import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import { AiProviderAdapter } from "../src/ai-troubleshooting/ai-provider.adapter";
import { AiEvidencePreprocessorService } from "../src/ai-troubleshooting/ai-evidence-preprocessor.service";
import { LogSanitizerService } from "../src/observability/log-sanitizer.service";
import { isAiTroubleshootingEligible } from "../src/ai-troubleshooting/ai-troubleshooting.service";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const service = new AiEvidencePreprocessorService(new LogSanitizerService());
const evidence = service.preprocess([{ source: "pipeline", stage: "build", eventId: "evt-1", text: "\u001b[31mERROR password=hunter2 github_token=fixture-token-value exit code 1\u001b[0m" }, { source: "pipeline", stage: "build", eventId: "evt-2", text: "ERROR password=hunter2 github_token=fixture-token-value exit code 1" }, { source: "pipeline", text: "progress" }], ["hunter2"]);
assert.equal(evidence.length, 1); assert(!evidence[0].text.includes("hunter2")); assert(!evidence[0].text.includes("fixture-token-value")); assert(evidence[0].signals.includes("error")); assert(evidence[0].signals.includes("abnormal_exit"));
const prompt = service.buildPrompt({ framework: "NestJS" }, evidence); assert(prompt.includes("strict JSON")); assert(prompt.includes("evt-1")); const fallback = service.fallback({}, evidence); assert.equal(fallback.evidenceReferences[0].eventId, "evt-1"); assert(service.validate(fallback)); assert.equal(service.validate({ summary: "invalid" }), null); console.log("AI troubleshooting verification passed");
const historicalBackendEvidence = service.preprocess([{ source: "infrastructure_event", stage: "terraform_plan", eventId: "historical-plan-event", text: "Backend initialization required: please run terraform init before planning." }]);
const historicalDiagnosis = service.fallback({ failedStage: "terraform_plan" }, historicalBackendEvidence);
assert.match(historicalDiagnosis.rootCause, /Backend initialization required/);
assert.equal(historicalDiagnosis.evidenceReferences[0].eventId, "historical-plan-event");
assert.equal(historicalDiagnosis.evidenceReferences[0].stage, "terraform_plan");
console.log("Historical Terraform backend evidence-bound fallback verification passed");
assert.equal(isAiTroubleshootingEligible({ status: "failed" as any, githubWorkflowRunId: "1", metadata: { safeLog: "sanitized Terraform error" } }), true);
assert.equal(isAiTroubleshootingEligible({ status: "failed" as any, githubWorkflowRunId: "1", metadata: { safeLog: "" } }), false, "a failed run without sanitized persisted evidence is not an AI target");
assert.equal(isAiTroubleshootingEligible({ status: "failed" as any, githubWorkflowRunId: null, metadata: { safeLog: "evidence" } }), false);
const evidenceSource = readFileSync(resolve(__dirname, "../src/ai-troubleshooting/ai-evidence.service.ts"), "utf8");
assert.doesNotMatch(evidenceSource, /ProjectEnvironmentVariable|ProjectDeploymentContract|ProjectStableRelease/, "selected-operation AI evidence cannot read current project-wide records");
console.log("Selected-operation AI eligibility and evidence-isolation checks passed");

const config = (values: Record<string, string>) => ({
  get: <T>(key: string, defaultValue?: T) => (values[key] ?? defaultValue) as T,
}) as ConfigService;

async function verifyGoogleProvider() {
  const missingKeyAdapter = new AiProviderAdapter(
    config({ AI_ASSISTANT_ENABLED: "true", AI_PROVIDER: "google" }),
    service
  );
  assert.equal(missingKeyAdapter.status().configured, false);
  assert.equal(
    missingKeyAdapter.status().message,
    "AI assistant is enabled but GOOGLE_AI_API_KEY is not configured."
  );
  let fallbackAfterProviderFailure;
  try { await missingKeyAdapter.analyze(prompt, { evidence }); }
  catch { fallbackAfterProviderFailure = service.fallback({ failedStage: "build" }, evidence); }
  assert.equal(fallbackAfterProviderFailure?.evidenceReferences[0].eventId, "evt-1", "provider failure must retain deterministic evidence-bound fallback");

  const testKey = "deployguard-test-google-key";
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestHeaders: HeadersInit | undefined;
  let requestBody = "";
  let fetchCount = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetchCount += 1;
    requestUrl = String(input);
    requestHeaders = init?.headers;
    requestBody = String(init?.body || "");
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(fallback) }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const adapter = new AiProviderAdapter(config({
      AI_ASSISTANT_ENABLED: "true",
      AI_PROVIDER: "google",
      GOOGLE_AI_API_KEY: testKey,
      GEMINI_MODEL: "gemini-3.1-flash-lite",
    }), service);
    assert.equal(fetchCount, 0, "provider construction must not perform external checks");
    adapter.status();
    assert.equal(fetchCount, 0, "configuration status must remain local and synchronous");
    const availability = await adapter.availability();
    assert.equal(availability.available, true);
    assert.equal(fetchCount, 1, "provider availability is checked lazily");
    await adapter.availability();
    assert.equal(fetchCount, 1, "provider availability uses a short-lived cache");
    const result = await adapter.analyze(prompt);
    assert.equal(result.provider, "google");
    assert.match(requestUrl, /models\/gemini-3\.1-flash-lite:generateContent$/);
    assert(!requestUrl.includes(testKey));
    assert.equal(new Headers(requestHeaders).get("x-goog-api-key"), testKey);
    assert(!requestBody.includes(testKey));
    assert.equal(JSON.parse(requestBody).generationConfig.responseMimeType, "application/json");
    assert(!JSON.stringify(adapter.status()).includes(testKey));

    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;
    const unavailable = await new AiProviderAdapter(config({
      AI_ASSISTANT_ENABLED: "true",
      GOOGLE_AI_API_KEY: testKey,
      AI_PROVIDER_STATUS_TIMEOUT_MS: "250",
    }), service).availability();
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.availability, "unavailable");
    assert.match(unavailable.message, /could not be confirmed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log("Google Gemini provider contract verification passed");
}

verifyGoogleProvider().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
