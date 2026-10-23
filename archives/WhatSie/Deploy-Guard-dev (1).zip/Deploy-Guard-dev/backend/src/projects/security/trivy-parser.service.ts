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
        findings.push({
          vulnerabilityId: String(vulnerability.VulnerabilityID || "UNKNOWN"),
          severity: this.normalizeSeverity(vulnerability.Severity),
          packageName: this.stringOrNull(vulnerability.PkgName),
          installedVersion: this.stringOrNull(vulnerability.InstalledVersion),
          fixedVersion: this.stringOrNull(vulnerability.FixedVersion),
          target: this.stringOrNull(result.Target),
          type: this.stringOrNull(result.Type),
          title: this.stringOrNull(vulnerability.Title),
          description: this.stringOrNull(vulnerability.Description),
          primaryUrl: this.stringOrNull(vulnerability.PrimaryURL),
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
}
