import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CANONICAL_TERRAFORM_EXPORT_FILES, loadCanonicalTerraformFiles } from "../src/terraform-export/canonical-terraform-files";
import { buildDeterministicZip } from "../src/terraform-export/zip-builder";

async function main() {
  const files = [{ path: "main.tf", content: Buffer.from("terraform {}") }, { path: "README.md", content: Buffer.from("safe") }];
  const first = buildDeterministicZip(files);
  const second = buildDeterministicZip([...files].reverse());
  assert(first.equals(second));
  assert.equal(first.readUInt32LE(0), 0x04034b50);
  assert(first.includes(Buffer.from("main.tf")));
  assert(first.includes(Buffer.from("terraform {}")));

  const repositoryRoot = resolve(__dirname, "../..");
  const canonicalDirectory = join(repositoryRoot, "infrastructure", "railpack-runtime");
  const exported = await loadCanonicalTerraformFiles([canonicalDirectory]);
  assert.deepEqual(exported.map((file) => file.path), CANONICAL_TERRAFORM_EXPORT_FILES);
  for (const file of exported) assert(file.content.equals(await readFile(join(canonicalDirectory, file.path))), `${file.path} must be exported unchanged`);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "deployguard-terraform-export-"));
  try {
    const incomplete = join(temporaryRoot, "incomplete");
    await mkdir(incomplete);
    await writeFile(join(incomplete, "main.tf"), "terraform {}\n");
    await assert.rejects(() => loadCanonicalTerraformFiles([incomplete]), /Canonical Terraform runtime files are unavailable/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const service = await readFile(join(repositoryRoot, "backend", "src", "terraform-export", "terraform-export.service.ts"), "utf8");
  assert.doesNotMatch(service, /deployguard-reusable\.yml|<<'TERRAFORM'/, "Terraform export must not parse workflow-embedded Terraform");
  const dockerfile = await readFile(join(repositoryRoot, "backend", "Dockerfile"), "utf8");
  for (const path of CANONICAL_TERRAFORM_EXPORT_FILES) assert.match(dockerfile, new RegExp(`COPY infrastructure/railpack-runtime/${path.replace(".", "\\.")}`));

  console.log("Terraform export canonical-runtime verification passed");
}

void main();
