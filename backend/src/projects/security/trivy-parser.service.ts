import { Injectable } from "@nestjs/common";

export type NormalizedFinding = {
  vulnerabilityId: string;
  severity: string;
  packageName: string | null;
  installedVersion: string | null;
  fixedVersion: string | null;
  target: string | null;
  type: string | null;
  title: string | null;
  description: string | null;
  primaryUrl: string | null;
  origin: "app_dependency" | "os_package" | "base_image" | "unknown";
  fixability: "fix_available" | "no_fix_available" | "unknown";
};

export type ParsedTrivyResult = {
  findings: NormalizedFinding[];
  counts: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    unknown: number;
  };
  summary: Record<string, unknown>;
};

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];

@Injectable()
export class TrivyParserService {
  parse(rawJson: string): ParsedTrivyResult {
    let parsed: { Results?: Array<Record<string, unknown>> };

    try {
      parsed = JSON.parse(rawJson || "{}");
    } catch {
      throw new Error("Invalid Trivy JSON output.");
    }

    const findings: NormalizedFinding[] = [];
    const results = Array.isArray(parsed.Results) ? parsed.Results : [];

    for (const result of results) {
      const vulnerabilities = Array.isArray(result.Vulnerabilities)
        ? result.Vulnerabilities
        : [];

      for (const vulnerability of vulnerabilities as Array<Record<string, unknown>>) {
        const target = this.stringOrNull(result.Target);
        const type = this.stringOrNull(result.Type);
        const fixedVersion = this.stringOrNull(vulnerability.FixedVersion);
        findings.push({
          vulnerabilityId: String(vulnerability.VulnerabilityID || "UNKNOWN"),
          severity: this.normalizeSeverity(vulnerability.Severity),
          packageName: this.stringOrNull(vulnerability.PkgName),
          installedVersion: this.stringOrNull(vulnerability.InstalledVersion),
          fixedVersion,
          target,
          type,
          title: this.stringOrNull(vulnerability.Title),
          description: this.stringOrNull(vulnerability.Description),
          primaryUrl: this.stringOrNull(vulnerability.PrimaryURL),
          origin: this.classifyOrigin(type, target),
          fixability: fixedVersion ? "fix_available" : "no_fix_available",
        });
      }
    }

    const counts = {
      total: findings.length,
      critical: findings.filter((finding) => finding.severity === "CRITICAL").length,
      high: findings.filter((finding) => finding.severity === "HIGH").length,
      medium: findings.filter((finding) => finding.severity === "MEDIUM").length,
      low: findings.filter((finding) => finding.severity === "LOW").length,
      unknown: findings.filter((finding) => finding.severity === "UNKNOWN").length,
    };

    return {
      findings,
      counts,
      summary: {
        artifactName: parsed["ArtifactName"] || null,
        artifactType: parsed["ArtifactType"] || null,
        resultsCount: results.length,
      },
    };
  }

  private normalizeSeverity(value: unknown) {
    const severity = String(value || "UNKNOWN").toUpperCase();
    return SEVERITIES.includes(severity) ? severity : "UNKNOWN";
  }

  private stringOrNull(value: unknown) {
    return value === undefined || value === null || value === ""
      ? null
      : String(value);
  }

  private classifyOrigin(
    type: string | null,
    target: string | null
  ): NormalizedFinding["origin"] {
    const normalizedType = String(type || "").toLowerCase();
    const normalizedTarget = String(target || "").toLowerCase();

    if (
      [
        "node-pkg",
        "python-pkg",
        "gobinary",
        "gomod",
        "jar",
        "pom",
        "bundler",
        "cargo",
        "composer",
        "nuget",
      ].includes(normalizedType) ||
      /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|poetry\.lock|pipfile\.lock|gemfile\.lock|go\.sum|pom\.xml|cargo\.lock)$/.test(
        normalizedTarget
      )
    ) {
      return "app_dependency";
    }

    if (
      [
        "alpine",
        "debian",
        "ubuntu",
        "redhat",
        "centos",
        "rocky",
        "amazon",
        "oracle",
        "suse",
      ].includes(normalizedType)
    ) {
      return "base_image";
    }

    if (normalizedType === "os") {
      return "os_package";
    }

    return "unknown";
  }
}
