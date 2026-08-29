import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const requireBackend = createRequire(new URL("../backend/package.json", import.meta.url));
const dotenv = requireBackend("dotenv");

/**
 * The backend's non-container runtime must receive exactly the same canonical
 * application environment file that Compose injects through `env_file`.
 *
 * `process.loadEnvFile()` intentionally preserves pre-existing shell values.
 * That is useful for generic CLIs, but it made `product:start` depend on a
 * developer's ambient AWS/SNS variables while Compose did not. This loader
 * deliberately overrides ambient values before any child process is started.
 */
export function canonicalBackendEnvFile(root = process.cwd()) {
  return resolve(root, "backend", ".env");
}

export function loadCanonicalBackendEnvironment(root = process.cwd()) {
  const path = canonicalBackendEnvFile(root);
  if (!existsSync(path)) throw new Error(`DeployGuard canonical backend environment is missing: ${path}`);
  const result = dotenv.config({ path, override: true, quiet: true });
  if (result.error) throw result.error;
  return path;
}
