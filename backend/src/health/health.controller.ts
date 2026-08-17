import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { HealthService } from "./health.service";

@Controller("api/health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  live() {
    return this.health.live();
  }

  @Get("ready")
  async ready() {
    const result = await this.health.ready();
    if (result.status !== "ready") {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
