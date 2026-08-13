import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SecurityPolicyDecision, ProjectSecurityScan } from "../project-security-scan.entity";
import { NormalizedFinding } from "./trivy-parser.service";
import { getSecurityPolicyConfig } from "./security-policy.config";

/**
 * Default policy is deliberately narrow: only fixable Critical application
 * dependencies block. High, base-image Critical, and non-fixable findings are
 * warnings unless an operator explicitly enables stricter policy.
 */
@Injectable()
export class SecurityPolicyService {
  constructor(private readonly configService: ConfigService) {}

  evaluate(findings: NormalizedFinding[]) {
    const policy = getSecurityPolicyConfig(this.configService);
    const blocking = findings.filter((finding) => this.findingAction(finding) === "blocking");
    const mediumCount = findings.filter((finding) => finding.severity === "MEDIUM").length;
    if (policy.gateMode === "bypass") {
      return {
        policyDecision: SecurityPolicyDecision.ALLOWED,
        policyReason: findings.length
          ? `Security findings are advisory in this mode. ${findings.length} finding(s) recorded.`
          : "Security gate bypassed by configuration.",
        manualApprovalRequired: false,
        blockingCount: 0,
        warningCount: findings.length,
      };
    }
    const approval = !blocking.length && policy.allowManualApprovalForMedium && mediumCount >= policy.mediumThresholdForApproval;
    return {
      policyDecision: blocking.length
        ? SecurityPolicyDecision.BLOCKED
        : approval
          ? SecurityPolicyDecision.REQUIRES_APPROVAL
          : SecurityPolicyDecision.ALLOWED,
      policyReason: blocking.length
        ? `${blocking.length} vulnerability finding(s) match the configured blocking policy.`
        : approval
          ? `${mediumCount} Medium findings require approval under the configured policy.`
          : findings.length
            ? `${findings.length} non-blocking vulnerability finding(s) recorded as advisory.`
            : "No image vulnerability findings were reported.",
      manualApprovalRequired: approval,
      blockingCount: blocking.length,
      warningCount: findings.length - blocking.length,
    };
  }

  findingAction(finding: NormalizedFinding): "blocking" | "warning" {
    const policy = getSecurityPolicyConfig(this.configService);
    if (policy.gateMode === "bypass") return "warning";
    const fixEligible = !policy.requireFixAvailableToBlock || finding.fixability === "fix_available";
    if (!fixEligible) return "warning";
    if (finding.severity === "CRITICAL") {
      if (finding.origin === "app_dependency" && policy.blockCritical) return "blocking";
      if (["base_image", "os_package"].includes(finding.origin) && policy.blockBaseImageCritical) return "blocking";
    }
    if (finding.severity === "HIGH" && policy.blockHigh) return "blocking";
    if (finding.severity === "LOW" && policy.lowBlocking) return "blocking";
    return "warning";
  }

  publicPolicy() {
    // Access through ConfigService keeps configuration DI explicit while CVE
    // enforcement remains intentionally disabled by product policy.
    const policy = getSecurityPolicyConfig(this.configService);

    return {
      scope: "classified_image_vulnerabilities",
      advisoryScannerEnabled: policy.scanEnabled,
      gateMode: policy.gateMode,
      blockApplicationDependencies: policy.blockCritical,
      blockBaseImageVulnerabilities: policy.blockBaseImageCritical,
      requireFixAvailableToBlock: policy.requireFixAvailableToBlock,
      blockingChecks: ["dockerfile_misconfiguration", "configured_vulnerability_policy"],
    };
  }

  canApprove(scan: ProjectSecurityScan) {
    const policy = getSecurityPolicyConfig(this.configService);
    return scan.policyDecision === SecurityPolicyDecision.REQUIRES_APPROVAL ||
      (scan.policyDecision === SecurityPolicyDecision.BLOCKED && policy.allowManualOverrideForHighCritical);
  }
}
