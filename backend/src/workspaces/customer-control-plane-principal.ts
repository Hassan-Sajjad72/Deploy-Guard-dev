import { ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
export function customerControlPlanePrincipal(config: ConfigService) {
  const existing = config.get<string>("DEPLOYGUARD_CONTROL_PLANE_ROLE_ARN", "").trim();
  const alias = config.get<string>("AWS_ONBOARDING_CONTROL_PLANE_ROLE_ARN", "").trim();
  const principal = existing || alias;
  if (existing && alias && existing !== alias || !/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(principal)) throw new ServiceUnavailableException("One consistent customer onboarding control-plane principal is required.");
  return principal;
}
