import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SecurityPolicyDecision, ProjectSecurityScan } from "../project-security-scan.entity";
import { NormalizedFinding } from "./trivy-parser.service";

/**
 * Image and application dependency CVEs are advisory in DeployGuard. The only
 * blocking release check is the Dockerfile/deployment configuration check run
 * before Docker build by DockerfileSecurityService.
 */
@Injectable()
export class SecurityPolicyService {
  constructor(private readonly configService: ConfigService) {}

  evaluate(findings: NormalizedFinding[]) {
    return {
      policyDecision: SecurityPolicyDecision.ALLOWED,
      policyReason: findings.length
        ? `${findings.length} image or application vulnerability finding(s) recorded as advisory.`
        : "No image vulnerability findings were reported.",
      manualApprovalRequired: false,
      blockingCount: 0,
      warningCount: findings.length,
    };
  }

  findingAction(_finding: NormalizedFinding): "blocking" | "warning" { return "warning"; }

  publicPolicy() {
    // Access through ConfigService keeps configuration DI explicit while CVE
    // enforcement remains intentionally disabled by product policy.
    const advisoryScannerEnabled =
      this.configService.get<string>("TRIVY_ENABLED", "true") !== "false";

    return {
      scope: "advisory_image_vulnerabilities",
      advisoryScannerEnabled,
      blockApplicationDependencies: false,
      blockBaseImageVulnerabilities: false,
      blockingCheck: "dockerfile_misconfiguration",
    };
  }

  canApprove(_scan: ProjectSecurityScan) { return false; }
}
