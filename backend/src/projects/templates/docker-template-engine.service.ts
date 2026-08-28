import { Injectable } from "@nestjs/common";
import { readFileSync } from "fs";
import { join, posix } from "path";
import { DevOpsTemplateDefinition } from "./devops-templates";
import { BuildPlan, BuildPlanImageFamily } from "../build-plan";

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
    const runtimeCommand = this.runtimeCommand(contract, startCommand);
    const buildCommand = contract.buildCommand || "";
    const images = this.baseImages(contract);
    const appWithinInstallRoot = posix.relative(
      contract.repositoryInstallRoot === "." ? "" : contract.repositoryInstallRoot,
      contract.appRoot === "." ? "" : contract.appRoot,
    ) || ".";
    if (appWithinInstallRoot === ".." || appWithinInstallRoot.startsWith("../")) {
      throw new Error("Docker generation requires the application root to be contained by the repository install root.");
    }
    const values: Record<string, string> = {
      PACKAGE_MANAGER: contract.packageManager!,
      INSTALL_COMMAND: contract.installCommand!,
      PRUNE_COMMAND: this.pruneCommand(contract),
      BUILD_COMMAND: buildCommand,
      BUILD_STEP: this.buildStep(contract, buildCommand),
      START_COMMAND: runtimeCommand,
      START_COMMAND_JSON: JSON.stringify(["sh", "-c", runtimeCommand]),
      EXPECTED_PORT: String(contract.port),
      RUNTIME_VERSION: contract.runtimeVersion,
      BUILD_BASE_IMAGE: images.build,
      RUNTIME_BASE_IMAGE: images.runtime,
      FRAMEWORK: contract.framework!,
      FRAMEWORK_MODE: contract.frameworkMode!,
      APP_ROOT: contract.appRoot,
      APP_WORKDIR: appWithinInstallRoot === "." ? "/app" : `/app/${appWithinInstallRoot}`,
      APP_OUTPUT_DIRECTORY: appWithinInstallRoot === "."
        ? `/app/${contract.outputDirectory || ""}`
        : `/app/${appWithinInstallRoot}/${contract.outputDirectory || ""}`,
      COMMIT_SHA: contract.commitSha!,
      STATIC_OUTPUT: contract.runtimeType === "static" ? "true" : "false",
      OUTPUT_DIRECTORY: contract.outputDirectory || "",
      HEALTH_CHECK_PATH: contract.healthPath,
      REPOSITORY_INSTALL_ROOT: contract.repositoryInstallRoot,
      RUNTIME_FILES: contract.runtimeFiles.join(","),
      BUILD_SYSTEM_DEPENDENCIES: this.systemDependencyCommand(contract, "build"),
      RUNTIME_SYSTEM_DEPENDENCIES: this.systemDependencyCommand(contract, "runtime"),
    };

    const dockerfile = content.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => values[key] ?? "");
    this.validateGeneratedDockerfile(dockerfile);
    return dockerfile;
  }

  /**
   * A generated Django collectstatic command imports the Django settings module.
   * That is application initialization, not a browser/public build.  Its
   * runtime configuration therefore has to be supplied through BuildKit's
   * ephemeral secret mount instead of being reclassified as public build
   * configuration or persisted in an image layer.
   */
  private buildStep(contract: DeploymentContractDockerInput, buildCommand: string) {
    if (!buildCommand) return "";
    const initialization = this.buildInitialization(contract, buildCommand);
    if (initialization === "external_service_required") {
      throw new Error("The detected build command requires a live external service and must be deferred to the post-provision/release phase.");
    }
    if (initialization !== "runtime_placeholders") {
      const publicBuildKeys = contract.buildTimeEnvVars
        .filter((key) => /^(VITE_|NEXT_PUBLIC_|REACT_APP_)[A-Z0-9_]*$/.test(key))
        .filter((key) => !contract.secretEnvVars.includes(key));
      if (!publicBuildKeys.length) return `RUN ${buildCommand}`;
      const encodedCommand = Buffer.from(buildCommand, "utf8").toString("base64");
      const encodedKeys = Buffer.from(JSON.stringify(publicBuildKeys.sort()), "utf8").toString("base64");
      return [
        "RUN --mount=type=secret,id=deployguard_public_build_config,required=false \\",
        `    DEPLOYGUARD_BUILD_COMMAND_BASE64=${encodedCommand} \\
    DEPLOYGUARD_PUBLIC_BUILD_KEYS_BASE64=${encodedKeys} \\`,
        "    node -e 'const fs=require(\"fs\"),cp=require(\"child_process\");const path=\"/run/secrets/deployguard_public_build_config\";const allowed=new Set(JSON.parse(Buffer.from(process.env.DEPLOYGUARD_PUBLIC_BUILD_KEYS_BASE64,\"base64\").toString(\"utf8\")));const config=fs.existsSync(path)?JSON.parse(fs.readFileSync(path,\"utf8\")):{};if(Object.keys(config).some((key)=>!allowed.has(key)||typeof config[key]!==\"string\"))throw new Error(\"Invalid public build configuration.\");const command=Buffer.from(process.env.DEPLOYGUARD_BUILD_COMMAND_BASE64,\"base64\").toString(\"utf8\");const result=cp.spawnSync(command,{shell:true,stdio:\"inherit\",env:{...process.env,...config}});process.exit(result.status??1)'",
      ].join("\n");
    }
    const encodedCommand = Buffer.from(buildCommand, "utf8").toString("base64");
    return [
      "RUN --mount=type=secret,id=deployguard_runtime_config,required=true \\",
      `    DEPLOYGUARD_BUILD_COMMAND_BASE64=${encodedCommand} \\`,
      "    python -c 'import base64, json, os, subprocess; env = os.environ.copy(); env.update(json.load(open(\"/run/secrets/deployguard_runtime_config\", encoding=\"utf-8\"))); command = base64.b64decode(os.environ[\"DEPLOYGUARD_BUILD_COMMAND_BASE64\"]).decode(\"utf-8\"); subprocess.run(command, shell=True, check=True, env=env)'",
    ].join("\n");
  }

  private buildInitialization(contract: DeploymentContractDockerInput, buildCommand: string) {
    if (contract.buildInitialization?.mode) return contract.buildInitialization.mode;
    // A compatibility guard for existing immutable Django BuildPlans created
    // before buildInitialization was added. New plans carry the explicit mode.
    if (contract.dockerStrategy === "generated"
      && contract.language === "python"
      && contract.framework === "django") {
      if (/(?:^|\s)manage\.py\s+collectstatic(?:\s|$)/.test(buildCommand)) return "runtime_placeholders";
      if (/(?:^|\s)manage\.py\s+(?:migrate|makemigrations)(?:\s|$)/.test(buildCommand)) return "external_service_required";
    }
    return "none";
  }

  /**
   * Detector-owned release initialization runs only after runtime-managed
   * services and secrets exist. It remains part of the immutable generated
   * runtime command, executes as the final non-root user, and must succeed
   * before the long-running application process starts.
   */
  private runtimeCommand(contract: DeploymentContractDockerInput, startCommand: string) {
    const releaseCommand = contract.releaseCommand?.trim();
    if (!releaseCommand) return startCommand;
    if (contract.dockerStrategy !== "generated" || contract.runtimeType !== "server") {
      throw new Error("Release initialization is supported only for generated server runtimes.");
    }
    if (contract.framework !== "django" || releaseCommand !== "python manage.py migrate --noinput") {
      throw new Error("BuildPlan contains an unsupported generated-runtime release command.");
    }
    return `${releaseCommand} && exec ${startCommand}`;
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
    const family = this.imageFamily(phase === "build" ? contract.baseImage : contract.runtimeImage);
    if (!family) throw new Error(`Docker generation cannot determine the ${phase} image distribution.`);
    return family.packageManager === "apk"
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
    if (!contract.baseImage || !contract.runtimeImage) throw new Error("Docker generation requires pinned BuildPlan images.");
    this.validateImageFamily("build", contract.baseImage, contract.buildImageFamily);
    this.validateImageFamily("runtime", contract.runtimeImage, contract.runtimeImageFamily);
    if (contract.systemDependencyEvidence) {
      const unexplainedBuild = contract.buildSystemDependencies.filter((dependency) => !contract.systemDependencyEvidence!.build.includes(dependency));
      const unexplainedRuntime = contract.runtimeSystemDependencies.filter((dependency) => !contract.systemDependencyEvidence!.runtime.includes(dependency));
      if (unexplainedBuild.length || unexplainedRuntime.length) throw new Error("A component system dependency lacks component-owned detector evidence.");
    }
    const databaseNative = [...contract.buildSystemDependencies, ...contract.runtimeSystemDependencies]
      .filter((dependency) => /^(?:libpq|postgresql|default-libmysqlclient|libmariadb|mysql-client|mongodb)/i.test(dependency));
    const dependencyEvidence = new Set([...(contract.systemDependencyEvidence?.build || []), ...(contract.systemDependencyEvidence?.runtime || [])]);
    if (contract.runtimeType === "static" && databaseNative.some((dependency) => !dependencyEvidence.has(dependency))) {
      throw new Error("A static frontend cannot receive database-native system packages without direct component evidence.");
    }
    const managedDatabaseEnvironment = contract.environmentOwnership.filter((item) => item.source === "managed_database");
    if (managedDatabaseEnvironment.length && !contract.database?.required) {
      throw new Error("Managed database configuration can only reach the component that owns USES_DATABASE.");
    }
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

  validateGeneratedDockerfile(dockerfile: string) {
    const userDirectives = [...dockerfile.matchAll(/^\s*USER\s+([^\s#]+)/gim)];
    if (!userDirectives.length) throw new Error("Generated Dockerfile must declare a final non-root runtime user.");
    const finalUser = userDirectives[userDirectives.length - 1];
    if (/^(?:0|root)(?::|$)/i.test(finalUser[1])) throw new Error("Generated Dockerfile final runtime user must be non-root.");
    const finalUserIndex = finalUser.index || 0;
    const privilegedInstalls = [...dockerfile.matchAll(/^\s*RUN\s+(?:apk\s+add\b|apt-get\s+.*\binstall\b)/gim)];
    if (privilegedInstalls.some((match) => (match.index || 0) > finalUserIndex)) {
      throw new Error("Generated Dockerfile installs privileged system packages after the final non-root USER.");
    }
  }

  private validateImageFamily(phase: "build" | "runtime", image: string, declared?: BuildPlanImageFamily) {
    const actual = this.imageFamily(image);
    if (!actual) throw new Error(`Docker generation cannot determine the ${phase} image distribution.`);
    if (declared && (declared.distro !== actual.distro || declared.packageManager !== actual.packageManager)) {
      throw new Error(`${phase} image-family contract does not match the pinned image.`);
    }
  }

  private imageFamily(image: string): BuildPlanImageFamily | null {
    const normalized = image.toLowerCase();
    if (/(?:^|[-:.])alpine(?:\d|[-:.]|$)/.test(normalized)) return { distro: "alpine", packageManager: "apk" };
    if (/(?:^|[-:.])(?:slim|bookworm|bullseye|buster)(?:[-:.]|$)/.test(normalized)
      || /^(?:python|node):\d/.test(normalized)) return { distro: "debian", packageManager: "apt" };
    return null;
  }
}
