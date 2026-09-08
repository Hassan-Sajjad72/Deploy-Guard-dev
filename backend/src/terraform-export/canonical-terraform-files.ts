import { readFile } from "fs/promises";
import { resolve } from "path";

export const CANONICAL_TERRAFORM_EXPORT_FILES = ["main.tf", "variables.tf", "outputs.tf"] as const;

export async function loadCanonicalTerraformFiles(candidateDirectories: string[]) {
  for (const directory of candidateDirectories) {
    try {
      return await Promise.all(CANONICAL_TERRAFORM_EXPORT_FILES.map(async (path) => ({ path, content: await readFile(resolve(directory, path)) })));
    } catch {
      // The complete canonical module must be available from one runtime location.
    }
  }
  throw new Error("Canonical Terraform runtime files are unavailable.");
}
