import { ConfigService } from "@nestjs/config";

export function createRedisConnection(config: ConfigService) {
  return {
    host: config.get<string>("REDIS_HOST", "localhost"),
    port: Number(config.get<string>("REDIS_PORT", "6379")),
    password: config.get<string>("REDIS_PASSWORD") || undefined,
    tls: config.get<string>("REDIS_TLS", "false") === "true" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}
