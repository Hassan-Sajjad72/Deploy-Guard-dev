import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class RepositoryCloneError extends Error {
  constructor(
    message: string,
    readonly cloneError: string,
    readonly branchError: string | null = null
  ) {
    super(message);
    this.name = "RepositoryCloneError";
  }
}

@Injectable()
export class RepositoryWorkspaceService {
  private readonly logger = new Logger(RepositoryWorkspaceService.name);

  async cloneRepository(input: {
    repositoryUrl: string;
    targetBranch: string;
    accessToken?: string | null;
  }): Promise<{ workspacePath: string; commitSha: string | null }> {
    this.validateRepositoryUrl(input.repositoryUrl);
    const workspacePath = await mkdtemp(join(tmpdir(), "deploy-guard-detect-"));
    const safeRepositoryUrl = input.repositoryUrl.replace(/\.git\/?$/, "");
    this.logger.log(
      `Cloning repository ${safeRepositoryUrl} branch=${input.targetBranch} workspace=${workspacePath}`
    );

    try {
      const token = input.accessToken?.trim();
      const env = token
        ? {
            ...process.env,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(
              `x-access-token:${token}`
            ).toString("base64")}`,
          }
        : process.env;
      await execFileAsync(
        "git",
        [
          "clone",
          "--depth",
          "1",
          "--branch",
          input.targetBranch,
          input.repositoryUrl,
          workspacePath,
        ],
        { timeout: 120000, maxBuffer: 1024 * 1024, env }
      );

      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
        timeout: 10000,
      });

      const commitSha = stdout.trim() || null;
      this.logger.log(
        `Repository clone succeeded branch=${input.targetBranch} workspace=${workspacePath}`
      );
      return { workspacePath, commitSha };
    } catch (error) {
      await this.cleanup(workspacePath);
      const stderr = String((error as { stderr?: unknown })?.stderr || "");
      const branchMissing = /remote branch .* not found|couldn't find remote ref|not a valid branch/i.test(
        stderr
      );
      const branchError = branchMissing
        ? `Branch '${input.targetBranch}' was not found in the repository.`
        : null;
      const cloneError = branchError
        ? "Repository was reachable, but the selected branch could not be cloned."
        : "Unable to clone repository. Confirm the URL, repository access, and GitHub token permissions.";
      this.logger.warn(
        `Repository clone failed repository=${safeRepositoryUrl} branch=${input.targetBranch} reason=${
          branchMissing ? "branch_not_found" : "clone_failed"
        }`
      );
      throw new RepositoryCloneError(cloneError, cloneError, branchError);
    }
  }

  async resolveRemoteCommit(input: {
    repositoryUrl: string;
    targetBranch: string;
    accessToken?: string | null;
  }) {
    this.validateRepositoryUrl(input.repositoryUrl);
    const token = input.accessToken?.trim();
    const env = token
      ? {
          ...process.env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        }
      : process.env;
    const { stdout } = await execFileAsync(
      "git",
      ["ls-remote", "--refs", input.repositoryUrl, `refs/heads/${input.targetBranch}`],
      { timeout: 30000, maxBuffer: 1024 * 1024, env }
    );
    const commitSha = stdout.trim().split(/\s+/)[0] || null;
    if (!commitSha) throw new RepositoryCloneError("Selected branch was not found.", "Repository branch could not be resolved.", `Branch '${input.targetBranch}' was not found in the repository.`);
    return commitSha;
  }

  async cleanup(workspacePath: string) {
    await rm(workspacePath, { recursive: true, force: true });
  }

  private validateRepositoryUrl(repositoryUrl: string) {
    if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/.test(repositoryUrl)) {
      throw new BadRequestException("repositoryUrl must be a GitHub repository URL");
    }
  }
}
