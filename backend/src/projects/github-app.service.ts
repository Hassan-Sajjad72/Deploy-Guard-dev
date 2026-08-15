import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { createSign } from "crypto";
import { Repository } from "typeorm";
import { GithubAppInstallation } from "./github-app-installation.entity";
import { User, UserRole } from "../users/user.entity";
import { BUILD_PLAN_WORKFLOW_INPUT_NAMES, GITHUB_ACTIONS_CALLER_INPUT_NAMES, GITHUB_ACTIONS_OPTIONAL_CALLER_INPUT_NAMES, GITHUB_ACTIONS_WORKFLOW_INPUTS } from "./github-actions-operation-contract";
import { assertReusableWorkflowCompatibility, generatedCallerWithKeys, GithubActionsWorkflowContractError, parsePinnedReusableWorkflow } from "./github-actions-workflow-contract";

export const DEPLOYGUARD_WORKFLOW_PATH = ".github/workflows/deployguard.yml";
export const DEFAULT_DEPLOYGUARD_REUSABLE_WORKFLOW = "Hassan-Sajjad72/Deploy-Guard-dev/.github/workflows/deployguard-reusable.yml@4e4e7490f0aed8d735666977cb1a4506ef02eebf";

export function renderDeployguardCallerWorkflow(reusable: string) {
  const names = [...GITHUB_ACTIONS_CALLER_INPUT_NAMES];
  const optional = new Set<string>(GITHUB_ACTIONS_OPTIONAL_CALLER_INPUT_NAMES);
  const inputDefinitions = names.map((name) => {
    const defaultValue = name === "rollback_release_json" ? ', default: "{}"' : optional.has(name) ? ', default: ""' : "";
    return `      ${name}: { required: ${optional.has(name) ? "false" : "true"}, type: string${defaultValue} }`;
  }).join("\n");
  const forwarded = GITHUB_ACTIONS_WORKFLOW_INPUTS.map(({ name }) => {
    if (BUILD_PLAN_WORKFLOW_INPUT_NAMES.includes(name as typeof BUILD_PLAN_WORKFLOW_INPUT_NAMES[number])) {
      return `      ${name}: \${{ fromJSON(inputs.build_plan_contract_json).${name} }}`;
    }
    if (name === "rollback_source_operation_id") return `      ${name}: \${{ fromJSON(inputs.rollback_release_json).sourceOperationId || '' }}`;
    if (name === "rollback_image_uri") return `      ${name}: \${{ fromJSON(inputs.rollback_release_json).imageUri || '' }}`;
    if (name === "rollback_task_definition_arn") return `      ${name}: \${{ fromJSON(inputs.rollback_release_json).taskDefinitionArn || '' }}`;
    return `      ${name}: \${{ inputs.${name} }}`;
  }).join("\n");
  return `name: DeployGuard\non:\n  workflow_dispatch:\n    inputs:\n${inputDefinitions}\npermissions:\n  contents: read\n  id-token: write\njobs:\n  deploy:\n    uses: ${reusable}\n    with:\n${forwarded}\n`;
}

@Injectable()
export class GithubAppService {
  constructor(
    @InjectRepository(GithubAppInstallation) private readonly installations: Repository<GithubAppInstallation>,
    private readonly config: ConfigService,
  ) {}

  statusUrl() {
    const slug = this.config.get<string>("GITHUB_APP_SLUG")?.trim();
    return slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : null;
  }

  configured() {
    return Boolean(this.config.get<string>("GITHUB_APP_ID")?.trim() && this.config.get<string>("GITHUB_APP_PRIVATE_KEY")?.trim() && this.statusUrl());
  }

  async connectInstallation(user: User, installationId: string) {
    if (!/^\d+$/.test(installationId || "")) throw new BadRequestException("Invalid GitHub App installation id.");
    const response = await fetch(`https://api.github.com/app/installations/${installationId}`, { headers: this.headers(this.appJwt()) });
    if (!response.ok) throw new BadRequestException("GitHub App installation could not be verified.");
    const body = await response.json() as { account?: { login?: string; id?: number } };
    const accountLogin = String(body.account?.login || "").trim();
    if (!accountLogin) throw new BadRequestException("GitHub App installation has no account identity.");
    const existing = await this.installations.findOne({ where: { ownerUserId: user.id, installationId } });
    const row = this.installations.create({
      ...(existing || {}), ownerUserId: user.id, installationId, accountLogin,
      accountId: body.account?.id ? String(body.account.id) : null, status: "active",
    });
    return this.installations.save(row);
  }

  async availableInstallations(user: User) {
    if (!this.configured()) return [];
    const response = await fetch("https://api.github.com/app/installations?per_page=100", { headers: this.headers(this.appJwt()) });
    if (!response.ok) throw new BadRequestException("Existing GitHub App installations could not be loaded.");
    const body = await response.json() as Array<{ id?: number; account?: { login?: string; id?: number }; repository_selection?: string; suspended_at?: string | null }>;
    const connected = new Set((await this.installations.find({ where: { ownerUserId: user.id, status: "active" } })).map((row) => row.installationId));
    return body
      .filter((installation) => !installation.suspended_at)
      .filter((installation) => user.role === UserRole.ADMIN || (user.githubLogin && installation.account?.login?.toLowerCase() === user.githubLogin.toLowerCase()))
      .map((installation) => ({
        installationId: String(installation.id || ""),
        accountLogin: String(installation.account?.login || ""),
        repositorySelection: String(installation.repository_selection || "selected"),
        connected: connected.has(String(installation.id || "")),
      }))
      .filter((installation) => installation.installationId && installation.accountLogin);
  }

  async listRepositories(userId: number) {
    const rows = await this.installations.find({ where: { ownerUserId: userId, status: "active" } });
    const repositories: Array<Record<string, unknown> & { installationId: string }> = [];
    for (const row of rows) {
      const token = await this.createInstallationToken(row.installationId);
      const response = await fetch("https://api.github.com/installation/repositories?per_page=100", { headers: this.headers(token) });
      if (!response.ok) throw new BadRequestException("GitHub App repository access could not be loaded.");
      const body = await response.json() as { repositories?: Array<Record<string, unknown>> };
      for (const repository of body.repositories || []) repositories.push({ ...repository, installationId: row.installationId });
    }
    return repositories;
  }

  async tokenForRepository(userId: number, repositoryFullName: string, preferredInstallationId?: string | null) {
    const rows = preferredInstallationId
      ? await this.installations.find({ where: { ownerUserId: userId, installationId: preferredInstallationId, status: "active" } })
      : await this.installations.find({ where: { ownerUserId: userId, status: "active" } });
    for (const row of rows) {
      const token = await this.createInstallationToken(row.installationId);
      const response = await fetch(`https://api.github.com/repos/${repositoryFullName}`, { headers: this.headers(token) });
      if (response.ok) {
        const repository = await response.json() as { id?: number };
        return { token, installationId: row.installationId, repositoryId: repository.id ? String(repository.id) : null };
      }
    }
    throw new BadRequestException("Install the DeployGuard GitHub App for this repository before continuing.");
  }

  async oidcTrustSubject(userId: number, repositoryFullName: string, preferredInstallationId?: string | null) {
    const credential = await this.tokenForRepository(userId, repositoryFullName, preferredInstallationId);
    const response = await fetch(`https://api.github.com/app/installations/${credential.installationId}`, { headers: this.headers(this.appJwt()) });
    if (!response.ok) throw new BadRequestException("GitHub App installation scope could not be verified for AWS authorization.");
    const installation = await response.json() as { account?: { login?: string; id?: number }; repository_selection?: string };
    const [owner, repositoryName] = repositoryFullName.split("/");
    const account = String(installation.account?.login || "");
    const accountId = installation.account?.id ? String(installation.account.id) : "";
    if (!account || !accountId || !credential.repositoryId || account.toLowerCase() !== owner.toLowerCase()) {
      throw new BadRequestException("GitHub App installation identity could not be verified for AWS authorization.");
    }
    // This GitHub account uses OIDC's repository-identity customization, whose
    // subject contains immutable account/repository IDs (owner@id/repo@id).
    // An all-repositories App installation therefore maps safely to that one
    // account, while a selected-repositories installation maps to one repo.
    return installation.repository_selection === "all"
      ? `repo:${account}@${accountId}/*:*`
      : `repo:${account}@${accountId}/${repositoryName}@${credential.repositoryId}:*`;
  }

  async ensureWorkflow(userId: number, repositoryFullName: string, branch: string, installationId?: string | null) {
    const credential = await this.tokenForRepository(userId, repositoryFullName, installationId);
    const reusable = this.config.get<string>("DEPLOYGUARD_REUSABLE_WORKFLOW", DEFAULT_DEPLOYGUARD_REUSABLE_WORKFLOW);
    const content = renderDeployguardCallerWorkflow(reusable);
    await this.validatePinnedReusableWorkflow(credential.token, reusable, content);
    const url = `https://api.github.com/repos/${repositoryFullName}/contents/${DEPLOYGUARD_WORKFLOW_PATH}?ref=${encodeURIComponent(branch)}`;
    let response = await fetch(url, { headers: this.headers(credential.token) });
    let existingSha: string | undefined;
    if (response.ok) {
      const existing = await response.json() as { content?: string; encoding?: string; sha?: string };
      const existingContent = existing.encoding === "base64" && existing.content
        ? Buffer.from(existing.content.replace(/\n/g, ""), "base64").toString("utf8")
        : "";
      if (existingContent === content) return { verified: true, generated: false, updated: false, path: DEPLOYGUARD_WORKFLOW_PATH, installationId: credential.installationId };
      if (!/^name: DeployGuard\n/.test(existingContent) || !/Deploy-Guard-dev\/\.github\/workflows\/deployguard-reusable\.yml@/.test(existingContent)) {
        throw new BadRequestException("The DeployGuard workflow path is not managed by DeployGuard.");
      }
      existingSha = existing.sha;
    } else if (response.status !== 404) {
      throw new BadRequestException("DeployGuard workflow could not be verified.");
    }
    response = await fetch(`https://api.github.com/repos/${repositoryFullName}/contents/${DEPLOYGUARD_WORKFLOW_PATH}`, {
      method: "PUT", headers: { ...this.headers(credential.token), "Content-Type": "application/json" },
      body: JSON.stringify({ message: existingSha ? "chore: update DeployGuard deployment workflow" : "chore: add DeployGuard deployment workflow", content: Buffer.from(content).toString("base64"), branch, ...(existingSha ? { sha: existingSha } : {}) }),
    });
    if (!response.ok) throw new BadRequestException("DeployGuard could not generate deployguard.yml. Grant Contents write permission to the GitHub App.");
    return { verified: true, generated: !existingSha, updated: Boolean(existingSha), path: DEPLOYGUARD_WORKFLOW_PATH, installationId: credential.installationId };
  }

  async removeManagedWorkflow(userId: number, repositoryFullName: string, branch: string, installationId?: string | null) {
    const credential = await this.tokenForRepository(userId, repositoryFullName, installationId);
    const url = `https://api.github.com/repos/${repositoryFullName}/contents/${DEPLOYGUARD_WORKFLOW_PATH}?ref=${encodeURIComponent(branch)}`;
    const existingResponse = await fetch(url, { headers: this.headers(credential.token) });
    if (existingResponse.status === 404) return credential.token;
    if (!existingResponse.ok) throw new Error("The DeployGuard caller workflow could not be inspected for project deletion.");
    const existing = await existingResponse.json() as { content?: string; encoding?: string; sha?: string };
    const content = existing.encoding === "base64" && existing.content
      ? Buffer.from(existing.content.replace(/\n/g, ""), "base64").toString("utf8")
      : "";
    if (!existing.sha || !/^name: DeployGuard\n/.test(content) || !/Deploy-Guard-dev\/\.github\/workflows\/deployguard-reusable\.yml@[0-9a-f]{40}/.test(content)) {
      throw new Error("The caller workflow is not proven DeployGuard-owned.");
    }
    const deletion = await fetch(`https://api.github.com/repos/${repositoryFullName}/contents/${DEPLOYGUARD_WORKFLOW_PATH}`, {
      method: "DELETE",
      headers: { ...this.headers(credential.token), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "chore: remove deleted DeployGuard project workflow", sha: existing.sha, branch }),
    });
    if (!deletion.ok) throw new Error("The DeployGuard caller workflow could not be removed for project deletion.");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const verification = await fetch(url, { headers: this.headers(credential.token) });
      if (verification.status === 404) return credential.token;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("The DeployGuard caller workflow remains present after project deletion.");
  }

  private async validatePinnedReusableWorkflow(token: string, reusable: string, caller: string) {
    try {
      const pinned = parsePinnedReusableWorkflow(reusable);
      const response = await fetch(
        `https://api.github.com/repos/${pinned.owner}/${pinned.repository}/contents/${pinned.path}?ref=${pinned.sha}`,
        { headers: this.headers(token) },
      );
      if (!response.ok) {
        throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} is not accessible (HTTP ${response.status}).`);
      }
      const body = await response.json() as { content?: string; encoding?: string };
      const workflow = body.encoding === "base64" && body.content
        ? Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8")
        : "";
      assertReusableWorkflowCompatibility(workflow, pinned, generatedCallerWithKeys(caller));
    } catch (error) {
      const message = error instanceof GithubActionsWorkflowContractError
        ? error.message
        : "Reusable workflow contract mismatch: pinned workflow validation failed.";
      throw new ServiceUnavailableException({ code: "reusable_workflow_contract_mismatch", message });
    }
  }

  private async createInstallationToken(installationId: string) {
    const jwt = this.appJwt();
    const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, { method: "POST", headers: this.headers(jwt) });
    if (!response.ok) throw new BadRequestException("GitHub App installation token could not be created.");
    const body = await response.json() as { token?: string };
    if (!body.token) throw new BadRequestException("GitHub returned an empty installation token.");
    return body.token;
  }

  private appJwt() {
    const appId = this.config.get<string>("GITHUB_APP_ID")?.trim();
    const privateKey = this.config.get<string>("GITHUB_APP_PRIVATE_KEY")?.replace(/\\n/g, "\n");
    if (!appId || !privateKey) throw new BadRequestException("GitHub App is not configured.");
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 30, exp: now + 540, iss: appId })}`;
    const signer = createSign("RSA-SHA256"); signer.update(unsigned); signer.end();
    return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
  }

  private headers(token: string) { return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "Deploy-Guard", "X-GitHub-Api-Version": "2022-11-28" }; }
}
