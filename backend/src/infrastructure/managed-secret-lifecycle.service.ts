import { Injectable } from "@nestjs/common";
import { AwsCliService } from "../state-management/aws-cli.service";
import { TerraformRunnerService } from "./terraform-runner.service";

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT = /^(?:dev|production)$/;
const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Permanent deletion is deliberately a separate, inactive operator boundary.
// Normal destroy and reconciliation never consume this policy or call DeleteSecret.
export const MANAGED_SECRET_PURGE_POLICY = Object.freeze({
  activated: false,
  requiredConfirmation: "PURGE DEPLOYGUARD PROJECT SECRETS",
  requiresExactProjectAndEnvironment: true,
  requiresVerifiedOwnershipTags: true,
  forceDeleteWithoutRecovery: false,
});

export type ManagedSecretExpectation = {
  name: string;
  resourceAddress: string;
  versionAddress: string;
  purpose: string;
};

export type ManagedSecretDescription = {
  arn: string;
  name: string;
  deletionDate: string | null;
  tags: Record<string, string>;
};

export type ManagedSecretReconciliation = {
  name: string;
  resourceAddress: string;
  versionAddress: string;
  initialStatus: "missing" | "active" | "scheduled_for_deletion";
  restoreResult: "not_required" | "restored";
  importResult: "not_required" | "secret" | "secret_and_version" | "version";
};

export interface ManagedSecretLifecyclePort {
  findExact(name: string): Promise<ManagedSecretDescription[]>;
  restore(arn: string): Promise<void>;
  currentVersionId(arn: string): Promise<string>;
  stateAddresses(): Promise<Set<string>>;
  importResource(address: string, id: string): Promise<void>;
  wait?(milliseconds: number): Promise<void>;
}

export function expectedManagedSecrets(terraformVariables: Record<string, unknown>): ManagedSecretExpectation[] {
  const projectId = String(terraformVariables.project_id || "");
  const environment = String(terraformVariables.environment_name || "");
  if (!PROJECT_ID.test(projectId)) throw new Error("Managed-secret reconciliation requires a valid project UUID.");
  if (!ENVIRONMENT.test(environment)) throw new Error("Managed-secret reconciliation requires a supported environment.");

  const expected: ManagedSecretExpectation[] = [];
  const database = terraformVariables.database_service as { enabled?: unknown } | undefined;
  if (database?.enabled === true) {
    for (const purpose of ["password", "url"] as const) {
      expected.push({
        name: `deployguard/${projectId}/${environment}/database/${purpose}`,
        resourceAddress: `module.database_service.aws_secretsmanager_secret.${purpose}[0]`,
        versionAddress: `module.database_service.aws_secretsmanager_secret_version.${purpose}[0]`,
        purpose: `database_${purpose}`,
      });
    }
  }

  const applicationSecrets = terraformVariables.ecs_secret_environment_variables;
  if (applicationSecrets && (typeof applicationSecrets !== "object" || Array.isArray(applicationSecrets))) {
    throw new Error("Managed application-secret configuration is invalid.");
  }
  for (const key of Object.keys((applicationSecrets || {}) as Record<string, unknown>).sort()) {
    if (!SECRET_KEY.test(key)) throw new Error("Managed application-secret name is invalid.");
    const index = JSON.stringify(key);
    expected.push({
      name: `deployguard/${projectId}/${environment}/${key}`,
      resourceAddress: `module.ecs_service.aws_secretsmanager_secret.environment[${index}]`,
      versionAddress: `module.ecs_service.aws_secretsmanager_secret_version.environment[${index}]`,
      purpose: `application_${key}`,
    });
  }
  return expected;
}

export class ManagedSecretLifecycleReconciler {
  constructor(
    private readonly port: ManagedSecretLifecyclePort,
    private readonly polling: { attempts: number; intervalMs: number } = { attempts: 10, intervalMs: 2_000 },
  ) {}

  async reconcile(expectations: ManagedSecretExpectation[]): Promise<ManagedSecretReconciliation[]> {
    const state = await this.port.stateAddresses();
    const results: ManagedSecretReconciliation[] = [];
    for (const expected of expectations) {
      const matches = await this.port.findExact(expected.name);
      if (matches.length > 1) throw new Error(`Managed secret ${expected.name} is ambiguous; reconciliation stopped.`);
      if (!matches.length) {
        results.push({ ...expected, initialStatus: "missing", restoreResult: "not_required", importResult: "not_required" });
        continue;
      }

      let secret = matches[0];
      this.assertOwnership(secret, expected);
      const scheduled = Boolean(secret.deletionDate);
      if (scheduled) {
        await this.port.restore(secret.arn);
        secret = await this.waitUntilRestored(expected);
      }

      let secretImported = false;
      let versionImported = false;
      if (!state.has(expected.resourceAddress)) {
        await this.port.importResource(expected.resourceAddress, secret.arn);
        state.add(expected.resourceAddress);
        secretImported = true;
      }
      if (!state.has(expected.versionAddress)) {
        const versionId = await this.port.currentVersionId(secret.arn);
        if (!versionId) throw new Error(`Managed secret ${expected.name} has no unambiguous AWSCURRENT version.`);
        await this.port.importResource(expected.versionAddress, `${secret.arn}|${versionId}`);
        state.add(expected.versionAddress);
        versionImported = true;
      }
      results.push({
        ...expected,
        initialStatus: scheduled ? "scheduled_for_deletion" : "active",
        restoreResult: scheduled ? "restored" : "not_required",
        importResult: secretImported && versionImported ? "secret_and_version" : secretImported ? "secret" : versionImported ? "version" : "not_required",
      });
    }
    return results;
  }

  private assertOwnership(secret: ManagedSecretDescription, expected: ManagedSecretExpectation) {
    const parts = expected.name.split("/");
    const required = {
      ManagedBy: "DeployGuard",
      DeployGuardProjectId: parts[1],
      Environment: parts[2],
      SecretPurpose: expected.purpose,
    };
    for (const [key, value] of Object.entries(required)) {
      if (secret.tags[key] !== value) {
        throw new Error(`Managed secret ${expected.name} failed ownership verification (${key}).`);
      }
    }
    if (secret.name !== expected.name) throw new Error(`Managed secret ${expected.name} failed namespace verification.`);
  }

  private async waitUntilRestored(expected: ManagedSecretExpectation) {
    for (let attempt = 0; attempt < this.polling.attempts; attempt += 1) {
      const matches = await this.port.findExact(expected.name);
      if (matches.length !== 1) throw new Error(`Managed secret ${expected.name} became ambiguous during restoration.`);
      this.assertOwnership(matches[0], expected);
      if (!matches[0].deletionDate) return matches[0];
      if (attempt + 1 < this.polling.attempts) {
        await (this.port.wait ? this.port.wait(this.polling.intervalMs) : new Promise((resolve) => setTimeout(resolve, this.polling.intervalMs)));
      }
    }
    throw new Error(`Managed secret ${expected.name} was not restored within the bounded verification window.`);
  }
}

@Injectable()
export class ManagedSecretLifecycleService {
  constructor(
    private readonly aws: AwsCliService,
    private readonly terraform: TerraformRunnerService,
  ) {}

  async reconcileBeforePlan(workdir: string, variables: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
    const expectations = expectedManagedSecrets(variables);
    if (!expectations.length) return [];
    const port: ManagedSecretLifecyclePort = {
      findExact: async (name) => {
        const result = await this.aws.run([
          "secretsmanager", "list-secrets", "--include-planned-deletion",
          "--filters", `Key=name,Values=${name}`, "--output", "json",
        ]);
        const parsed = JSON.parse(result.stdout || "{}") as { SecretList?: Array<{ ARN?: string; Name?: string; DeletedDate?: string; Tags?: Array<{ Key?: string; Value?: string }> }> };
        return (parsed.SecretList || []).filter((secret) => secret.Name === name && secret.ARN).map((secret) => ({
          arn: secret.ARN!, name: secret.Name!, deletionDate: secret.DeletedDate || null,
          tags: Object.fromEntries((secret.Tags || []).filter((tag) => tag.Key && tag.Value !== undefined).map((tag) => [tag.Key!, tag.Value!])),
        }));
      },
      restore: async (arn) => { await this.aws.run(["secretsmanager", "restore-secret", "--secret-id", arn, "--output", "json"]); },
      currentVersionId: async (arn) => {
        const result = await this.aws.run(["secretsmanager", "list-secret-version-ids", "--secret-id", arn, "--include-deprecated", "--output", "json"]);
        const parsed = JSON.parse(result.stdout || "{}") as { Versions?: Array<{ VersionId?: string; VersionStages?: string[] }> };
        const current = (parsed.Versions || []).filter((version) => version.VersionId && version.VersionStages?.includes("AWSCURRENT"));
        if (current.length !== 1) return "";
        return current[0].VersionId!;
      },
      stateAddresses: async () => new Set(await this.terraform.listTerraformState(workdir, env)),
      importResource: async (address, id) => { await this.terraform.importTerraformResource(workdir, address, id, env); },
    };
    return new ManagedSecretLifecycleReconciler(port).reconcile(expectations);
  }
}
