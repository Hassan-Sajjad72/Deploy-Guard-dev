import { Injectable } from "@nestjs/common";

@Injectable()
export class LogSanitizerService {
  sanitize(value: unknown) {
    if (value === undefined || value === null) {
      return "";
    }

    return this.mask(String(value));
  }

  sanitizeMetadata(metadata: Record<string, unknown> = {}) {
    const allowed = [
      "projectId",
      "pipelineRunId",
      "repositoryFullName",
      "targetBranch",
      "deploymentId",
      "stageName",
      "source",
      "status",
      "reason",
      "durationMs",
      "workflowRunId",
      "workflowName",
      "branch",
      "commitSha",
      "shortCommitSha",
      "imageTag",
      "ecrRepositoryName",
      "ecrImageUri",
      "terraformStatus",
      "diagnosticCode",
      "htmlUrl",
      "scanId",
      "totalVulnerabilities",
      "criticalCount",
      "highCount",
      "mediumCount",
      "lowCount",
      "unknownCount",
      "policyDecision",
      "remediationCount",
      "metricName",
      "metricUnit",
      "range",
      "stream",
      "limit",
      "sourceStatus",
      "logGroupName",
      "logStreamName",
    ];

    return Object.entries(metadata).reduce((safe, [key, value]) => {
      if (!allowed.includes(key) || value === undefined) {
        return safe;
      }

      safe[key] = typeof value === "string" ? this.mask(value) : value;
      return safe;
    }, {} as Record<string, unknown>);
  }

  private mask(input: string) {
    return input
      .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_ACCESS_KEY]")
      .replace(/aws_secret_access_key\s*=\s*[^\s]+/gi, "AWS_SECRET_ACCESS_KEY=[REDACTED]")
      .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]")
      .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "[REDACTED_JWT]")
      .replace(/(password|passwd|pwd)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]")
      .replace(/(api[_-]?key|token|secret|authorization|oauth[_-]?code)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]")
      .replace(/(["']?(?:api[_-]?key|token|secret|password|authorization|credential)["']?\s*:\s*["'])[^"']+(["'])/gi, "$1[REDACTED]$2")
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
      .replace(/([a-z]+:\/\/[^:\s]+):([^@\s]+)@/gi, "$1:[REDACTED]@");
  }
}
