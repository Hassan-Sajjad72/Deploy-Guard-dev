import { Controller, Get, Req, Res, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { AwsPrometheusExportService } from "./aws-prometheus-export.service";
import { getObservabilityConfig } from "./observability.config";

@Controller("api/monitoring")
export class PrometheusMetricsController {
  constructor(private readonly config: ConfigService, private readonly exporter: AwsPrometheusExportService) {}

  @Get("metrics")
  async metrics(@Req() request: Request, @Res() response: Response) {
    const expected = getObservabilityConfig(this.config).prometheusScrapeToken;
    if (!expected) throw new ServiceUnavailableException("Prometheus scrape authentication is not configured.");
    const presented = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const left = Buffer.from(presented);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new UnauthorizedException("Invalid Prometheus scrape credentials.");
    response.type("text/plain; version=0.0.4; charset=utf-8");
    response.send(await this.exporter.render());
  }
}
