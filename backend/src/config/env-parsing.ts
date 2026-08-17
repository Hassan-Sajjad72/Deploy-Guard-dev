import { ConfigService } from "@nestjs/config";

export function envBoolean(config: ConfigService, key: string, fallback: boolean) {
  const value = config.get<string | boolean>(key);
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

export function externalCiRequired(config: ConfigService) {
  return envBoolean(config, "GITHUB_ACTIONS_REQUIRED", false) ||
    envBoolean(config, "EXTERNAL_CI_REQUIRED", false);
}
