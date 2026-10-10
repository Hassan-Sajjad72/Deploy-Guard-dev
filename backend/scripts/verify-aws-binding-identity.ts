import "reflect-metadata";
import { strict as assert } from "node:assert";
import { AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { GetRoleCommand } from "@aws-sdk/client-iam";
import { AwsAccountBinding } from "../src/aws-accounts/aws-account-binding.entity";
import { AwsBindingIdentityClients, AwsBindingIdentityError, verifyAwsBindingIdentity } from "../src/aws-accounts/aws-binding-identity.service";

const binding = Object.assign(new AwsAccountBinding(), { id: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222",
  accountId: "222222222222", region: "us-east-1", roleArn: "arn:aws:iam::222222222222:role/team/DeployGuard",
  externalId: "33333333-3333-4333-8333-333333333333", status: "PENDING", revokedAt: null });
const now = Date.parse("2026-10-10T10:00:00Z");
const session = `deployguard-${binding.id}`;
const arn = `arn:aws:sts::${binding.accountId}:assumed-role/DeployGuard/${session}`;
const caller = { Account: binding.accountId, Arn: arn, UserId: `AROAEXACTROLE:${session}` };
const assume = { Credentials: { AccessKeyId: "ASIAEXAMPLEONLY", SecretAccessKey: "DO-NOT-PERSIST-SECRET", SessionToken: "DO-NOT-PERSIST-TOKEN", Expiration: new Date(now + 900000) },
  AssumedRoleUser: { Arn: arn, AssumedRoleId: caller.UserId } };
const role = { Role: { Arn: binding.roleArn, RoleId: "AROAEXACTROLE" } };

async function run() {
  async function scenario(change: (result: Record<string, unknown>, stage: string) => unknown = (result) => result, expectFailure = false,
    selected: AwsAccountBinding = binding, cleanupFailure = false) {
    let opened = 0, closed = 0, requests = 0;
    let firstSignal: AbortSignal | undefined;
    const factory: AwsBindingIdentityClients = {
      sts: (region, credentials) => {
        assert.equal(region, "us-east-1"); opened++;
        if (credentials) assert.deepEqual(credentials, { accessKeyId: assume.Credentials.AccessKeyId, secretAccessKey: assume.Credentials.SecretAccessKey, sessionToken: assume.Credentials.SessionToken });
        return { destroy: () => { closed++; if (cleanupFailure && closed === 1) throw new Error("DO-NOT-LEAK-CLEANUP"); },
          send: async (command, options) => {
            requests++; firstSignal ||= options.abortSignal; assert.equal(options.abortSignal, firstSignal);
            assert.equal(options.abortSignal.aborted, false);
            if (command instanceof AssumeRoleCommand) {
              assert.equal(credentials, undefined); assert.equal(command.input.DurationSeconds, 900);
              assert.equal(command.input.ExternalId, binding.externalId); assert.equal(command.input.RoleArn, binding.roleArn);
              assert.equal(command.input.RoleSessionName, session);
              const policy = JSON.parse(command.input.Policy!);
              assert.deepEqual(policy.Statement, [
                { Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
                { Effect: "Allow", Action: "iam:GetRole", Resource: binding.roleArn },
              ], "temporary inspection permissions cannot mutate customer resources");
              return change(structuredClone(assume), "assume");
            }
            assert.ok(command instanceof GetCallerIdentityCommand);
            return change(credentials ? structuredClone(caller) : { Account: "123456789012" }, credentials ? "caller" : "bootstrap");
          } };
      },
      iam: (region, credentials) => {
        assert.equal(region, binding.region); assert.equal(credentials.sessionToken, assume.Credentials.SessionToken); opened++;
        return { destroy: () => { closed++; }, send: async (command, options) => {
          requests++; assert.equal(options.abortSignal, firstSignal); assert.ok(command instanceof GetRoleCommand);
          assert.equal(command.input.RoleName, "DeployGuard", "role paths are not passed as IAM role names");
          return change(structuredClone(role), "role");
        } };
      },
    };
    let observation: unknown;
    try {
      if (expectFailure) await assert.rejects(() => verifyAwsBindingIdentity(selected, "123456789012", factory, () => now), (error: unknown) => {
        assert.ok(error instanceof AwsBindingIdentityError);
        assert.doesNotMatch(JSON.stringify(error.getResponse()), /DO-NOT-|ASIAEXAMPLEONLY/);
        return true;
      });
      else {
        observation = await verifyAwsBindingIdentity(selected, "123456789012", factory, () => now);
        assert.deepEqual(observation, { contractVersion: "deployguard.aws-binding-identity/v1", bindingId: binding.id,
          organizationId: binding.organizationId, accountId: binding.accountId, region: binding.region, roleArn: binding.roleArn,
          roleId: "AROAEXACTROLE", assumedRoleArn: arn, observedAt: new Date(now).toISOString(), executionAuthorized: false });
        assert.equal(requests, 4);
        assert.doesNotMatch(JSON.stringify(observation), /DO-NOT-|Credentials|SessionToken|ASIAEXAMPLEONLY/);
      }
    } finally { assert.equal(closed, opened, "all SDK clients close on success, denial, malformed result and cleanup failure"); }
    return { requests, observation };
  }
  await scenario();
  const mutate = (stage: string, fields: Record<string, unknown>) => (result: Record<string, unknown>, current: string) => current === stage ? { ...result, ...fields } : result;
  for (const fields of [{ Account: "999999999999" }, { Account: undefined }]) await scenario(mutate("bootstrap", fields), true);
  await scenario((result, stage) => stage === "assume" ? {} : result, true);
  for (const fields of [
    { SessionToken: undefined }, { SecretAccessKey: "" }, { AccessKeyId: undefined },
    { Expiration: new Date(now - 1) }, { Expiration: new Date(now + 3600000) }, { Expiration: "not-a-date" },
  ]) await scenario((result, stage) => stage === "assume" ? { ...result, Credentials: { ...assume.Credentials, ...fields } } : result, true);
  await scenario(mutate("assume", { AssumedRoleUser: { Arn: "foreign", AssumedRoleId: caller.UserId } }), true);
  for (const fields of [{ Account: "123456789012" }, { Arn: "foreign" }, { UserId: "AROAOTHERROLE:wrong" }]) await scenario(mutate("caller", fields), true);
  for (const Role of [{ Arn: "foreign", RoleId: "AROAEXACTROLE" }, { Arn: binding.roleArn, RoleId: "AROAOTHERROLE" }, {}]) await scenario(mutate("role", { Role }), true);
  for (const stage of ["bootstrap", "assume", "caller", "role"]) await scenario((result, current) => { if (current === stage) throw new Error("DO-NOT-LEAK-PROVIDER"); return result; }, true);
  await scenario(undefined, true, Object.assign(new AwsAccountBinding(), binding, { status: "REVOKED" }));
  await scenario(undefined, true, Object.assign(new AwsAccountBinding(), binding, { region: "us-west-2" }));
  await scenario(undefined, true, binding, true);
  let destroyed = 0;
  const hanging: AwsBindingIdentityClients = {
    sts: () => ({ destroy: () => { destroyed++; }, send: (_command, { abortSignal }) => new Promise((_resolve, reject) => {
      abortSignal.addEventListener("abort", () => reject(new Error("DO-NOT-LEAK-TIMEOUT")), { once: true });
    }) }),
    iam: () => { throw new Error("IAM must not open after bootstrap timeout"); },
  };
  // Keep the process alive while observing AbortSignal.timeout's unref timer.
  const keepAlive = setTimeout(() => undefined, 15000);
  try { await assert.rejects(() => verifyAwsBindingIdentity(binding, "123456789012", hanging), AwsBindingIdentityError); }
  finally { clearTimeout(keepAlive); }
  assert.equal(destroyed, 1, "transport timeout must close the opened client");
  console.log("S02_TEMPORARY_IDENTITY=PASS ACCOUNT_AND_ROLE_ID_EXACT=1 MINIMAL_SESSION_POLICY=1 EXPIRY_REQUIRED=1 SDK_CLEANUP=1 RAW_CREDENTIALS_RETAINED=0 AWS_EXECUTION=INJECTED_ONLY");
}
void run().catch((error) => { console.error(error); process.exitCode = 1; });
