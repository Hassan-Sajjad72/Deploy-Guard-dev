import { Injectable } from "@nestjs/common";
import { ProjectDeploymentContract } from "../project-deployment-contract.entity";
import { ProjectPreflightReport } from "../project-preflight-report.entity";

export type PreflightRecoverySignal = {
  code: string;
  kind: "source" | "environment";
  message: string;
  missingKeys: string[];
};

@Injectable()
export class PreflightIssueMapper {
  map(contract: ProjectDeploymentContract | null, preflight: ProjectPreflightReport | null): PreflightRecoverySignal[] {
    const blockers = [...(contract?.blockers || []), ...(preflight?.errors || [])].filter(Boolean);
    const text = blockers.join(" ");
    const signals: PreflightRecoverySignal[] = [];
    if (/unsupported repository structure|repository structure[^.]*unsupported|no supported (?:web )?application/i.test(text)) {
      signals.push(this.signal("unsupported_repo_structure", "source", blockers[0]));
    } else if (/unsupported language|unsupported framework|manifest|start command|build command|app (?:root|directory)|monorepo|ambiguous/i.test(text)) {
      const code = /monorepo/i.test(text)
        ? "monorepo_app_path_required"
        : /ambiguous/i.test(text)
          ? "ambiguous_app_directory"
          : /app (?:root|directory)[^.]*wrong/i.test(text)
            ? "app_directory_wrong"
            : /manifest/i.test(text)
              ? "missing_package_manifest"
              : /start command/i.test(text)
                ? "missing_start_command"
                : /build command/i.test(text)
                  ? "missing_build_command"
                  : /unsupported language/i.test(text)
                    ? "unsupported_language"
                    : "unsupported_framework";
      signals.push(this.signal(code, "source", blockers[0]));
    }

    if (contract?.missingEnvVars?.length || /missing|required[^.]*environment|environment variable|invalid env|secret required|build secret/i.test(text)) {
      const buildTime = contract?.missingEnvVars?.some((key) => contract.buildTimeEnvVars?.includes(key));
      const code = /build secret/i.test(text)
        ? "build_secret_not_supported"
        : /invalid env/i.test(text)
          ? "invalid_env_value"
          : /secret required/i.test(text)
            ? "secret_required"
            : buildTime
              ? "missing_build_time_env_vars"
              : "missing_runtime_env_vars";
      signals.push(this.signal(code, "environment", blockers[0], contract?.missingEnvVars || []));
    }
    return signals;
  }

  private signal(code: string, kind: PreflightRecoverySignal["kind"], message = "Deployment pre-flight found a blocking requirement.", missingKeys: string[] = []): PreflightRecoverySignal {
    return { code, kind, message, missingKeys };
  }
}
