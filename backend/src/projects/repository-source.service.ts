import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { execFile } from "child_process";
import { lstat, mkdtemp, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { resolveServicePorts } from "./service-port-resolver";

const execFileAsync = promisify(execFile);

export class RepositorySourceError extends Error {
  constructor(message: string, readonly safeDetail: string) {
    super(message);
    this.name = "RepositorySourceError";
  }
}

/** Repository transport plus bounded canonical-directory validation and application-port resolution. */
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

  async assertDirectoriesAtExactSha(input: { repositoryUrl: string; branch: string; sourceSha: string; services: Array<{ serviceId: string; serviceDirectory: string }>; accessToken?: string | null }) {
    if (!/^[0-9a-f]{40}$/i.test(input.sourceSha)) throw new RepositorySourceError("Exact source identity is invalid.", "source SHA was invalid");
    const checkout = await this.checkout({ repositoryUrl: input.repositoryUrl, branch: input.branch, accessToken: input.accessToken });
    try {
      if (checkout.sourceSha.toLowerCase() !== input.sourceSha.toLowerCase()) throw new RepositorySourceError("Selected branch changed while preparing deployment. Retry against the new exact SHA.", "source SHA changed before directory validation");
      const root = await realpath(checkout.workspacePath);
      for (const service of input.services) {
        const directory = service.serviceDirectory;
        const candidate = directory === "." ? root : join(root, ...directory.split("/"));
        let resolved: string;
        try {
          const entry = await lstat(candidate);
          if (!entry.isDirectory() && !entry.isSymbolicLink()) throw new Error("not-directory");
          resolved = await realpath(candidate);
        } catch {
          throw new RepositorySourceError(`Configured service directory '${directory}' does not exist at source ${input.sourceSha.slice(0, 12)}.`, `DG_FAILURE serviceId=${service.serviceId} code=DG_SERVICE_DIRECTORY_MISSING stage=service_directory_validation`);
        }
        if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new RepositorySourceError(`Configured service directory '${directory}' escapes the repository.`, `DG_FAILURE serviceId=${service.serviceId} code=DG_SERVICE_DIRECTORY_INVALID stage=service_directory_validation`);
      }
    } finally {
      await this.cleanup(checkout.workspacePath);
    }
  }

  async resolveServicePortsAtExactSha(input: { repositoryUrl: string; branch: string; sourceSha: string; services: Array<{ serviceId: string; serviceDirectory: string }>; accessToken?: string | null }) {
    if (!/^[0-9a-f]{40}$/i.test(input.sourceSha)) throw new RepositorySourceError("Exact source identity is invalid.", "source SHA was invalid");
    const checkout = await this.checkout({ repositoryUrl: input.repositoryUrl, branch: input.branch, accessToken: input.accessToken });
    try {
      if (checkout.sourceSha.toLowerCase() !== input.sourceSha.toLowerCase()) throw new RepositorySourceError("Selected branch changed while resolving application ports. Retry against the new exact SHA.", "source SHA changed before service port resolution");
      const root = await realpath(checkout.workspacePath);
      for (const service of input.services) {
        const candidate = service.serviceDirectory === "." ? root : join(root, ...service.serviceDirectory.split("/"));
        let resolved: string;
        try {
          resolved = await realpath(candidate);
          const entry = await lstat(resolved);
          if (!entry.isDirectory()) throw new Error("not-directory");
        } catch {
          throw new RepositorySourceError(`Configured service directory '${service.serviceDirectory}' does not exist at source ${input.sourceSha.slice(0, 12)}.`, `DG_FAILURE serviceId=${service.serviceId} code=DG_SERVICE_DIRECTORY_MISSING stage=service_directory_validation`);
        }
        if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new RepositorySourceError(`Configured service directory '${service.serviceDirectory}' escapes the repository.`, `DG_FAILURE serviceId=${service.serviceId} code=DG_SERVICE_DIRECTORY_INVALID stage=service_directory_validation`);
      }
      return await resolveServicePorts(root, input.services);
    } finally {
      await this.cleanup(checkout.workspacePath);
    }
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
