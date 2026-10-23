import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  SecurityPolicyDecision,
  ProjectSecurityScan,
} from "../project-security-scan.entity";
import { getSecurityPolicyConfig } from "./security-policy.config";

@Injectable()
export class SecurityPolicyService {
  constructor(private readonly config: ConfigService) {}

  evaluate(counts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    unknown: number;
  }) {
    const policy = getSecurityPolicyConfig(this.config);

    if (policy.blockCritical && counts.critical > 0) {
      return {
        policyDecision: SecurityPolicyDecision.BLOCKED,
        policyReason: "Critical vulnerabilities found.",
        manualApprovalRequired: false,
      };
    }

    if (policy.blockHigh && counts.high > 0) {
      return {
        policyDecision: SecurityPolicyDecision.BLOCKED,
        policyReason: "High severity vulnerabilities found.",
        manualApprovalRequired: false,
      };
    }

    if (
      policy.allowManualApprovalForMedium &&
      counts.medium > policy.mediumThresholdForApproval
    ) {
      return {
        policyDecision: SecurityPolicyDecision.REQUIRES_APPROVAL,
        policyReason: "Medium vulnerabilities exceed approval threshold.",
        manualApprovalRequired: true,
      };
    }

    if (policy.lowBlocking && counts.low > 0) {
      return {
        policyDecision: SecurityPolicyDecision.BLOCKED,
        policyReason: "Low severity vulnerabilities are blocked by policy.",
        manualApprovalRequired: false,
      };
    }

    return {
      policyDecision: SecurityPolicyDecision.ALLOWED,
      policyReason: "Scan passed policy.",
      manualApprovalRequired: false,
    };
  }

  canApprove(scan: ProjectSecurityScan) {
    const policy = getSecurityPolicyConfig(this.config);

    if (scan.policyDecision === SecurityPolicyDecision.REQUIRES_APPROVAL) {
      return policy.allowManualApprovalForMedium;
    }

    if (
      scan.policyDecision === SecurityPolicyDecision.BLOCKED &&
      (scan.criticalCount > 0 || scan.highCount > 0)
    ) {
      return policy.allowManualOverrideForHighCritical;
    }

    return false;
  }
}
