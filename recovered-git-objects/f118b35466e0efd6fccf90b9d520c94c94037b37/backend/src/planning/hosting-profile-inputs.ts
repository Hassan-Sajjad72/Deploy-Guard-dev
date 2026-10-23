import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type HostingProfileInputs = Record<string, unknown>;
export function validateProfileInputs(value: unknown): HostingProfileInputs {
  if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 250000) throw new BadRequestException("A bounded profile-specific configuration is required.");
  const visit = (item: any, depth: number) => {
    if (depth > 20) throw new BadRequestException("Profile configuration exceeds the nesting limit.");
    if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key) || /^(credentials?|password|private.?key|access.?key|secret.?access.?key|session.?token)$/i.test(key)) throw new BadRequestException("Plaintext credentials cannot be included in deployment plans.");
      visit(child, depth + 1);
    }
  };
  visit(value, 0); return structuredClone(value as HostingProfileInputs);
}
const filenames = ["contracts.mjs", "compute.mjs", "serverless.mjs", "index.mjs", "runtime.mjs", "provider-evidence.mjs"];
export function hostingArtifactsRoot() { return resolve(__dirname, "../../../infrastructure/hosting-profiles"); }
export async function hostingExecutableFingerprint() {
  const hashes: Record<string, string> = {};
  for (const file of filenames) hashes[file] = createHash("sha256").update(await readFile(resolve(hostingArtifactsRoot(), file))).digest("hex");
  // Backend authorization is also part of the exact executable proof, not just generated Terraform.
  for (const file of ["hosting-provider-session.service", "hosting-provider-adapter.service", "hosting-profile-inputs"]) {
    const path = resolve(__dirname, `${file}.${__filename.endsWith(".ts") ? "ts" : "js"}`);
    hashes[`backend/${file}`] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  return hashes;
}
export async function loadHostingArtifacts(): Promise<any> {
  // Native import preserves ESM under the existing CommonJS Nest build.
  return new Function("path", "return import(path)")(`file://${resolve(hostingArtifactsRoot(), "index.mjs")}`);
}
export async function loadHostingRuntime(): Promise<any> { return new Function("path", "return import(path)")(`file://${resolve(hostingArtifactsRoot(), "runtime.mjs")}`); }
export async function loadHostingEvidence(): Promise<any> { return new Function("path", "return import(path)")(`file://${resolve(hostingArtifactsRoot(), "provider-evidence.mjs")}`); }
