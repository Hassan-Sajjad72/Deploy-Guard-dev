import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GetRoleCommand, IAMClient, UpdateAssumeRolePolicyCommand } from "@aws-sdk/client-iam";

export type TrustStatement = {
  Effect?: string;
  Action?: string | string[];
  Principal?: { Federated?: string | string[] };
  Condition?: Record<string, Record<string, string | string[]>>;
};

export type TrustPolicy = { Version?: string; Statement?: TrustStatement | TrustStatement[] };

const values = (value: string | string[] | undefined) => Array.isArray(value) ? value : value ? [value] : [];
const githubOidcStatement = (policy: TrustPolicy) => {
  const statements = Array.isArray(policy.Statement) ? policy.Statement : policy.Statement ? [policy.Statement] : [];
  const statement = statements.find((candidate) => {
    const actions = values(candidate.Action);
    const principals = values(candidate.Principal?.Federated);
    return candidate.Effect === "Allow"
      && actions.includes("sts:AssumeRoleWithWebIdentity")
      && principals.some((principal) => principal.endsWith("oidc-provider/token.actions.githubusercontent.com"))
      && values(candidate.Condition?.StringEquals?.["token.actions.githubusercontent.com:aud"]).includes("sts.amazonaws.com");
  });
  if (!statement) throw new Error("GitHub OIDC trust statement is missing");
  return statement;
};
const subjects = (statement: TrustStatement) => ["StringLike", "StringEquals"].flatMap((operator) =>
  values(statement.Condition?.[operator]?.["token.actions.githubusercontent.com:sub"]));
const matches = (pattern: string, subject: string) => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(subject);
};

export function authorizeGithubRepositoryInTrust(policy: TrustPolicy, repositoryFullName: string, trustSubject = `repo:${repositoryFullName}:*`) {
  const statement = githubOidcStatement(policy);
  if (subjects(statement).includes(trustSubject)) return false;
  statement.Condition ||= {};
  statement.Condition.StringLike ||= {};
  const equals = statement.Condition.StringEquals || {};
  const existing = values(statement.Condition.StringLike["token.actions.githubusercontent.com:sub"])
    .concat(values(equals["token.actions.githubusercontent.com:sub"]));
  statement.Condition.StringLike["token.actions.githubusercontent.com:sub"] = [...new Set([...existing, trustSubject])];
  if (equals["token.actions.githubusercontent.com:sub"] !== undefined) delete equals["token.actions.githubusercontent.com:sub"];
  return true;
}

export function githubTrustAuthorizesRepository(policy: TrustPolicy, repositoryFullName: string) {
  const subject = `repo:${repositoryFullName}:*`;
  return subjects(githubOidcStatement(policy)).some((candidate) => matches(candidate, subject));
}

export function githubTrustIncludesSubject(policy: TrustPolicy, trustSubject: string) {
  return subjects(githubOidcStatement(policy)).includes(trustSubject);
}

@Injectable()
export class GithubActionsOidcTrustService {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly config: ConfigService) {}

  async ensureRepositoryAuthorized(repositoryFullName: string, trustSubject = `repo:${repositoryFullName}:*`) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
      throw this.platformConfigurationError();
    }
    const active = this.inFlight.get(repositoryFullName);
    if (active) return active;
    if (!/^repo:[A-Za-z0-9_.-]+(?:@\d+)?\/(?:\*|[A-Za-z0-9_.-]+(?:@\d+)?):\*$/.test(trustSubject)) throw this.platformConfigurationError();
    const task = this.ensure(repositoryFullName, trustSubject);
    this.inFlight.set(repositoryFullName, task);
    try { await task; } finally {
      if (this.inFlight.get(repositoryFullName) === task) this.inFlight.delete(repositoryFullName);
    }
  }

  private async ensure(repositoryFullName: string, trustSubject: string) {
    const roleArn = this.config.get<string>("DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN", "").trim();
    const roleName = roleArn.split("/").pop();
    if (!/^arn:aws:iam::\d{12}:role\/.+/.test(roleArn) || !roleName) throw this.platformConfigurationError();
    const client = new IAMClient({ region: this.config.get<string>("AWS_REGION", "us-east-1") });
    try {
      const role = (await client.send(new GetRoleCommand({ RoleName: roleName }))).Role;
      const policy = this.policy(role?.AssumeRolePolicyDocument);
      if (!authorizeGithubRepositoryInTrust(policy, repositoryFullName, trustSubject)) return;
      await client.send(new UpdateAssumeRolePolicyCommand({
        RoleName: roleName,
        PolicyDocument: JSON.stringify(policy),
      }));

      const verified = this.policy((await client.send(new GetRoleCommand({ RoleName: roleName }))).Role?.AssumeRolePolicyDocument);
      if (!githubTrustIncludesSubject(verified, trustSubject)) throw new Error("OIDC trust verification failed");
    } catch {
      throw this.platformConfigurationError();
    } finally {
      client.destroy();
    }
  }

  private policy(value: string | undefined): TrustPolicy {
    if (!value) throw new Error("OIDC trust policy is missing");
    try { return JSON.parse(value); } catch {
      return JSON.parse(decodeURIComponent(value.replace(/\+/g, "%20")));
    }
  }

  private platformConfigurationError() {
    return new ServiceUnavailableException("DeployGuard could not authorize this repository with AWS. This is a platform configuration defect; no application credential or project setting is required.");
  }
}
