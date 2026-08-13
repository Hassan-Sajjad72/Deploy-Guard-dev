const ENFORCEMENT_KEYS = [
  "PLAN_USAGE_ENFORCEMENT_ENABLED",
  "USAGE_LIMITS_ENABLED",
  "SUBSCRIPTION_LIMITS_ENABLED",
  "BILLING_ENFORCEMENT_ENABLED",
] as const;

export type PlanUsageEnforcementConfig = {
  enabled: boolean;
  mode: "enforced" | "testing";
  reason: string;
};

export function getPlanUsageEnforcementConfig(
  env: NodeJS.ProcessEnv = process.env
): PlanUsageEnforcementConfig {
  const canonical = env[ENFORCEMENT_KEYS[0]]?.trim().toLowerCase();
  const aliases = ENFORCEMENT_KEYS.slice(1)
    .map((key) => env[key]?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
  const disabledValues = ["false", "0", "no", "off"];
  const disabled = canonical
    ? disabledValues.includes(canonical)
    : aliases.some((value) => disabledValues.includes(value));

  return disabled
    ? {
        enabled: false,
        mode: "testing",
        reason: "Plan/usage enforcement disabled for testing",
      }
    : {
        enabled: true,
        mode: "enforced",
        reason: "Plan/usage enforcement enabled",
      };
}
