import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const digestPattern = /^sha256:[a-f0-9]{64}$/;
type Descriptor = { mediaType: string; digest: string; size: number };

async function fileDigest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

// Reads the single-platform manifest descriptor from a buildx OCI archive without trusting its claims.
export async function ociArchiveManifest(archive: string) {
  const { stdout } = await run("tar", ["-xOf", archive, "index.json"], { maxBuffer: 1024 * 1024 });
  const index = JSON.parse(stdout);
  const manifest: Descriptor | undefined = index?.manifests?.[0];
  if (index?.manifests?.length !== 1 || !digestPattern.test(manifest?.digest || "") || !/manifest\.v1\+json$/.test(manifest!.mediaType)) throw new Error("The image archive must contain exactly one OCI image manifest.");
  return manifest!;
}

// Pushes the exact archived bytes so the registry digest equals the scanned, plan-sealed digest.
export async function pushOciArchive(archive: string, target: { registry: string; repository: string; authorization?: string; protocol?: "https" | "http" }) {
  const protocol = target.protocol || "https";
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(target.registry) || !/^[a-z0-9][a-z0-9._/-]{0,255}$/.test(target.repository)) throw new Error("Invalid image registry target.");
  const directory = await mkdtemp(join(tmpdir(), "deployguard-oci-"));
  const headers = (extra: Record<string, string> = {}) => ({ ...(target.authorization ? { Authorization: target.authorization } : {}), ...extra });
  const base = `${protocol}://${target.registry}/v2/${target.repository}`;
  try {
    await run("tar", ["-xf", archive, "-C", directory], { maxBuffer: 1024 * 1024 });
    const descriptor = await ociArchiveManifest(archive);
    const blob = (digest: string) => { if (!digestPattern.test(digest)) throw new Error("Invalid blob digest."); return join(directory, "blobs", "sha256", digest.slice(7)); };
    const manifestBytes = await readFile(blob(descriptor.digest));
    if (`sha256:${createHash("sha256").update(manifestBytes).digest("hex")}` !== descriptor.digest) throw new Error("The archived manifest does not match its digest.");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    for (const item of [manifest.config, ...(manifest.layers || [])] as Descriptor[]) {
      const path = blob(item.digest);
      if (await fileDigest(path) !== item.digest || (await stat(path)).size !== item.size) throw new Error("An archived image blob does not match its digest.");
      if ((await fetch(`${base}/blobs/${item.digest}`, { method: "HEAD", headers: headers() })).status === 200) continue;
      const start = await fetch(`${base}/blobs/uploads/`, { method: "POST", headers: headers() });
      const location = start.headers.get("location");
      if (start.status !== 202 || !location) throw new Error(`The registry refused the blob upload (${start.status}).`);
      // PATCH the bytes, then close with PUT ?digest=; the sequence docker push uses and ECR supports.
      const patch = await fetch(new URL(location, `${protocol}://${target.registry}`), { method: "PATCH", headers: headers({ "Content-Type": "application/octet-stream", "Content-Length": String(item.size) }), body: createReadStream(path) as any, duplex: "half" } as any);
      const next = patch.headers.get("location");
      if (patch.status !== 202 || !next) throw new Error(`The registry refused blob data (${patch.status}).`);
      const upload = new URL(next, `${protocol}://${target.registry}`);
      upload.searchParams.set("digest", item.digest);
      const put = await fetch(upload, { method: "PUT", headers: headers({ "Content-Length": "0" }) });
      if (put.status !== 201) throw new Error(`The registry rejected blob ${item.digest.slice(0, 19)} (${put.status}).`);
    }
    const response = await fetch(`${base}/manifests/${descriptor.digest}`, { method: "PUT", headers: headers({ "Content-Type": descriptor.mediaType }), body: manifestBytes });
    if (response.status !== 201 || (response.headers.get("docker-content-digest") || descriptor.digest) !== descriptor.digest) throw new Error(`The registry did not accept the exact image manifest (${response.status}).`);
    return { digest: descriptor.digest, reference: `${target.registry}/${target.repository}@${descriptor.digest}` };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
