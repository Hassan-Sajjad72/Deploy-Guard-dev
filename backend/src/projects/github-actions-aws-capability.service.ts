import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DeleteRolePolicyCommand,
  GetRolePolicyCommand,
  IAMClient,
  PutRolePolicyCommand,
  SimulatePrincipalPolicyCommand,
} from "@aws-sdk/client-iam";
import {
  capabilitiesFor,
  WorkflowAwsCapability,
  WorkflowAwsCapabilityScope,
  WorkflowLifecycleAction,
  workflowCapabilityFingerprint,
  workflowCapabilityPolicy,
  workflowCapabilityRuntimeStatus,
  WORKFLOW_AWS_CAPABILITIES,
  WORKFLOW_AWS_CAPABILITY_CONTRACT_VERSION,
} from "./github-actions-aws-capability-contract";

const POLICY_NAME = "DeployGuardWorkflowCapabilities";
const RETIRED_POLICY_NAMES = ["DeployGuardDeploymentResources"] as const;
type IamSender = { send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<any>; destroy?: () => void };

const decodedPolicy = (value?: string) => {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return JSON.parse(decodeURIComponent(value.replace(/\+/g, "%20"))); }
};
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
};
const concreteSimulationResource = (resource: string) => resource === "*"
  ? resource
  : resource.replace(/\*/g, "deployguard-simulation");

export class WorkflowAwsCapabilityError extends ServiceUnavailableException {
  constructor(public readonly missingCapabilities: string[], detail: string) {
    super({
      code: "platform_aws_capability_missing",
      classification: "platform_configuration",
      message: "DeployGuard execution role is missing a platform-required AWS permission.",
      detail,
      missingCapabilities,
    });
  }
}

async function simulateCapability(client: IamSender, roleArn: string, scope: WorkflowAwsCapabilityScope, capability: WorkflowAwsCapability, abortSignal?: AbortSignal) {
  const denied = new Set<string>();
  const actionGroups = new Map<string, { actions: string[]; resources: string[]; context: Record<string, string[]> }>();
  for (const action of capability.actions) {
    const resources = (capability.simulationResources?.(scope, action) || capability.resources(scope)).map(concreteSimulationResource);
    const context = capability.simulationContextForAction?.(scope, action) || capability.simulationContext?.(scope) || {};
    const key = canonicalJson({ resources, context });
    const group = actionGroups.get(key) || { actions: [], resources, context };
    group.actions.push(action);
    actionGroups.set(key, group);
  }
  for (const group of actionGroups.values()) {
    let marker: string | undefined;
    do {
      const response = await client.send(new SimulatePrincipalPolicyCommand({
        PolicySourceArn: roleArn,
        ActionNames: group.actions,
        ResourceArns: group.resources,
        ContextEntries: Object.entries(group.context).map(([key, values]) => ({
          ContextKeyName: key,
          ContextKeyType: "string" as const,
          ContextKeyValues: values,
        })),
        Marker: marker,
      }), { abortSignal });
      for (const result of response.EvaluationResults || []) {
        if (result.EvalDecision !== "allowed") denied.add(String(result.EvalActionName || capability.id));
      }
      marker = response.IsTruncated ? response.Marker : undefined;
    } while (marker);
  }
  return [...denied].sort();
}

export async function verifyEffectiveWorkflowCapabilities(
  client: IamSender,
  roleArn: string,
  scope: WorkflowAwsCapabilityScope,
  action: WorkflowLifecycleAction,
  capabilities: readonly WorkflowAwsCapability[] = capabilitiesFor(action, scope),
  abortSignal?: AbortSignal,
) {
  const denied = new Set<string>();
  for (const capability of capabilities) {
    try {
      for (const item of await simulateCapability(client, roleArn, scope, capability, abortSignal)) denied.add(item);
    } catch (error) {
      throw new WorkflowAwsCapabilityError([capability.id], `Effective IAM simulation failed for ${capability.id}: ${error instanceof Error ? error.message : "unknown IAM error"}`);
    }
  }
  return [...denied].sort();
}

export async function reconcileWorkflowCapabilities(input: {
  client: IamSender;
  roleArn: string;
  roleName: string;
  scope: WorkflowAwsCapabilityScope;
  action: WorkflowLifecycleAction;
  platformManaged: boolean;
  capabilities?: readonly WorkflowAwsCapability[];
  abortSignal?: AbortSignal;
}) {
  const capabilities = input.capabilities || capabilitiesFor(input.action, input.scope);
  let existingPolicy: unknown = null;
  try {
    existingPolicy = decodedPolicy((await input.client.send(new GetRolePolicyCommand({ RoleName: input.roleName, PolicyName: POLICY_NAME }), { abortSignal: input.abortSignal })).PolicyDocument);
  } catch (error) {
    if ((error as { name?: string })?.name !== "NoSuchEntityException") {
      throw new WorkflowAwsCapabilityError(["iam:GetRolePolicy"], "DeployGuard could not inspect its managed execution-role policy.");
    }
  }

  // Externally managed roles are read-only verified immediately. A
  // platform-managed role is first converged to the canonical policy and then
  // simulated once, avoiding a redundant full IAM simulation that can exhaust
  // the bounded admission timeout while converging an older policy revision.
  let missing = input.platformManaged
    ? []
    : await verifyEffectiveWorkflowCapabilities(input.client, input.roleArn, input.scope, input.action, capabilities, input.abortSignal);
  let reconciled = false;
  if (input.platformManaged) {
    const policyCapabilities = input.capabilities || WORKFLOW_AWS_CAPABILITIES;
    const desiredPolicy = input.capabilities
      ? {
          Version: "2012-10-17",
          Statement: policyCapabilities.flatMap((capability, index) => {
            const actions = [...capability.actions];
            return actions.length ? [{
              Sid: `DeployGuard${index + 1}${capability.id.replace(/[^A-Za-z0-9]/g, "")}`,
              Effect: "Allow",
              Action: actions,
              Resource: (capability.policyResources || capability.resources)(input.scope),
              ...((capability.policyCondition || capability.condition) ? { Condition: (capability.policyCondition || capability.condition)!(input.scope) } : {}),
            }] : [];
          }),
        }
      : workflowCapabilityPolicy(input.scope);
    const encoded = JSON.stringify(desiredPolicy);
    if (Buffer.byteLength(encoded, "utf8") > 10_240) {
      throw new WorkflowAwsCapabilityError(["iam:PutRolePolicy"], "The canonical workflow capability policy exceeds the IAM inline-policy size limit.");
    }
    // This retired, project-specific policy predates the canonical capability
    // contract. Keeping it consumes the role's aggregate 10 KiB inline-policy
    // quota and can prevent the replacement policy from being written. Remove
    // only this known DeployGuard-owned policy; unrelated role policies remain
    // untouched and effective permissions are re-simulated below.
    for (const policyName of RETIRED_POLICY_NAMES) {
      try {
        await input.client.send(new GetRolePolicyCommand({ RoleName: input.roleName, PolicyName: policyName }), { abortSignal: input.abortSignal });
        await input.client.send(new DeleteRolePolicyCommand({ RoleName: input.roleName, PolicyName: policyName }), { abortSignal: input.abortSignal });
        reconciled = true;
      } catch (error) {
        if ((error as { name?: string })?.name !== "NoSuchEntityException") {
          throw new WorkflowAwsCapabilityError(["iam:DeleteRolePolicy"], `DeployGuard could not retire its obsolete execution-role policy: ${error instanceof Error ? error.message : "unknown IAM error"}`);
        }
      }
    }
    if (canonicalJson(existingPolicy) !== canonicalJson(desiredPolicy)) {
      try {
        await input.client.send(new PutRolePolicyCommand({ RoleName: input.roleName, PolicyName: POLICY_NAME, PolicyDocument: encoded }), { abortSignal: input.abortSignal });
        reconciled = true;
      } catch (error) {
        throw new WorkflowAwsCapabilityError(["iam:PutRolePolicy"], `DeployGuard could not reconcile its managed execution-role policy: ${error instanceof Error ? error.message : "unknown IAM error"}`);
      }
    }
    try {
      const readBack = decodedPolicy((await input.client.send(new GetRolePolicyCommand({
        RoleName: input.roleName,
        PolicyName: POLICY_NAME,
      }), { abortSignal: input.abortSignal })).PolicyDocument);
      if (canonicalJson(readBack) !== canonicalJson(desiredPolicy)) {
        throw new Error("live policy differs from the canonical render");
      }
    } catch (error) {
      throw new WorkflowAwsCapabilityError(["iam:GetRolePolicy"], `DeployGuard could not verify the reconciled execution-role policy: ${error instanceof Error ? error.message : "unknown IAM error"}`);
    }
  }

  if (input.platformManaged) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      missing = await verifyEffectiveWorkflowCapabilities(input.client, input.roleArn, input.scope, input.action, capabilities, input.abortSignal);
      if (!missing.length) break;
    }
  }
  if (missing.length) {
    throw new WorkflowAwsCapabilityError(missing, input.platformManaged
      ? "The managed execution-role policy was reconciled but effective IAM simulation still denies required operations."
      : "The externally managed execution role does not satisfy the current workflow capability contract.");
  }
  return { reconciled, contractVersion: WORKFLOW_AWS_CAPABILITY_CONTRACT_VERSION, fingerprint: workflowCapabilityFingerprint() };
}

@Injectable()
export class GithubActionsAwsCapabilityService {
  private readonly inFlight = new Map<string, Promise<ReturnType<typeof reconcileWorkflowCapabilities> extends Promise<infer T> ? T : never>>();

  constructor(private readonly config: ConfigService) {}

  async ensure(input: Omit<WorkflowAwsCapabilityScope, "accountId" | "region" | "terraformStateBucket" | "vpcId"> & { action: WorkflowLifecycleAction }) {
    const runtimeContract = workflowCapabilityRuntimeStatus();
    if (runtimeContract.stale) {
      throw new WorkflowAwsCapabilityError(["stale-capability-contract"], "The running backend predates the current AWS capability contract. Restart DeployGuard before dispatch.");
    }
    const roleArn = this.config.get<string>("DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN", "").trim();
    const match = /^arn:aws:iam::(\d{12}):role\/(.+)$/.exec(roleArn);
    if (!match) throw new WorkflowAwsCapabilityError(["execution-role"], "The configured GitHub Actions execution-role ARN is invalid.");
    const scope: WorkflowAwsCapabilityScope = {
      ...input,
      accountId: match[1],
      region: this.config.get<string>("AWS_REGION", "us-east-1"),
      terraformStateBucket: this.config.get<string>("DEPLOYGUARD_TERRAFORM_STATE_BUCKET", ""),
      vpcId: this.config.get<string>("DEPLOYGUARD_VPC_ID", "").trim(),
    };
    if (!scope.terraformStateBucket) throw new WorkflowAwsCapabilityError(["terraform-state-bucket"], "The Terraform state bucket is not configured.");
    if (!/^vpc-[0-9a-f]+$/i.test(scope.vpcId)) throw new WorkflowAwsCapabilityError(["vpc"], "The configured DeployGuard VPC identity is invalid.");
    const key = `${roleArn}:${input.action}:${input.projectId}:${input.environmentName}:${input.generationId}`;
    const active = this.inFlight.get(key);
    if (active) return active;
    const client = new IAMClient({ region: scope.region });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    timeout.unref();
    const task = reconcileWorkflowCapabilities({
      client,
      roleArn,
      roleName: match[2].split("/").pop()!,
      scope,
      action: input.action,
      platformManaged: this.config.get<string>("DEPLOYGUARD_GITHUB_ACTIONS_ROLE_MANAGEMENT", "external") === "platform",
      abortSignal: controller.signal,
    }).finally(() => { clearTimeout(timeout); client.destroy(); });
    this.inFlight.set(key, task);
    try { return await task; } finally { if (this.inFlight.get(key) === task) this.inFlight.delete(key); }
  }
}
