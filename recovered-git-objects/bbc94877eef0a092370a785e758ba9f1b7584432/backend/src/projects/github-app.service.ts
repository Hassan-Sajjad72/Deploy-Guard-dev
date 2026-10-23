import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { createSign } from "crypto";
import { Repository } from "typeorm";
import { GithubAppInstallation } from "./github-app-installation.entity";
import { User } from "../users/user.entity";

export const DEPLOYGUARD_WORKFLOW_PATH = ".github/workflows/deployguard.yml";

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
    const existing = await this.installations.findOne({ where: { installationId } });
    const row = this.installations.create({
      ...(existing || {}), ownerUserId: user.id, installationId, accountLogin,
      accountId: body.account?.id ? String(body.account.id) : null, status: "active",
    });
    return this.installations.save(row);
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
      if (response.ok) return { token, installationId: row.installationId };
    }
    throw new BadRequestException("Install the DeployGuard GitHub App for this repository before continuing.");
  }

  async ensureWorkflow(userId: number, repositoryFullName: string, branch: string, installationId?: string | null) {
    const credential = await this.tokenForRepository(userId, repositoryFullName, installationId);
    const url = `https://api.github.com/repos/${repositoryFullName}/contents/${DEPLOYGUARD_WORKFLOW_PATH}?ref=${encodeURIComponent(branch)}`;
    let response = await fetch(url, { headers: this.headers(credential.token) });
    if (response.ok) return { verified: true, generated: false, path: DEPLOYGUARD_WORKFLOW_PATH, installationId: credential.installationId };
    if (response.status !== 404) throw new BadRequestException("DeployGuard workflow could not be verified.");
    const reusable = this.config.get<string>("DEPLOYGUARD_REUSABLE_WORKFLOW", "deployguard/deployguard/.github/workflows/deploy.yml@v1");
    const content = `name: DeployGuard\non:\n  workflow_dispatch:\n    inputs:\n      deployment_operation_id:\n        required: false\n        type: string\njobs:\n  deploy:\n    uses: ${reusable}\n    secrets: inherit\n`;
    response = await fetch(`https://api.github.com/repos/${repositoryFullName}/contents/${DEPLOYGUARD_WORKFLOW_PATH}`, {
      method: "PUT", headers: { ...this.headers(credential.token), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "chore: add DeployGuard deployment workflow", content: Buffer.from(content).toString("base64"), branch }),
    });
    if (!response.ok) throw new BadRequestException("DeployGuard could not generate deployguard.yml. Grant Contents write permission to the GitHub App.");
    return { verified: true, generated: true, path: DEPLOYGUARD_WORKFLOW_PATH, installationId: credential.installationId };
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
