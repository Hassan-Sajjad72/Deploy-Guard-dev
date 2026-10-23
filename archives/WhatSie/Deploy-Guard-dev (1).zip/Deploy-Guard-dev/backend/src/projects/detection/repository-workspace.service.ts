import { BadRequestException, Injectable } from "@nestjs/common";
import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

@Injectable()
export class RepositoryWorkspaceService {
  async cloneRepository(input: {
    repositoryUrl: string;
    targetBranch: string;
  }): Promise<{ workspacePath: string; commitSha: string | null }> {
    this.validateRepositoryUrl(input.repositoryUrl);
    const workspacePath = await mkdtemp(join(tmpdir(), "deploy-guard-detect-"));

    try {
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
        { timeout: 120000, maxBuffer: 1024 * 1024 }
      );

      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
        timeout: 10000,
      });

      return { workspacePath, commitSha: stdout.trim() || null };
    } catch {
      await this.cleanup(workspacePath);
      throw new BadRequestException(
        "Unable to clone repository. Confirm the repository is public, the branch exists, and the URL is valid."
      );
    }
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
