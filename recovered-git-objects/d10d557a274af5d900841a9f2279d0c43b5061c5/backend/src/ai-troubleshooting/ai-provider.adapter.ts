import { BadGatewayException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiEvidencePreprocessorService } from "./ai-evidence-preprocessor.service";

@Injectable()
export class AiProviderAdapter {
  constructor(private readonly config: ConfigService, private readonly preprocessor: AiEvidencePreprocessorService) {}
  status() {
    const enabled = this.config.get<string>("AI_ASSISTANT_ENABLED", "false") === "true";
    const provider = "google";
    const apiKey = this.apiKey();
    return {
      configured: enabled && Boolean(apiKey),
      enabled,
      disabledByConfiguration: !enabled,
      mode: !enabled ? "disabled" : apiKey ? "live" : "not_configured",
      provider,
      model: this.config.get<string>("GEMINI_MODEL", "gemini-1.5-flash"),
      missingConfiguration: !enabled ? [] : apiKey ? [] : ["GOOGLE_AI_API_KEY"],
      message: !enabled
        ? "AI troubleshooting is disabled in this environment."
        : apiKey
          ? "AI assistant is configured."
          : "AI assistant is enabled but GOOGLE_AI_API_KEY is not configured.",
    };
  }
  async analyze(prompt: string, _fallback?: Record<string, unknown>) {
    const status = this.status();
    if (!status.configured) throw new ServiceUnavailableException(status.message);
    let lastRaw = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.request(
        attempt ? `${prompt}\n\nRepair your previous malformed response. Return JSON only.` : prompt,
        status.provider
      );
      lastRaw = response.content;
      const parsed = this.parse(lastRaw);
      const valid = this.preprocessor.validate(parsed);
      if (valid) return { value: valid, mode: "live", provider: status.provider, model: status.model, usage: response.usage };
    }
    throw new BadGatewayException(`AI provider returned an invalid response after retry (${lastRaw.length} characters).`);
  }
  private async request(prompt: string, provider: string) {
    if (provider !== "google") throw new ServiceUnavailableException("Only the Google Gemini AI provider is supported.");
    return this.requestGoogle(prompt);
  }
  private async requestGoogle(prompt: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(this.config.get<string>("AI_PROVIDER_TIMEOUT_MS", "30000")));
    try {
      const model = this.config.get<string>("GEMINI_MODEL", "gemini-1.5-flash").replace(/^models\//, "");
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey(),
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: Number(this.config.get<string>("AI_PROVIDER_TEMPERATURE", "0.3")),
              maxOutputTokens: Number(this.config.get<string>("AI_PROVIDER_MAX_OUTPUT_TOKENS", "1200")),
              responseMimeType: "application/json",
            },
          }),
        }
      );
      if (!response.ok) throw new Error(`Google Gemini provider returned ${response.status}.`);
      const payload = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: Record<string, unknown>;
      };
      const content = payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("") || "";
      return { content, usage: payload.usageMetadata || null };
    } finally { clearTimeout(timeout); }
  }
  private parse(value: string) { try { return JSON.parse(value.replace(/^```json\s*|\s*```$/g, "")); } catch { return null; } }
  private apiKey() {
    return this.config.get<string>("GOOGLE_AI_API_KEY", "").trim();
  }
}
