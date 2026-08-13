import { existsSync } from "fs";
import { resolve } from "path";

export function resolveBackendEnvFile(cwd = process.cwd(), moduleDirectory = __dirname) {
  const candidates = [
    resolve(cwd, "backend", ".env"),
    resolve(cwd, ".env"),
    resolve(moduleDirectory, "..", "..", ".env"),
    resolve(moduleDirectory, "..", "..", "..", ".env"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) || candidates[1];
}
