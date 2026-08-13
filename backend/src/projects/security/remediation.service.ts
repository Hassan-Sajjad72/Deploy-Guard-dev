import { Injectable } from "@nestjs/common";
import { ProjectDetectionProfile } from "../project-detection-profile.entity";
import { NormalizedFinding } from "./trivy-parser.service";

@Injectable()
export class RemediationService {
  remediate(finding: NormalizedFinding, profile?: ProjectDetectionProfile | null) {
    if (this.isBaseImageFinding(finding)) {
      return finding.fixability === "fix_available"
        ? `Rebuild with the latest supported base image so ${finding.packageName || "the affected OS package"} can update to ${finding.fixedVersion}.`
        : "No fixed OS package version is currently reported. Rebuild periodically from the latest supported base image and monitor the upstream advisory.";
    }

    if (!finding.packageName) {
      return "Review the upstream advisory for remediation guidance.";
    }

    if (!finding.fixedVersion) {
      return "No fixed version is currently available. Monitor upstream advisory.";
    }

    const packageManager = profile?.packageManager || "";
    const ecosystem = profile?.ecosystem || "";

    if (ecosystem === "node" || ["npm", "yarn", "pnpm"].includes(packageManager)) {
      if (packageManager === "yarn") {
        return `yarn upgrade ${finding.packageName}@${finding.fixedVersion}`;
      }

      if (packageManager === "pnpm") {
        return `pnpm update ${finding.packageName}@${finding.fixedVersion}`;
      }

      return `npm update ${finding.packageName}@${finding.fixedVersion}`;
    }

    if (
      ecosystem === "python" ||
      ["pip", "poetry"].includes(packageManager) ||
      finding.type === "python-pkg"
    ) {
      if (packageManager === "poetry") {
        return `poetry add ${finding.packageName}@${finding.fixedVersion}`;
      }

      return `pip install ${finding.packageName}==${finding.fixedVersion}`;
    }

    return `Update ${finding.packageName} to ${finding.fixedVersion}.`;
  }

  private isBaseImageFinding(finding: NormalizedFinding) {
    return (
      finding.type === "os" ||
      finding.type === "alpine" ||
      finding.type === "debian" ||
      finding.type === "ubuntu" ||
      /debian|alpine|ubuntu|centos|redhat|oracle/i.test(finding.target || "")
    );
  }
}
