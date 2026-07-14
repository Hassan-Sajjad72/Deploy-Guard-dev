import { Injectable } from "@nestjs/common";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

@Injectable()
export class DockerBuildService {
  async isDockerAvailable() {
    try {
      await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], {
        timeout: 15000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async buildImage(input: { workspacePath: string; imageName: string; imageTag: string }) {
    await execFileAsync(
      "docker",
      ["build", "-t", `${input.imageName}:${input.imageTag}`, input.workspacePath],
      {
        timeout: 10 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
      }
    );
  }

  async tagImage(input: {
    localImageName: string;
    imageTag: string;
    ecrImageUri: string;
  }) {
    await execFileAsync(
      "docker",
      ["tag", `${input.localImageName}:${input.imageTag}`, input.ecrImageUri],
      {
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      }
    );
  }

  async pushImage(ecrImageUri: string) {
    await execFileAsync("docker", ["push", ecrImageUri], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
  }
}
