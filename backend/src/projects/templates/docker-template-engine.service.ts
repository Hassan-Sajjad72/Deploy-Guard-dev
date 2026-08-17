import { Injectable } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import { DevOpsTemplateDefinition } from "./devops-templates";
import { BuildPlan } from "../build-plan";

export type DeploymentContractDockerInput = BuildPlan;

@Injectable()
export class DockerTemplateEngineService {
  renderDockerfile(
    template: DevOpsTemplateDefinition,
    contract: DeploymentContractDockerInput
  ): string | null {
    if (!template.dockerfileTemplatePath) {
      return null;
    }

    this.validateContract(template, contract);
    const templatePath = join(process.cwd(), template.dockerfileTemplatePath);
    const content = readFileSync(templatePath, "utf8");
    const startCommand = contract.runCommand || "";
    const buildCommand = contract.buildCommand || "";
    const images = this.baseImages(contract);
    const values: Record<string, string> = {
      PACKAGE_MANAGER: contract.packageManager!,
      INSTALL_COMMAND: contract.installCommand!,
      PRUNE_COMMAND: this.pruneCommand(contract),
      BUILD_COMMAND: buildCommand,
      BUILD_STEP: buildCommand ? `RUN ${buildCommand}` : "",
      START_COMMAND: startCommand,
      START_COMMAND_JSON: JSON.stringify(["sh", "-c", startCommand]),
      EXPECTED_PORT: String(contract.port),
      RUNTIME_VERSION: contract.runtimeVersion,
      BUILD_BASE_IMAGE: images.build,
      RUNTIME_BASE_IMAGE: images.runtime,
      FRAMEWORK: contract.framework!,
      FRAMEWORK_MODE: contract.frameworkMode!,
      APP_ROOT: contract.appRoot,
      COMMIT_SHA: contract.commitSha!,
      STATIC_OUTPUT: contract.runtimeType === "static" ? "true" : "false",
      OUTPUT_DIRECTORY: contract.outputDirectory || "",
      BUILD_ENV_DECLARATIONS: this.buildEnvironmentDeclarations(contract),
      HEALTH_CHECK_PATH: contract.healthPath,
      REPOSITORY_INSTALL_ROOT: contract.repositoryInstallRoot,
      RUNTIME_FILES: contract.runtimeFiles.join(","),
      BUILD_SYSTEM_DEPENDENCIES: this.systemDependencyCommand(contract, "build"),
      RUNTIME_SYSTEM_DEPENDENCIES: this.systemDependencyCommand(contract, "runtime"),
    };

    return content.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => values[key] ?? "");
  }

  private buildEnvironmentDeclarations(contract: DeploymentContractDockerInput) {
    const secretKeys = new Set(contract.secretEnvVars);
    return contract.buildTimeEnvVars
      .filter((key) => /^(VITE_|NEXT_PUBLIC_|REACT_APP_)[A-Z0-9_]*$/.test(key))
      .filter((key) => !secretKeys.has(key))
      .map((key) => `ARG ${key}\nENV ${key}=\$${key}`)
      .join("\n");
  }

  private pruneCommand(contract: DeploymentContractDockerInput) {
    if (contract.language !== "javascript") {
      return "true";
    }

    if (contract.packageManager === "pnpm") {
      return "pnpm prune --prod";
    }

    if (contract.packageManager === "yarn") {
      return "yarn install --production --frozen-lockfile --ignore-scripts";
    }

    return "npm prune --omit=dev";
  }

  private systemDependencyCommand(contract: DeploymentContractDockerInput, phase: "build" | "runtime") {
    const dependencies = phase === "build" ? contract.buildSystemDependencies : contract.runtimeSystemDependencies;
    if (!dependencies.length) return "";
    if (dependencies.some((name) => !/^[a-z0-9][a-z0-9+.-]*$/i.test(name))) throw new Error("BuildPlan contains an invalid system dependency name.");
    return contract.language === "javascript"
      ? `RUN apk add --no-cache ${dependencies.join(" ")}`
      : `RUN apt-get update && apt-get install -y --no-install-recommends ${dependencies.join(" ")} && rm -rf /var/lib/apt/lists/*`;
  }

  private validateContract(template: DevOpsTemplateDefinition, contract: DeploymentContractDockerInput) {
    if (!contract.framework || !contract.frameworkMode || contract.frameworkMode !== template.frameworkVariant) throw new Error("Docker template does not match the BuildPlan framework mode.");
    if (!contract.commitSha || !/^[a-f0-9]{40}$/i.test(contract.commitSha)) throw new Error("Docker generation requires an exact 40-character commit SHA.");
    if (!contract.appRoot || !/^(?:\.|[A-Za-z0-9._/-]+)$/.test(contract.appRoot) || contract.appRoot.startsWith("/") || contract.appRoot.split("/").includes("..")) throw new Error("Docker generation requires a safe repository-relative application root.");
    if (!contract.repositoryInstallRoot || !/^(?:\.|[A-Za-z0-9._/-]+)$/.test(contract.repositoryInstallRoot) || contract.repositoryInstallRoot.startsWith("/") || contract.repositoryInstallRoot.split("/").includes("..")) throw new Error("Docker generation requires a safe repository-relative install root.");
    if (contract.runtimeFiles.some((file) => !/^(?:\.|[A-Za-z0-9._/-]+)$/.test(file) || file.startsWith("/") || file.split("/").includes(".."))) throw new Error("Docker generation received an unsafe runtime file path.");
    const staticWeb = contract.framework === "static-web" && contract.frameworkMode === "static-web";
    if ((!contract.packageManager || !contract.installCommand) && !staticWeb) throw new Error("Docker generation requires BuildPlan package-manager and install-command evidence.");
    if (!contract.lockfile && /\bnpm\s+ci\b/.test(contract.installCommand)) throw new Error("npm ci is forbidden when the BuildPlan has no npm lockfile.");
    if (!template.supportedPackageManagers.includes(contract.packageManager)) throw new Error("Detected package manager is not supported by the selected Docker template.");
    if (!contract.port || contract.port < 1 || contract.port > 65535) throw new Error("Docker generation requires a validated runtime port.");
    if (!contract.healthPath?.startsWith("/")) throw new Error("Docker generation requires a validated health-check path.");
    if (template.requiredCommands.includes("build") && !contract.buildCommand) throw new Error("Docker generation requires the detected production build command.");
    if (contract.runtimeType === "server" && !contract.runCommand) throw new Error("Docker generation requires the BuildPlan production run command.");
    if (contract.runtimeType === "static" && !contract.outputDirectory && !staticWeb) throw new Error("Docker generation requires the detected static output directory.");
    const forbiddenBuildSecrets = contract.buildTimeEnvVars.filter((key) => contract.secretEnvVars.includes(key));
    if (forbiddenBuildSecrets.length) throw new Error(`Secret variables cannot be used during image build: ${forbiddenBuildSecrets.join(", ")}.`);
    const unsupportedBuildVariables = contract.buildTimeEnvVars.filter((key) => !/^(VITE_|NEXT_PUBLIC_|REACT_APP_)[A-Z0-9_]*$/.test(key));
    if (unsupportedBuildVariables.length) throw new Error(`Build-time variables are not proven public: ${unsupportedBuildVariables.join(", ")}.`);
  }

  private baseImages(contract: DeploymentContractDockerInput) {
    if (!contract.baseImage || !contract.runtimeImage) throw new Error("Docker generation requires pinned BuildPlan images.");
    return { build: contract.baseImage, runtime: contract.runtimeImage };
  }
}
