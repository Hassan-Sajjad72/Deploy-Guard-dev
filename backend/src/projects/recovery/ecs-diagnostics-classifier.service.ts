import { Injectable } from "@nestjs/common";
import { ProjectDeployment } from "../../orchestration/project-deployment.entity";
import { ProjectPipelineEvent } from "../project-pipeline-event.entity";
import type { ExternalProvider, FailureOwner } from "../failure-ownership";

export type EcsDeploymentDiagnostics = {
  summary?: string;
  stoppedTaskReason?: string;
  diagnosticCode?: string;
  containerExitCode?: number;
  containerPort?: number;
  targetPort?: number;
  logLines?: string[];
  taskEvents?: string[];
  stopCode?: string;
  containerReason?: string;
  targetHealth?: Array<{ state?: string; reason?: string; description?: string }>;
};

export type EcsDiagnosticsOwnership = { failureOwner: FailureOwner; externalProvider: ExternalProvider | null };

/** Parse only the bounded machine-readable line emitted by the canonical AWS verifier. */
export function ecsDiagnosticsFromEvidence(value: string): EcsDeploymentDiagnostics | null {
  const lines = value.split(/\r?\n/).filter((line) => line.includes("DG_ECS_DIAGNOSTICS "));
  const json = lines.at(-1)?.slice(lines.at(-1)!.indexOf("DG_ECS_DIAGNOSTICS ") + "DG_ECS_DIAGNOSTICS ".length).trim();
  if (!json || json.length > 8_000) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed as EcsDeploymentDiagnostics : null;
  } catch {
    return null;
  }
}

/** ECS instability is a symptom. Ownership is assigned only from collected evidence. */
export function classifyEcsDiagnosticsOwnership(diagnostics: EcsDeploymentDiagnostics | null): EcsDiagnosticsOwnership {
  if (!diagnostics) return { failureOwner: "UNVERIFIED", externalProvider: null };
  const text = [diagnostics.summary, diagnostics.stoppedTaskReason, diagnostics.containerReason, ...(diagnostics.logLines || [])].filter(Boolean).join(" ");
  if (typeof diagnostics.containerExitCode === "number" && diagnostics.containerExitCode !== 0) {
    return { failureOwner: "REPOSITORY_APPLICATION", externalProvider: null };
  }
  if (/CannotPullContainerError|image manifest|no basic auth credentials/i.test(text)) {
    return { failureOwner: "DEPLOYGUARD_PLATFORM", externalProvider: null };
  }
  if (/AccessDenied|not authorized to perform|unable to assume/i.test(text)) {
    return { failureOwner: "DEPLOYGUARD_PLATFORM", externalProvider: null };
  }
  if (/missing|required environment variable|bound to localhost|wrong port|health check/i.test(text)) {
    return { failureOwner: "REPOSITORY_APPLICATION", externalProvider: null };
  }
  return { failureOwner: "UNVERIFIED", externalProvider: null };
}

@Injectable()
export class EcsDiagnosticsClassifier {
  diagnostics(deployment: ProjectDeployment | null, events: ProjectPipelineEvent[] = []): EcsDeploymentDiagnostics | null {
    const metadata = deployment?.metadata as Record<string, any> | null;
    const deploymentDiagnostics = metadata?.ecsStability?.diagnostics || metadata?.ecsDiagnostics;
    if (deploymentDiagnostics) return deploymentDiagnostics;
    for (const event of [...events].reverse()) {
      const eventMetadata = event.metadata as Record<string, any> | null;
      const diagnostics = eventMetadata?.ecsDiagnostics || eventMetadata?.diagnostics;
      if (diagnostics) return diagnostics;
    }
    return null;
  }

  isLocalhostDatabaseFailure(value: string) {
    return /(?:ECONNREFUSED|connection refused)[^\n]{0,180}(?:127\.0\.0\.1|localhost|::1)(?::(?:5432|3306|27017))?|database at localhost|localhost is the application container/i.test(value);
  }

  runtimeCode(value: string) {
    if (/localhost-only|bound to localhost|listen(?:ing)?[^\n]*(?:127\.0\.0\.1|localhost)/i.test(value)) return "app_bound_to_localhost";
    if (/listening on port|port mismatch|expected port/i.test(value)) return "wrong_port_binding";
    if (/out of memory|oom(?:killed)?/i.test(value)) return "oom_killed";
    if (/insufficient (?:cpu|memory)|cpu[^\n]*memory[^\n]*insufficient/i.test(value)) return "cpu_memory_insufficient";
    if (/task definition[^\n]*invalid/i.test(value)) return "task_definition_invalid";
    if (/secret[^\n]*inject|resourceinitializationerror/i.test(value)) return "secrets_injection_failed";
    if (/runtime dependency|cannot find module|modulenotfounderror/i.test(value)) return "runtime_dependency_missing";
    if (/command[^\n]*failed/i.test(value)) return "command_failed";
    if (/exit(?:ed)?\s*(?:with\s*)?(?:code\s*[:=]?\s*)?1\b/i.test(value)) return "process_exited_code_1";
    return "container_crashed";
  }

  healthCode(value: string) {
    if (/404/.test(value)) return "health_check_path_missing";
    if (/timeout/i.test(value)) return "health_check_timeout";
    if (/no targets|zero registered targets/i.test(value)) return "no_targets_registered";
    if (/\b502\b/.test(value)) return "alb_502";
    if (/\b503\b/.test(value)) return "alb_503";
    if (/starts? but health|started[^\n]*health[^\n]*fail/i.test(value)) return "app_starts_but_health_fails";
    return "target_group_unhealthy";
  }
}
