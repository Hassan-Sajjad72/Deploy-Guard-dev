import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

function flag(config: ConfigService, key: string) {
  const value = String(config.get<string>(key, "false")).trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new BadRequestException(`${key} must be true or false.`);
}

export function getTrivyConfig(config: ConfigService) {
  const enabled = flag(config, "TRIVY_ENABLED");
  return { enabled, enforce: enabled && flag(config, "TRIVY_ENFORCE") };
}
