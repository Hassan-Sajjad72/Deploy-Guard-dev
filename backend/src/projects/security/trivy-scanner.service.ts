import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

@Injectable()
export class TrivyScannerService {
  constructor(private readonly config: ConfigService) {}

  async scanImage(imageName: string) {
    const timeout =
      Number(this.config.get<string>("TRIVY_TIMEOUT_SECONDS", "300")) * 1000;
    const scannerVersion = await this.getVersion();

    try {
      const { stdout } = await execFileAsync(
        "trivy",
        ["image", "--format", "json", "--quiet", imageName],
        {
          timeout,
          maxBuffer: 32 * 1024 * 1024,
        }
      );

      return { scannerVersion, rawJson: stdout };
    } catch (error) {
      throw new Error(this.cleanError(error));
    }
  }

  private async getVersion() {
    try {
      const { stdout } = await execFileAsync("trivy", ["--version"], {
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
      return stdout.split(/\r?\n/)[0]?.trim() || null;
    } catch {
      return null;
    }
  }

  private cleanError(error: unknown) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    const message = `${err.message || ""} ${err.stderr || ""}`;

    if (err.code === "ENOENT" || /ENOENT|executable file not found/i.test(message)) {
      return "Trivy is not installed or not available in PATH.";
    }

    if (/No such image|image not known|unable to inspect|image.*not found|not found.*image/i.test(message)) {
      return "Docker image is missing or not available locally.";
    }

    if (/timed out|timeout/i.test(message)) {
      return "Trivy scan timed out.";
    }

    return "Trivy image scan failed.";
  }
}
