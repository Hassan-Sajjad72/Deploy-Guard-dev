import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class RepositorySourceError extends Error {
  constructor(message: string, readonly safeDetail: string) {
    super(message);
    this.name = "RepositorySourceError";
  }
}

/** Repository transport only; Railpack alone interprets application source. */
@Injectable()
export class RepositorySourceService {
  private readonly logger = new Logger(RepositorySourceService.name);

  async checkout(input: { repositoryUrl: string; branch: string; accessToken?: string | null }) {
    this.validateRepositoryUrl(input.repositoryUrl);
    const workspacePath = await mkdtemp(join(tmpdir(), "deploy-guard-source-"));
    try {
      await execFileAsync("git", ["clone", "--depth", "1", "--branch", input.branch, input.repositoryUrl, workspacePath], {
        timeout: 120_000, maxBuffer: 1024 * 1024, env: this.gitEnvironment(input.accessToken),
      });
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, timeout: 10_000 });
      const sourceSha = stdout.trim();
      if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new RepositorySourceError("Source checkout did not resolve an exact Git SHA.", "source SHA was unavailable");
      return { workspacePath, sourceSha };
    } catch (error) {
      await this.cleanup(workspacePath);
      this.logger.warn(`Source checkout failed for branch=${input.branch}`);
      if (error instanceof RepositorySourceError) throw error;
      throw new RepositorySourceError("Unable to checkout the selected repository branch.", "repository checkout failed");
    }
  }

  async resolveSourceSha(input: { repositoryUrl: string; branch: string; accessToken?: string | null }) {
    this.validateRepositoryUrl(input.repositoryUrl);
    const { stdout } = await execFileAsync("git", ["ls-remote", "--refs", input.repositoryUrl, `refs/heads/${input.branch}`], {
      timeout: 30_000, maxBuffer: 1024 * 1024, env: this.gitEnvironment(input.accessToken),
    });
    const sourceSha = stdout.trim().split(/\s+/)[0] || "";
    if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new RepositorySourceError("Selected branch was not found.", "branch could not be resolved");
    return sourceSha;
  }

  async cleanup(workspacePath: string) { await rm(workspacePath, { recursive: true, force: true }); }

  private gitEnvironment(accessToken?: string | null) {
    const token = accessToken?.trim();
    return token ? {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    } : process.env;
  }

  private validateRepositoryUrl(repositoryUrl: string) {
    if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/.test(repositoryUrl)) throw new BadRequestException("repositoryUrl must be a GitHub repository URL");
  }
}
