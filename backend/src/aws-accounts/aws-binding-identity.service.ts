import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GetRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { AwsAccountBinding } from "./aws-account-binding.entity";

type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken: string };
type Sender = { send(command: unknown, options: { abortSignal: AbortSignal }): Promise<unknown>; destroy(): void };
export type AwsBindingIdentityClients = {
  sts(region: string, credentials?: Credentials): Sender;
  iam(region: string, credentials: Credentials): Sender;
};
const clients: AwsBindingIdentityClients = {
  sts: (region, credentials) => new STSClient({ region, credentials, maxAttempts: 1 }),
  iam: (region, credentials) => new IAMClient({ region, credentials, maxAttempts: 1 }),
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum;

export class AwsBindingIdentityError extends ServiceUnavailableException {
  constructor() {
    super({ code: "DG_AWS_BINDING_IDENTITY_UNVERIFIED", message: "Customer AWS role identity could not be independently verified. Binding remains pending." });
  }
}

export async function verifyAwsBindingIdentity(binding: AwsAccountBinding, controlAccount: string,
  factory: AwsBindingIdentityClients = clients, now: () => number = Date.now) {
  function fail(): never { throw new AwsBindingIdentityError(); }
  if (binding.status !== "PENDING" || binding.revokedAt || binding.region !== "us-east-1"
    || !/^\d{12}$/.test(controlAccount) || controlAccount === binding.accountId
    || !/^\d{12}$/.test(binding.accountId) || !/^[0-9a-f-]{36}$/.test(binding.id)
    || !/^[0-9a-f-]{36}$/.test(binding.externalId)
    || !new RegExp(`^arn:aws:iam::${binding.accountId}:role/[A-Za-z0-9_+=,.@/-]+$`).test(binding.roleArn)) fail();
  const roleName = binding.roleArn.split("/").pop()!;
  const sessionName = `deployguard-${binding.id}`;
  const expectedArn = `arn:aws:sts::${binding.accountId}:assumed-role/${roleName}/${sessionName}`;
  const signal = AbortSignal.timeout(10000);
  const opened: Sender[] = [];
  const open = (client: Sender) => { opened.push(client); return client; };
  const send = async (client: Sender, command: unknown) => {
    if (signal.aborted) fail();
    const value = await client.send(command, { abortSignal: signal });
    if (signal.aborted || !record(value)) fail();
    return value;
  };
  try {
    const bootstrap = open(factory.sts(binding.region));
    if ((await send(bootstrap, new GetCallerIdentityCommand({}))).Account !== controlAccount) fail();
    const assumed = await send(bootstrap, new AssumeRoleCommand({
      RoleArn: binding.roleArn, RoleSessionName: sessionName, ExternalId: binding.externalId, DurationSeconds: 900,
      // Restrict the inspection session itself, even if the customer's role is
      // overprivileged. This probe cannot authorize any workload mutation.
      Policy: JSON.stringify({ Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
        { Effect: "Allow", Action: "iam:GetRole", Resource: binding.roleArn },
      ] }),
    }));
    const temporary = assumed.Credentials;
    const assumedUser = assumed.AssumedRoleUser;
    if (!record(temporary) || !record(assumedUser) || assumedUser.Arn !== expectedArn
      || !string(assumedUser.AssumedRoleId, 256) || !string(temporary.AccessKeyId, 128)
      || !string(temporary.SecretAccessKey, 1024) || !string(temporary.SessionToken, 16384)
      || !(temporary.Expiration instanceof Date) || !Number.isFinite(temporary.Expiration.getTime())
      || temporary.Expiration.getTime() <= now() + 30000 || temporary.Expiration.getTime() > now() + 960000) fail();
    const credentials: Credentials = { accessKeyId: temporary.AccessKeyId, secretAccessKey: temporary.SecretAccessKey, sessionToken: temporary.SessionToken };
    const caller = await send(open(factory.sts(binding.region, credentials)), new GetCallerIdentityCommand({}));
    if (caller.Account !== binding.accountId || caller.Arn !== expectedArn || caller.UserId !== assumedUser.AssumedRoleId) fail();
    const role = (await send(open(factory.iam(binding.region, credentials)), new GetRoleCommand({ RoleName: roleName }))).Role;
    if (!record(role) || role.Arn !== binding.roleArn || !string(role.RoleId, 128) || caller.UserId !== `${role.RoleId}:${sessionName}`) fail();
    return {
      contractVersion: "deployguard.aws-binding-identity/v1" as const, bindingId: binding.id, organizationId: binding.organizationId,
      accountId: binding.accountId, region: binding.region, roleArn: binding.roleArn, roleId: role.RoleId,
      assumedRoleArn: expectedArn, observedAt: new Date(now()).toISOString(), executionAuthorized: false as const,
    };
  } catch { throw new AwsBindingIdentityError(); }
  finally {
    let cleanupFailed = false;
    for (const client of opened) { try { client.destroy(); } catch { cleanupFailed = true; } }
    if (cleanupFailed) throw new AwsBindingIdentityError();
  }
}

export type AwsBindingIdentityObservation = Awaited<ReturnType<typeof verifyAwsBindingIdentity>>;

@Injectable()
export class AwsBindingIdentityService {
  constructor(private readonly config: ConfigService) {}
  verify(binding: AwsAccountBinding) {
    return verifyAwsBindingIdentity(binding, this.config.get<string>("AWS_ACCOUNT_ID", ""));
  }
}
