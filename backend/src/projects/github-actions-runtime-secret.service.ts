import { createHash } from "crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  PutSecretValueCommand,
  RestoreSecretCommand,
  SecretsManagerClient,
  UpdateSecretVersionStageCommand,
} from "@aws-sdk/client-secrets-manager";

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATION_ID = PROJECT_ID;
const ENVIRONMENT = /^(?:dev|production)$/;
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
  secretNames: string[];
  valueFromByName: Record<string, string>;
  versionToken: string;
};

export interface RuntimeSecretMaterializationPort {
  describe(name: string): Promise<RuntimeSecretDescription | null>;
  create(name: string, secretString: string, versionToken: string, tags: Record<string, string>): Promise<string>;
  restore(arn: string): Promise<void>;
  put(arn: string, secretString: string, versionToken: string): Promise<void>;
  activateVersion(arn: string, versionToken: string, previousVersionToken: string): Promise<void>;
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
    if (!description) {
      arn = await this.port.create(secretName, secretString, versionToken, tags);
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
        if (stages.length) {
          if (!previous) throw new Error("Managed runtime secret has no unambiguous AWSCURRENT version.");
          await this.port.activateVersion(arn, versionToken, previous);
        } else {
          await this.port.put(arn, secretString, versionToken);
        }
      }
    }

    return {
      secretArn: arn,
      secretNames,
      valueFromByName: Object.fromEntries(secretNames.map((name) => [name, `${arn}:${name}::`])),
      versionToken,
    };
  }

  private assertInput(input: { projectId: string; generationId: string; environment: string; configurationFingerprint: string; secretValues: Record<string, string> }) {
    if (!PROJECT_ID.test(input.projectId)) throw new Error("Runtime secret materialization requires a valid project UUID.");
    if (!GENERATION_ID.test(input.generationId)) throw new Error("Runtime secret materialization requires a valid generation UUID.");
    if (!ENVIRONMENT.test(input.environment)) throw new Error("Runtime secret materialization requires a supported environment.");
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

  constructor(config: ConfigService) {
    this.client = new SecretsManagerClient({ region: config.get<string>("AWS_REGION", "us-east-1") });
  }

  async materialize(input: {
    projectId: string;
    serviceId?: string;
    generationId: string;
    environment: string;
    configurationFingerprint: string;
    secretValues: Record<string, string>;
  }) {
    const port: RuntimeSecretMaterializationPort = {
      describe: async (name) => {
        try {
          const result = await this.client.send(new DescribeSecretCommand({ SecretId: name }));
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
        const result = await this.client.send(new CreateSecretCommand({
          Name: name,
          SecretString: secretString,
          ClientRequestToken: versionToken,
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        }));
        if (!result.ARN) throw new Error("Managed runtime secret creation returned no ARN.");
        return result.ARN;
      },
      restore: async (arn) => { await this.client.send(new RestoreSecretCommand({ SecretId: arn })); },
      put: async (arn, secretString, versionToken) => {
        await this.client.send(new PutSecretValueCommand({ SecretId: arn, SecretString: secretString, ClientRequestToken: versionToken }));
      },
      activateVersion: async (arn, versionToken, previousVersionToken) => {
        await this.client.send(new UpdateSecretVersionStageCommand({
          SecretId: arn,
          VersionStage: "AWSCURRENT",
          MoveToVersionId: versionToken,
          RemoveFromVersionId: previousVersionToken,
        }));
      },
    };
    try {
      return await new RuntimeSecretMaterializer(port).materialize(input);
    } catch {
      throw new Error("DeployGuard could not materialize the immutable project secret reference.");
    }
  }
}
