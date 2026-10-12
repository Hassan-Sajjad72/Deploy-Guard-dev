import { DataSource } from "typeorm";
import { AwsAccountBinding } from "../workspaces/aws-account-binding.entity";
import { customerMutationAuthorized } from "../workspaces/customer-authority-proof";
import type { CustomerExecutionContext } from "./customer-execution-context";
import { createHash } from "crypto";
import { Agent } from "https";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  PutSecretValueCommand,
  RestoreSecretCommand,
  SecretsManagerClient,
  UpdateSecretVersionStageCommand,
} from "@aws-sdk/client-secrets-manager";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { isCanonicalEnvironmentName } from "./canonical-environment";

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATION_ID = PROJECT_ID;
const CONFIGURATION_FINGERPRINT = /^[0-9a-f]{64}$/;
const SECRET_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;

export type RuntimeSecretDescription = {
  arn: string;
  name: string;
  deletionDate: Date | null;
  tags: Record<string, string>;
  versions: Record<string, string[]>;
};

export type RuntimeSecretMaterialization = {
  secretArn: string;
  secretName: string;
  secretNames: string[];
  valueFromByName: Record<string, string>;
  versionToken: string;
  provisionalChange: "created" | "version_activated" | null;
  previousVersionToken: string | null;
};

export class RuntimeSecretMaterializationError extends Error {
  readonly diagnosticCode = "DG_RUNTIME_SECRET_MATERIALIZATION_FAILED";
  constructor() { super("DeployGuard could not materialize the immutable project secret reference."); }
}

export function runtimeSecretRequestHandler() {
  return new NodeHttpHandler({
    // This host cannot route IPv6 to the AWS endpoint. Without an IPv4 agent,
    // the SDK times out before Secrets Manager receives the request.
    httpsAgent: new Agent({ family: 4 }),
    connectionTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

export interface RuntimeSecretMaterializationPort {
  describe(name: string): Promise<RuntimeSecretDescription | null>;
  create(name: string, secretString: string, versionToken: string, tags: Record<string, string>): Promise<string>;
  restore(arn: string): Promise<void>;
  put(arn: string, secretString: string, versionToken: string): Promise<void>;
  activateVersion(arn: string, versionToken: string, previousVersionToken: string): Promise<void>;
  delete(arn: string): Promise<void>;
  wait?(milliseconds: number): Promise<void>;
}

export class RuntimeSecretMaterializer {
  constructor(
    private readonly port: RuntimeSecretMaterializationPort,
    private readonly polling = { attempts: 10, intervalMs: 2_000 },
  ) {}

  async materialize(input: {
    projectId: string;
    serviceId?: string;
    generationId: string;
    environment: string;
    configurationFingerprint: string;
    secretValues: Record<string, string>;
  }): Promise<RuntimeSecretMaterialization | null> {
    this.assertInput(input);
    const secretNames = Object.keys(input.secretValues).sort();
    if (!secretNames.length) return null;
    const serviceScope = input.serviceId || "default";
    if (input.serviceId && !PROJECT_ID.test(input.serviceId)) throw new Error("Runtime secret materialization requires a valid service UUID.");
    const secretName = `deployguard/${input.projectId}/${input.environment}/services/${serviceScope}/runtime`;
    const secretString = JSON.stringify(Object.fromEntries(secretNames.map((name) => [name, input.secretValues[name]])));
    const versionToken = createHash("sha256")
      .update(`deployguard-runtime-secret:${input.projectId}:${input.environment}:${input.configurationFingerprint}`)
      .digest("hex");
    const tags = {
      ManagedBy: "DeployGuard",
      DeployGuardProjectId: input.projectId,
      DeployGuardServiceId: serviceScope,
      Environment: input.environment,
      DeployGuardScope: "service",
      SecretPurpose: "application_runtime",
    };

    let description = await this.port.describe(secretName);
    let arn: string;
    let provisionalChange: RuntimeSecretMaterialization["provisionalChange"] = null;
    let previousVersionToken: string | null = null;
    if (!description) {
      arn = await this.port.create(secretName, secretString, versionToken, tags);
      provisionalChange = "created";
    } else {
      this.assertOwnership(description, secretName, tags);
      if (description.deletionDate) {
        await this.port.restore(description.arn);
        description = await this.waitUntilActive(secretName, tags);
      }
      arn = description.arn;
      const stages = description.versions[versionToken] || [];
      if (!stages.includes("AWSCURRENT")) {
        const previous = Object.entries(description.versions)
          .find(([, versionStages]) => versionStages.includes("AWSCURRENT"))?.[0] || "";
        if (!previous) throw new Error("Managed runtime secret has no unambiguous AWSCURRENT version.");
        if (stages.length) {
          await this.port.activateVersion(arn, versionToken, previous);
        } else {
          await this.port.put(arn, secretString, versionToken);
        }
        provisionalChange = "version_activated";
        previousVersionToken = previous;
      }
    }

    return {
      secretArn: arn,
      secretName,
      secretNames,
      // ECS accepts ARN:json-key:version-stage:version-id. Leaving both
      // version selectors empty would make rollback follow mutable AWSCURRENT.
      valueFromByName: Object.fromEntries(secretNames.map((name) => [name, `${arn}:${name}::${versionToken}`])),
      versionToken,
      provisionalChange,
      previousVersionToken,
    };
  }

  async compensate(materialization: RuntimeSecretMaterialization) {
    if (!materialization.provisionalChange) return;
    const serviceScope = materialization.secretName.split("/").at(-2) || "";
    const parts = materialization.secretName.split("/");
    const tags = {
      ManagedBy: "DeployGuard",
      DeployGuardProjectId: parts[1] || "",
      DeployGuardServiceId: serviceScope,
      Environment: parts[2] || "",
      DeployGuardScope: "service",
      SecretPurpose: "application_runtime",
    };
    const description = await this.port.describe(materialization.secretName);
    if (!description || description.arn !== materialization.secretArn) throw new Error("Managed runtime secret compensation identity is unavailable.");
    this.assertOwnership(description, materialization.secretName, tags);
    if (materialization.provisionalChange === "created") {
      await this.port.delete(materialization.secretArn);
      return;
    }
    if (!materialization.previousVersionToken) throw new Error("Managed runtime secret compensation has no previous immutable version.");
    const currentStages = description.versions[materialization.versionToken] || [];
    if (currentStages.includes("AWSCURRENT")) {
      await this.port.activateVersion(materialization.secretArn, materialization.previousVersionToken, materialization.versionToken);
    }
  }

  private assertInput(input: { projectId: string; generationId: string; environment: string; configurationFingerprint: string; secretValues: Record<string, string> }) {
    if (!PROJECT_ID.test(input.projectId)) throw new Error("Runtime secret materialization requires a valid project UUID.");
    if (!GENERATION_ID.test(input.generationId)) throw new Error("Runtime secret materialization requires a valid generation UUID.");
    if (!isCanonicalEnvironmentName(input.environment)) throw new Error("Runtime secret materialization requires a supported environment.");
    if (!CONFIGURATION_FINGERPRINT.test(input.configurationFingerprint)) throw new Error("Runtime secret materialization requires an immutable configuration fingerprint.");
    if (!input.secretValues || typeof input.secretValues !== "object" || Array.isArray(input.secretValues)) throw new Error("Runtime secret materialization requires a secret map.");
    for (const [key, value] of Object.entries(input.secretValues)) {
      if (!SECRET_KEY.test(key) || typeof value !== "string" || !value.length) throw new Error("Runtime secret materialization received an invalid secret entry.");
    }
  }

  private assertOwnership(description: RuntimeSecretDescription, name: string, tags: Record<string, string>) {
    if (description.name !== name) throw new Error("Managed runtime secret namespace verification failed.");
    for (const [key, value] of Object.entries(tags)) {
      if (description.tags[key] !== value) throw new Error(`Managed runtime secret ownership verification failed (${key}).`);
    }
  }

  private async waitUntilActive(name: string, tags: Record<string, string>) {
    for (let attempt = 0; attempt < this.polling.attempts; attempt += 1) {
      const description = await this.port.describe(name);
      if (!description) throw new Error("Managed runtime secret disappeared during restoration.");
      this.assertOwnership(description, name, tags);
      if (!description.deletionDate) return description;
      if (attempt + 1 < this.polling.attempts) {
        await (this.port.wait ? this.port.wait(this.polling.intervalMs) : new Promise((resolve) => setTimeout(resolve, this.polling.intervalMs)));
      }
    }
    throw new Error("Managed runtime secret restoration did not complete within the bounded verification window.");
  }
}

@Injectable()
export class GithubActionsRuntimeSecretService {
  private readonly client: SecretsManagerClient;

  constructor(private readonly config: ConfigService, private readonly database?: DataSource) {
    this.client = new SecretsManagerClient({
      region: config.get<string>("AWS_REGION", "us-east-1"),
      requestHandler: runtimeSecretRequestHandler(),
    });
  }

  async materialize(input: {
    projectId: string;
    serviceId?: string;
    generationId: string;
    environment: string;
    configurationFingerprint: string;
    secretValues: Record<string, string>;
  }, context?: import("../planning/customer-aws-session.service").CustomerAwsContext) {
    const client = context ? new SecretsManagerClient({ region: context.region, credentials: context.credentials, requestHandler: runtimeSecretRequestHandler() }) : this.client;
    const port = this.port(client, context as CustomerExecutionContext | undefined);
    try {
      const result = await new RuntimeSecretMaterializer(port).materialize(input);
      if (result && context && result.secretArn.split(":")[4] !== context.accountId) throw new Error("Runtime secret account mismatch.");
      return result;
    } catch {
      throw new RuntimeSecretMaterializationError();
    } finally { if (context) client.destroy(); }
  }

  async compensate(materializations: RuntimeSecretMaterialization[], context?: import("../planning/customer-aws-session.service").CustomerAwsContext) {
    const client = context ? new SecretsManagerClient({ region: context.region, credentials: context.credentials, requestHandler: runtimeSecretRequestHandler() }) : this.client;
    const materializer = new RuntimeSecretMaterializer(this.port(client, context as CustomerExecutionContext | undefined));
    const failed: string[] = [];
    try { for (const materialization of [...materializations].reverse()) {
      if (context && materialization.secretArn.split(":")[4] !== context.accountId) { failed.push(materialization.secretName); continue; }
      try { await materializer.compensate(materialization); }
      catch { failed.push(materialization.secretName); }
    } return { cleaned: materializations.length - failed.length, failed: failed.length }; }
    finally { if (context) client.destroy(); }
  }

  private async beforeCustomerMutation(context: CustomerExecutionContext) {
    if (!this.database || !context.projectId || !context.organizationId || !context.bindingId) throw new Error("Customer mutation context is unavailable.");
    const [project] = await this.database.query(`SELECT p.id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.id = $1 AND p.organization_id = $2 AND p.status <> 'archived' AND p.deletion_intent_id IS NULL AND o.archived_at IS NULL`, [context.projectId, context.organizationId]);
    const binding = await this.database.getRepository(AwsAccountBinding).findOneBy({ id: context.bindingId, organizationId: context.organizationId });
    if (!project || !binding || binding.verificationVersion !== context.bindingVersion || binding.accountId !== context.accountId || !binding.regions.includes(context.region) || !customerMutationAuthorized(this.config, binding, context.projectId) || context.credentials.expiration.getTime() < Date.now() + 10000) throw new Error("Customer mutation authorization changed.");
  }
  private port(client = this.client, context?: CustomerExecutionContext): RuntimeSecretMaterializationPort {
    const owned = (arn: string) => !context || arn.startsWith(`arn:aws:secretsmanager:${context.region}:${context.accountId}:secret:deployguard/${context.projectId}/${context.environmentName}/services/`);
    const before = async (arn?: string) => { if (context) { if (arn && !owned(arn)) throw new Error("Foreign customer secret."); await this.beforeCustomerMutation(context); } };
    return {
      describe: async (name) => {
        try {
          const result = await client.send(new DescribeSecretCommand({ SecretId: name }));
          if (result.ARN && !owned(result.ARN)) throw new Error("Foreign customer secret.");
          if (!result.ARN || !result.Name) throw new Error("Managed runtime secret identity is incomplete.");
          return {
            arn: result.ARN,
            name: result.Name,
            deletionDate: result.DeletedDate || null,
            tags: Object.fromEntries((result.Tags || []).filter((tag) => tag.Key && tag.Value !== undefined).map((tag) => [tag.Key!, tag.Value!])),
            versions: Object.fromEntries(Object.entries(result.VersionIdsToStages || {}).map(([id, stages]) => [id, stages || []])),
          };
        } catch (error) {
          if ((error as { name?: string })?.name === "ResourceNotFoundException") return null;
          throw error;
        }
      },
      create: async (name, secretString, versionToken, tags) => {
        if (context && !name.startsWith(`deployguard/${context.projectId}/${context.environmentName}/services/`)) throw new Error("Foreign customer secret name.");
        await before();
        const result = await client.send(new CreateSecretCommand({
          Name: name,
          SecretString: secretString,
          ClientRequestToken: versionToken,
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        }));
        if (!result.ARN) throw new Error("Managed runtime secret creation returned no ARN.");
        return result.ARN;
      },
      restore: async (arn) => { await before(arn); await client.send(new RestoreSecretCommand({ SecretId: arn })); },
      put: async (arn, secretString, versionToken) => {
        await before(arn);
        await client.send(new PutSecretValueCommand({ SecretId: arn, SecretString: secretString, ClientRequestToken: versionToken }));
      },
      activateVersion: async (arn, versionToken, previousVersionToken) => {
        await before(arn);
        await client.send(new UpdateSecretVersionStageCommand({
          SecretId: arn,
          VersionStage: "AWSCURRENT",
          MoveToVersionId: versionToken,
          RemoveFromVersionId: previousVersionToken,
        }));
      },
      delete: async (arn) => {
        await before(arn);
        await client.send(new DeleteSecretCommand({ SecretId: arn, ForceDeleteWithoutRecovery: true }));
      },
    };
  }
}
