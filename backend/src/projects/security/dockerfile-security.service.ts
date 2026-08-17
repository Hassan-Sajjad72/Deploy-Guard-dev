import { Injectable } from "@nestjs/common";

export type DockerfileCheckFinding = {
  code: string;
  severity: "warning" | "blocking";
  message: string;
  line: number | null;
};

@Injectable()
export class DockerfileSecurityService {
  analyze(content: string) {
    const lines = content.split(/\r?\n/);
    const findings: DockerfileCheckFinding[] = [];
    const add = (code: string, severity: "warning" | "blocking", message: string, line: number | null) => findings.push({ code, severity, message, line });

    lines.forEach((source, index) => {
      const line = source.trim();
      if (/^FROM\s+\S+(?::latest)?(?:\s|$)/i.test(line) && (!/:/.test(line.split(/\s+/)[1]) || /:latest(?:\s|$)/i.test(line))) add("unpinned_base_image", "blocking", "Use a versioned base image instead of an unpinned or latest tag.", index + 1);
      if (/^USER\s+(?:0|root)(?:\s|$)/i.test(line)) add("root_runtime_user", "blocking", "The final container stage must not run as root.", index + 1);
      if (/^(?:ARG|ENV)\s+[^=\s]*(?:TOKEN|PASSWORD|SECRET|PRIVATE_KEY|AWS_ACCESS_KEY)/i.test(line) && !/^(?:ARG|ENV)\s+(?:VITE_|NEXT_PUBLIC_|REACT_APP_)/i.test(line)) add("secret_in_dockerfile", "blocking", "Do not define credentials or secrets in Dockerfile ARG/ENV instructions.", index + 1);
      if (/^ADD\s+https?:\/\//i.test(line)) add("remote_add", "blocking", "Remote ADD sources are not permitted; fetch verified artifacts in a controlled build step.", index + 1);
      if (/^EXPOSE\s+/.test(line) && line.split(/\s+/).length > 2) add("multiple_exposed_ports", "warning", "Expose only the application port unless multiple listeners are required.", index + 1);
      if (/^COPY\s+\.\s+\./i.test(line)) add("broad_copy", "warning", "A broad COPY is safe only with the enforced .dockerignore build context.", index + 1);
    });

    const hasRuntimeUser = lines.some((line) => /^USER\s+/i.test(line.trim()));
    const usesUnprivilegedImage = lines.some((line) => /unprivileged|distroless|chainguard/i.test(line));
    if (!hasRuntimeUser && !usesUnprivilegedImage) add("runtime_user_unspecified", "warning", "Specify a non-root runtime USER where the base image does not enforce one.", null);

    return {
      passed: !findings.some((finding) => finding.severity === "blocking"),
      blockers: findings.filter((finding) => finding.severity === "blocking"),
      warnings: findings.filter((finding) => finding.severity === "warning"),
      findings,
    };
  }
}
