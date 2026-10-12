import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { BadRequestException } from "@nestjs/common";

const execFileAsync = promisify(execFile);
export function repairSandboxArguments(sourceDirectory: string, image: string, command: string[], name: string) {
  if (!/^[a-zA-Z0-9._/:\-]+@sha256:[a-f0-9]{64}$/.test(image) || !Array.isArray(command) || !command.length || command.length > 20 || command.some((argument) => typeof argument !== "string" || !argument || argument.length > 500 || argument.includes("\0"))) throw new BadRequestException("Repair requires an approved digest-pinned sandbox image and configured test command.");
  return ["run", "--name", name, "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534", "--pids-limit", "64", "--cpus", "1", "--memory", "512m", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--tmpfs", "/workspace:rw,nosuid,size=512m", "--mount", `type=bind,source=${sourceDirectory},target=/source,readonly`, "--workdir", "/workspace", "--entrypoint", "/bin/sh", image, "-c", 'cp -R /source/. /workspace/ && exec "$@"', "repair-check", ...command];
}
export async function runRepairSandbox(sourceDirectory: string, image: string, command: string[], runner: typeof execFileAsync = execFileAsync) {
  const name = `deployguard-repair-${randomUUID()}`;
  const args = repairSandboxArguments(sourceDirectory, image, command, name);
  try {
    await runner("docker", args, { timeout: 300000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH || "/usr/bin:/bin" } });
    return { status: "PASSED", exitCode: 0 };
  } catch (error: any) {
    if (error.killed || error.code === "ENOENT" || typeof error.code !== "number" || error.code === 125 || error.code === 126 || error.code === 127) return { status: "UNVERIFIED", reason: "The isolated sandbox or test command could not complete." };
    return { status: "FAILED", exitCode: error.code };
  } finally { await runner("docker", ["rm", "-f", name], { timeout: 15000, maxBuffer: 65536, env: { PATH: process.env.PATH || "/usr/bin:/bin" } }).catch(() => undefined); }
}
