import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { aliasesFor, serviceAlias } from "../projects/configuration-ownership";
import type { ConfigurationOwner, ManagedServiceKind } from "../projects/configuration-ownership";
import { ProjectDeploymentContract } from "../projects/project-deployment-contract.entity";
import type { EffectiveDeploymentConfiguration } from "./database-service-binding.service";

export const DEPLOYMENT_CONTRACT_SCHEMA_VERSION = 1;

export type RuntimeConfigurationDestination =
  | "ecs_environment"
  | "ecs_secret"
  | "build_argument"
  | "omitted";

export type ResolvedRuntimeConfigurationEntry = {
  key: string;
  owner: ConfigurationOwner;
  source: string;
  sensitivity: "secret" | "non_secret";
  destination: RuntimeConfigurationDestination;
  required: boolean;
  bindingId: string | null;
  bindingRevision: string | null;
  secretReferenceKind: "managed_binding" | "project_secret" | null;
  evidence: string | null;
};

export type CanonicalDeploymentContract = {
  schemaVersion: number;
  projectId: string;
  environment: string;
  deploymentContractRevision: string;
  contractFingerprint: string;
  bindingId: string | null;
  bindingRevision: string | null;
  runtimeEntries: ResolvedRuntimeConfigurationEntry[];
  port: number | null;
  healthPath: string;
  imageDigest: string | null;
};

export type EcsTaskDefinitionDraft = {
  contractFingerprint: string;
  terraformInputFingerprint: string | null;
  draftFingerprint: string;
  environmentNames: string[];
  secretNames: string[];
  managedSecretTypes: Record<string, "password" | "url">;
};

export type TerraformPlanPolicyResult = {
  mode: "known" | "unknown_canonical_equivalence";
  auditAction: "PLAN_TASK_DEFINITION_UNKNOWN_CANONICAL_EQUIVALENCE_USED" | null;
  contractFingerprint: string;
  terraformInputFingerprint: string;
  taskDefinitionDraftFingerprint: string;
};

export type DeploymentContractViolation = {
  code: string;
  message: string;
  key?: string;
};

@Injectable()
export class DeploymentContractValidationService {
  buildCanonicalContract(
    projectId: string,
    environment: string,
    contract: ProjectDeploymentContract,
    effective: EffectiveDeploymentConfiguration,
    imageDigest: string | null = null,
  ): CanonicalDeploymentContract {
    const keys = new Set([
      ...Object.keys(effective.ownership),
      ...Object.keys(effective.runtimeVariables),
      ...Object.keys(effective.buildArguments),
      ...Object.keys(effective.projectSecretValues),
      ...Object.keys(effective.secretReferences),
    ]);
    const runtimeEntries = [...keys].sort().map((key): ResolvedRuntimeConfigurationEntry => {
      const ownership = effective.ownership[key];
      const isSecret = Boolean(ownership?.secret);
      const destination: RuntimeConfigurationDestination =
        effective.secretReferences[key] !== undefined || effective.projectSecretValues[key] !== undefined
          ? "ecs_secret"
          : effective.runtimeVariables[key] !== undefined
            ? "ecs_environment"
            : effective.buildArguments[key] !== undefined
              ? "build_argument"
              : "omitted";
      return {
        key,
        owner: ownership?.owner || "user_optional",
        source: ownership?.source || "unresolved",
        sensitivity: isSecret ? "secret" : "non_secret",
        destination,
        required: Boolean(ownership?.required),
        bindingId: ownership?.serviceBindingId || null,
        bindingRevision: ownership?.serviceBindingId
          ? effective.binding?.configurationFingerprint || ownership.sourceRevision
          : null,
        secretReferenceKind: destination !== "ecs_secret"
          ? null
          : ownership?.owner === "managed_service"
            ? "managed_binding"
            : "project_secret",
        evidence: ownership?.detectedReference || null,
      };
    });
    const semantic = {
      schemaVersion: DEPLOYMENT_CONTRACT_SCHEMA_VERSION,
      projectId,
      environment,
      deploymentContractRevision: contract.contractHash,
      effectiveConfigurationFingerprint: effective.configurationFingerprint,
      bindingId: effective.binding?.id || null,
      bindingRevision: effective.binding?.configurationFingerprint || null,
      runtimeEntries,
      port: contract.ecsPlan.containerPort,
      healthPath: contract.ecsPlan.healthCheckPath,
      imageDigest,
    };
    return {
      ...semantic,
      contractFingerprint: this.fingerprint(semantic),
    };
  }

  validateSemantic(
    projectId: string,
    contract: ProjectDeploymentContract,
    effective: EffectiveDeploymentConfiguration,
    canonical: CanonicalDeploymentContract,
  ) {
    const violations: DeploymentContractViolation[] = effective.blockers.map((message) => ({
      code: "unresolved_configuration",
      message,
    }));
    if (canonical.schemaVersion !== DEPLOYMENT_CONTRACT_SCHEMA_VERSION) {
      violations.push({ code: "schema_incompatible", message: "Deployment contract schema version is incompatible." });
    }
    if (effective.binding && effective.binding.projectId !== projectId) {
      violations.push({ code: "binding_scope_mismatch", message: "The managed service binding belongs to another project." });
    }
    if (effective.binding?.provider === "managed" && /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(effective.binding.hostReference)) {
      violations.push({ code: "managed_database_localhost", message: "A managed production database cannot resolve to localhost." });
    }

    const service = (effective.binding?.engine || contract.databaseEngine || "postgres") as ManagedServiceKind;
    if (effective.binding?.provider === "managed") {
      this.validateManagedSecret("DB_PASSWORD", "password", contract, effective, canonical, violations, true, service);
      for (const key of aliasesFor(service, "url")) {
        const evidenced = this.repositoryRequires(contract, key, service, "url");
        const present = canonical.runtimeEntries.some((entry) => entry.key === key && entry.destination !== "omitted");
        if (!evidenced && present) {
          violations.push({
            code: "database_url_without_evidence",
            key,
            message: `${key} is omitted because repository evidence does not show that the application consumes it.`,
          });
        }
        if (evidenced) this.validateManagedSecret(key, "url", contract, effective, canonical, violations, true, service);
      }
    }

    for (const entry of canonical.runtimeEntries) {
      if (entry.sensitivity === "secret" && entry.destination === "ecs_environment") {
        violations.push({ code: "secret_in_plain_environment", key: entry.key, message: `${entry.key} is secret and cannot be rendered in ECS environment.` });
      }
      if (entry.sensitivity === "non_secret" && entry.destination === "ecs_secret") {
        violations.push({ code: "non_secret_in_secret_destination", key: entry.key, message: `${entry.key} is non-secret and cannot be rendered as an ECS secret.` });
      }
      if (entry.owner === "managed_service") {
        if (!effective.binding || entry.bindingId !== effective.binding.id || entry.bindingRevision !== effective.binding.configurationFingerprint) {
          violations.push({ code: "binding_revision_mismatch", key: entry.key, message: `${entry.key} does not reference the current managed binding revision.` });
        }
      }
    }
    return this.unique(violations);
  }

  assertSemantic(
    projectId: string,
    contract: ProjectDeploymentContract,
    effective: EffectiveDeploymentConfiguration,
    canonical: CanonicalDeploymentContract,
  ) {
    const violations = this.validateSemantic(projectId, contract, effective, canonical);
    if (violations.length) {
      throw new BadRequestException({
        code: "contract_invalid",
        message: `Deployment contract is invalid before infrastructure planning. ${violations[0].message}`,
        violations,
      });
    }
  }

  taskDefinitionDraft(
    terraformVariables: Record<string, unknown>,
    contractFingerprint: string,
    terraformInputFingerprint: string | null = null,
  ): EcsTaskDefinitionDraft {
    const environment = this.record(terraformVariables.ecs_environment_variables);
    const projectSecrets = this.record(terraformVariables.ecs_secret_environment_variables);
    const managedSecretTypes = this.record(terraformVariables.database_secret_alias_types) as Record<string, "password" | "url">;
    const semantic = {
      contractFingerprint,
      terraformInputFingerprint,
      environmentNames: Object.keys(environment).sort(),
      secretNames: [...new Set([...Object.keys(projectSecrets), ...Object.keys(managedSecretTypes)])].sort(),
      managedSecretTypes,
    };
    return {
      ...semantic,
      draftFingerprint: this.fingerprint(semantic),
    };
  }

  assertRenderedDraft(canonical: CanonicalDeploymentContract, draft: EcsTaskDefinitionDraft) {
    const violations = this.validateRenderedNames(canonical, draft.environmentNames, draft.secretNames);
    if (draft.contractFingerprint !== canonical.contractFingerprint) {
      violations.push({ code: "task_contract_mismatch", message: "The ECS task-definition draft references a different deployment contract." });
    }
    for (const entry of canonical.runtimeEntries.filter((item) => item.owner === "managed_service" && item.destination === "ecs_secret")) {
      const expectedType = serviceAlias(entry.key)?.property === "url" ? "url" : "password";
      if (draft.managedSecretTypes[entry.key] !== expectedType) {
        violations.push({ code: "managed_secret_reference_missing", key: entry.key, message: `${entry.key} does not use the managed binding secret reference.` });
      }
    }
    if (violations.length) {
      throw new BadRequestException({
        code: "contract_invalid",
        message: `Rendered ECS task definition violates the deployment contract. ${violations[0].message}`,
        violations: this.unique(violations),
      });
    }
  }

  assertTerraformPlanPolicy(
    terraformShowJson: string,
    canonical: CanonicalDeploymentContract,
    draft: EcsTaskDefinitionDraft,
    expectedTerraformInputFingerprint: string,
  ): TerraformPlanPolicyResult {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(terraformShowJson) as Record<string, unknown>;
    } catch {
      this.planPolicyFailure("Terraform plan policy validation could not parse the plan.");
    }
    const resources = this.resources(this.record(this.record(parsed.planned_values).root_module));
    const task = resources.find((resource) => resource.type === "aws_ecs_task_definition" && resource.name === "app");
    if (!task) {
      this.planPolicyFailure("Terraform plan does not contain the expected application task definition.");
    }
    const values = this.record(task.values);
    const hasContainerDefinitions = Object.prototype.hasOwnProperty.call(values, "container_definitions");
    const rawContainerDefinitions = values.container_definitions;
    const change = this.array(parsed.resource_changes)
      .map((item) => this.record(item))
      .find((resource) => resource.type === "aws_ecs_task_definition" && resource.name === "app");
    const afterUnknown = this.record(this.record(change?.change).after_unknown);
    const explicitlyUnknown = afterUnknown.container_definitions === true;

    if (explicitlyUnknown && (!hasContainerDefinitions || rawContainerDefinitions === null)) {
      if (
        !draft.terraformInputFingerprint
        || draft.terraformInputFingerprint !== expectedTerraformInputFingerprint
        || draft.contractFingerprint !== canonical.contractFingerprint
        || draft.draftFingerprint !== this.taskDefinitionDraftFingerprint(draft)
      ) {
        this.planPolicyFailure("Terraform task-definition value is unknown and canonical input equivalence cannot be proven.");
      }
      this.assertRenderedDraft(canonical, draft);
      return {
        mode: "unknown_canonical_equivalence",
        auditAction: "PLAN_TASK_DEFINITION_UNKNOWN_CANONICAL_EQUIVALENCE_USED",
        contractFingerprint: canonical.contractFingerprint,
        terraformInputFingerprint: expectedTerraformInputFingerprint,
        taskDefinitionDraftFingerprint: draft.draftFingerprint,
      };
    }
    if (!hasContainerDefinitions || rawContainerDefinitions === null) {
      this.planPolicyFailure("Terraform plan task-definition value is absent.");
    }
    if (typeof rawContainerDefinitions !== "string") {
      this.planPolicyFailure("Terraform plan task-definition value has an unsupported type.");
    }

    const containers = this.parseKnownContainers(rawContainerDefinitions);
    const app = containers.find((item) => item.name === "app") || containers[0];
    const environmentNames = this.array(app?.environment).map((item) => String(this.record(item).name || "")).filter(Boolean);
    const secretNames = this.array(app?.secrets).map((item) => String(this.record(item).name || "")).filter(Boolean);
    const violations = this.validateRenderedNames(canonical, environmentNames, secretNames);
    if (violations.length) {
      throw new BadRequestException({
        code: "plan_policy_failed",
        message: `Terraform plan task-definition policy failed. ${violations[0].message}`,
        violations: this.unique(violations),
      });
    }
    return {
      mode: "known",
      auditAction: null,
      contractFingerprint: canonical.contractFingerprint,
      terraformInputFingerprint: expectedTerraformInputFingerprint,
      taskDefinitionDraftFingerprint: draft.draftFingerprint,
    };
  }

  taskDefinitionDraftFingerprint(draft: EcsTaskDefinitionDraft) {
    return this.fingerprint({
      contractFingerprint: draft.contractFingerprint,
      terraformInputFingerprint: draft.terraformInputFingerprint,
      environmentNames: draft.environmentNames,
      secretNames: draft.secretNames,
      managedSecretTypes: draft.managedSecretTypes,
    });
  }

  terraformInputFingerprint(
    terraformVariables: Record<string, unknown>,
    canonical: CanonicalDeploymentContract,
  ) {
    const sanitized = {
      ...terraformVariables,
      ecs_secret_environment_variables: Object.keys(this.record(terraformVariables.ecs_secret_environment_variables)).sort(),
      spot_event_api_destination_secret: terraformVariables.spot_event_api_destination_secret ? "configured" : "absent",
    };
    return this.fingerprint({
      contractFingerprint: canonical.contractFingerprint,
      bindingId: canonical.bindingId,
      bindingRevision: canonical.bindingRevision,
      inputs: sanitized,
    });
  }

  planFingerprint(
    artifactSha256: string,
    terraformInputFingerprint: string,
    contractFingerprint: string,
    runId: string,
  ) {
    return this.fingerprint({ artifactSha256, terraformInputFingerprint, contractFingerprint, runId });
  }

  private validateManagedSecret(
    key: string,
    property: "password" | "url",
    contract: ProjectDeploymentContract,
    effective: EffectiveDeploymentConfiguration,
    canonical: CanonicalDeploymentContract,
    violations: DeploymentContractViolation[],
    required: boolean,
    service: ManagedServiceKind,
  ) {
    if (!required || (property === "url" && !this.repositoryRequires(contract, key, service, property))) return;
    const entry = canonical.runtimeEntries.find((item) => item.key === key);
    if (!entry || entry.owner !== "managed_service" || entry.sensitivity !== "secret" || entry.destination !== "ecs_secret") {
      violations.push({ code: "managed_secret_destination_invalid", key, message: `${key} must be a managed ECS secret.` });
      return;
    }
    const reference = effective.secretReferences[key];
    if (!reference || !/^(?:terraform:\/\/database\/(?:password|url)|arn:[^:]+:secretsmanager:[^:]+:[^:]+:secret:)/.test(reference)) {
      violations.push({ code: "managed_secret_reference_invalid", key, message: `${key} does not have a valid managed binding secret reference.` });
    }
    if (effective.runtimeVariables[key] !== undefined || effective.projectSecretValues[key] !== undefined) {
      violations.push({ code: "managed_secret_plaintext", key, message: `${key} must not exist in plaintext runtime configuration.` });
    }
  }

  private repositoryRequires(
    contract: ProjectDeploymentContract,
    key: string,
    service: ManagedServiceKind,
    property: "url",
  ) {
    const evidence = new Set([...contract.requiredEnvVars, ...contract.optionalEnvVars, ...contract.runtimeEnvVars]);
    const aliases = aliasesFor(service, property);
    return evidence.has(key) && aliases.includes(key);
  }

  private validateRenderedNames(
    canonical: CanonicalDeploymentContract,
    environmentNames: string[],
    secretNames: string[],
  ) {
    const environment = new Set(environmentNames);
    const secrets = new Set(secretNames);
    const violations: DeploymentContractViolation[] = [];
    for (const key of environment) {
      if (secrets.has(key)) violations.push({ code: "duplicate_runtime_destination", key, message: `${key} is present in both ECS environment and secrets.` });
    }
    for (const entry of canonical.runtimeEntries) {
      if (entry.destination === "ecs_secret" && environment.has(entry.key)) {
        violations.push({ code: "secret_in_plain_environment", key: entry.key, message: `${entry.key} is rendered as plaintext ECS environment.` });
      }
      if (entry.destination === "ecs_secret" && !secrets.has(entry.key)) {
        violations.push({ code: "required_secret_missing", key: entry.key, message: `${entry.key} is missing from ECS secrets.` });
      }
      if (entry.destination === "ecs_environment" && secrets.has(entry.key)) {
        violations.push({ code: "non_secret_in_secret_destination", key: entry.key, message: `${entry.key} is incorrectly rendered as an ECS secret.` });
      }
    }
    return violations;
  }

  private resources(module: Record<string, unknown>): Array<Record<string, unknown>> {
    return [
      ...this.array(module.resources).map((item) => this.record(item)),
      ...this.array(module.child_modules).flatMap((item) => this.resources(this.record(item))),
    ];
  }

  private parseKnownContainers(value: string): Array<Record<string, unknown>> {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed) || !parsed.length || parsed.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
        this.planPolicyFailure("Terraform plan task-definition value is malformed.");
      }
      return parsed.map((item) => this.record(item));
    } catch {
      this.planPolicyFailure("Terraform plan task-definition value is malformed.");
    }
  }

  private planPolicyFailure(message: string): never {
    throw new BadRequestException({ code: "plan_policy_failed", message });
  }

  private fingerprint(value: unknown) {
    return createHash("sha256").update(JSON.stringify(this.stable(value))).digest("hex");
  }

  private stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.stable(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, this.stable(item)]));
    }
    return value;
  }

  private record(value: unknown): Record<string, any> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
  }

  private array(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
  }

  private unique(violations: DeploymentContractViolation[]) {
    return violations.filter((item, index, all) => all.findIndex((candidate) => candidate.code === item.code && candidate.key === item.key && candidate.message === item.message) === index);
  }
}
