import { HttpException, HttpStatus, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { knownMonthlyPrice } from "../finops/pricing-amount";

@Injectable()
export class AiUsageService {
  constructor(private readonly database: DataSource, private readonly config: ConfigService) {}

  async reserve(organizationId: string | undefined, model: string, inputBytes: number, maxOutputTokens: number) {
    if (!organizationId || !/^[a-f0-9-]{36}$/i.test(organizationId)) throw new ServiceUnavailableException("Organization ownership is required for assisted AI requests.");
    const inputRate = knownMonthlyPrice(this.config.get<string>("AI_INPUT_USD_PER_MILLION_TOKENS"));
    const outputRate = knownMonthlyPrice(this.config.get<string>("AI_OUTPUT_USD_PER_MILLION_TOKENS"));
    const pricingSource = this.config.get<string>("AI_PRICING_SOURCE", "").trim();
    const pricingAsOf = this.config.get<string>("AI_PRICING_AS_OF", "");
    const pricingAge = Date.now() - Date.parse(pricingAsOf);
    if (inputRate === null || outputRate === null || this.config.get<string>("AI_PRICING_MODEL", "").replace(/^models\//, "") !== model
      || !/^https:\/\/\S{1,490}$/.test(pricingSource) || !Number.isFinite(pricingAge) || pricingAge < 0 || pricingAge > 30 * 24 * 60 * 60 * 1000)
      throw new ServiceUnavailableException("Current model-specific inference pricing must be configured before assisted AI requests.");
    if (!Number.isSafeInteger(inputBytes) || inputBytes < 0 || inputBytes > 200 * 1024 || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 2000)
      throw new ServiceUnavailableException("Assisted request exceeds the bounded inference input or output limit.");
    // shortcut: reserve one token per UTF-8 byte plus framing; use provider token counting if inputs become multimodal.
    const reserved = Math.ceil((inputBytes + 4096) * inputRate + maxOutputTokens * outputRate);
    const configuredRequests = Number(this.config.get<string>("AI_ORGANIZATION_DAILY_REQUEST_LIMIT", "100"));
    const requestLimit = Number.isInteger(configuredRequests) && configuredRequests > 0 && configuredRequests <= 100 ? configuredRequests : 100;
    const configuredBudget = knownMonthlyPrice(this.config.get<string>("AI_ORGANIZATION_DAILY_BUDGET_USD", "5"));
    const budget = Math.floor(Math.min(configuredBudget ?? 5, 5) * 1000000);
    if (!Number.isSafeInteger(reserved) || reserved > budget) throw new HttpException("The request exceeds the organization's daily AI budget.", HttpStatus.TOO_MANY_REQUESTS);
    return this.database.transaction(async (manager) => {
      const [{ day }] = await manager.query(`SELECT (now() AT TIME ZONE 'UTC')::date::text AS day`);
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ai-budget:${organizationId}:${day}`]);
      await manager.query(`INSERT INTO organization_ai_daily_usage(organization_id, usage_day) VALUES($1, $2) ON CONFLICT DO NOTHING`, [organizationId, day]);
      const [rows] = await manager.query(`UPDATE organization_ai_daily_usage SET request_count = request_count + 1, committed_usd_micros = committed_usd_micros + $3
        WHERE organization_id = $1 AND usage_day = $2 AND request_count < $4 AND committed_usd_micros + $3 <= $5 RETURNING request_count`, [organizationId, day, reserved, requestLimit, budget]);
      if (!rows.length) throw new HttpException("Organization daily AI request or spending limit reached. Continue with deterministic tools.", HttpStatus.TOO_MANY_REQUESTS);
      const id = randomUUID();
      await manager.query(`INSERT INTO organization_ai_requests(id, organization_id, usage_day, model, pricing_source, pricing_as_of, input_usd_per_million, output_usd_per_million, reserved_usd_micros) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [id, organizationId, day, model, pricingSource, pricingAsOf, inputRate, outputRate, reserved]);
      return id;
    });
  }

  async settle(id: string, usage: Record<string, unknown> | null) {
    const input = usage?.promptTokenCount;
    const total = usage?.totalTokenCount;
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(total) || Number(input) < 0 || Number(total) < Number(input) || Number(total) > 2147483647) return;
    await this.database.transaction(async (manager) => {
      const [request] = await manager.query(`SELECT * FROM organization_ai_requests WHERE id = $1`, [id]);
      if (!request) throw new ServiceUnavailableException("AI usage reservation is missing.");
      const day = typeof request.usage_day === "string" ? request.usage_day.slice(0, 10) : request.usage_day.toISOString().slice(0, 10);
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ai-budget:${request.organization_id}:${day}`]);
      const output = Number(total) - Number(input);
      const charged = Math.ceil(Number(input) * Number(request.input_usd_per_million) + output * Number(request.output_usd_per_million));
      if (!Number.isSafeInteger(charged)) throw new ServiceUnavailableException("AI usage cost cannot be reconciled safely.");
      const rows = await manager.query(`INSERT INTO organization_ai_settlements(request_id, input_tokens, output_tokens, charged_usd_micros) VALUES($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING request_id`, [id, input, output, charged]);
      if (rows.length) await manager.query(`UPDATE organization_ai_daily_usage SET committed_usd_micros = committed_usd_micros - $3 + $4 WHERE organization_id = $1 AND usage_day = $2`, [request.organization_id, day, request.reserved_usd_micros, charged]);
    });
  }
}
