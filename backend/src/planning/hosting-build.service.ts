import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { DataSource } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { GithubAppService } from "../projects/github-app.service";
import { Project, ProjectStatus } from "../projects/project.entity";
import { ProjectDeployableService } from "../projects/project-deployable-service.entity";
import { RepositorySourceService } from "../projects/repository-source.service";
import { buildDeterministicZip } from "../terraform-export/zip-builder";
import { User, UserRole } from "../users/user.entity";
import { UsersService } from "../users/users.service";
import { canAccessProject } from "../workspaces/project-access";
import { planFingerprint } from "./deployment-plan";
import { ociArchiveManifest } from "./oci-push";

const run = promisify(execFile);
export type BuildProfile = "static" | "lambda" | "ec2" | "lightsail";
export type HostingBuildRecord = {
  contractVersion: "deployguard.hosting-build/v1"; buildId: string; status: "running" | "succeeded" | "failed"; error?: string; organizationId: string; projectId: string; sourceSha: string; profile: BuildProfile; serviceIds: string[];
  // Trusted fields merged into profile inputs; they override anything a user typed for the same keys.
  evidence: Record<string, unknown>; securityScan: { status: "passed" | "failed"; fingerprint: string; source: string };
  createdAt: string; expiresAt: string;
};
const contentTypes: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain", ".map": "application/json",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".xml": "application/xml", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm" };
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
// Customer ECR repositories created at execution; the prefix matches the EC2 artifact ownership check.
export const imageRepository = (projectId: string, serviceId: string) => `dg-${projectId.replaceAll("-", "").slice(0, 12)}-${serviceId.replaceAll("-", "").slice(0, 12)}`;
const digestImage = (value: string) => /^[a-zA-Z0-9._/:\-]+@sha256:[a-f0-9]{64}$/.test(value);

// Untrusted repository code only ever runs inside this container: no capabilities, non-root,
// read-only root filesystem, bounded resources. Dependency installation needs network egress.
export function buildSandboxArguments(workspace: string, image: string, command: string, name: string, user = "65534:65534") {
  if (!digestImage(image)) throw new ServiceUnavailableException("A digest-pinned hosting builder image is required.");
  return ["run", "--name", name, "--pull", "never", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", user, "--pids-limit", "256",
    "--cpus", "2", "--memory", "2g", "--tmpfs", "/tmp:rw,nosuid,size=512m", "--env", "HOME=/tmp", "--env", "npm_config_cache=/tmp/npm", "--env", "CI=true",
    "--mount", `type=bind,source=${workspace},target=/workspace`, "--workdir", "/workspace", image, "sh", "-c", command];
}

@Injectable()
export class HostingBuildService {
  private readonly logger = new Logger(HostingBuildService.name);
  constructor(private readonly data: DataSource, private readonly config: ConfigService, private readonly users: UsersService,
    private readonly source: RepositorySourceService, private readonly github: GithubAppService, private readonly audit: AuditLogService) {}

  private root() {
    const root = this.config.get<string>("HOSTING_BUILD_ARTIFACT_ROOT", "");
    if (!root.startsWith("/")) throw new ServiceUnavailableException("Hosting build artifact storage is not configured.");
    return root;
  }
  private signingKey() {
    const key = this.config.get<string>("HOSTING_BUILD_PROOF_SIGNING_KEY", "");
    if (key.length < 32) throw new ServiceUnavailableException("Hosting build proof signing is not configured.");
    return key;
  }
  private async access(user: User, projectId: string) {
    const actor = await this.users.findById(user.id);
    const project = await this.data.getRepository(Project).findOneBy({ id: projectId });
    if (!actor || actor.disabledAt || actor.role === UserRole.ADMIN || !project?.organizationId || project.status === ProjectStatus.ARCHIVED || project.deletionIntentId) throw new NotFoundException("Active customer project not found.");
    if (!canAccessProject(actor, project, true)) throw new ForbiddenException("The assigned workspace project scope does not permit this action.");
    return { actor, project };
  }
  private stagingDirectory(buildId: string) {
    if (!/^[0-9a-f-]{36}$/.test(buildId)) throw new BadRequestException("Invalid build identifier.");
    return resolve(this.root(), "staging", buildId);
  }

  async build(user: User, projectId: string, input: { profile: BuildProfile; serviceId: string; handler?: string; runtime?: string }) {
    const { actor, project } = await this.access(user, projectId);
    const service = await this.data.getRepository(ProjectDeployableService).findOneBy({ id: input.serviceId, projectId });
    if (!service) throw new NotFoundException("Deployable service not found.");
    this.signingKey();
    const buildId = randomUUID(), staging = this.stagingDirectory(buildId), created = new Date();
    const pending: HostingBuildRecord = { contractVersion: "deployguard.hosting-build/v1", buildId, status: "running", organizationId: project.organizationId, projectId, sourceSha: "", profile: input.profile,
      serviceIds: [service.id], evidence: {}, securityScan: { status: "failed", fingerprint: "", source: "pending" }, createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + 24 * 3600_000).toISOString() };
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await writeFile(join(staging, "build.json"), JSON.stringify(pending), { mode: 0o600 });
    // Builds and scans run for minutes; the caller polls the record instead of holding a request open.
    void this.execute(actor, project, service, input, buildId).catch(async (error) => {
      await writeFile(join(staging, "build.json"), JSON.stringify({ ...pending, status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "The hosting build failed." }), { mode: 0o600 }).catch(() => undefined);
      await rm(join(staging, "assets"), { recursive: true, force: true }).catch(() => undefined);
    });
    return pending;
  }

  private async execute(actor: User, project: Project, service: ProjectDeployableService, input: { profile: BuildProfile; serviceId: string; handler?: string; runtime?: string }, buildId: string) {
    const projectId = project.id, staging = this.stagingDirectory(buildId);
    const credential = await this.github.tokenForRepository(project.ownerUserId, project.repositoryFullName, project.githubInstallationId);
    let record: HostingBuildRecord;
    if (input.profile === "lightsail") {
      // Lightsail instances have no IAM identity for private registries; only pipeline-verified images apply.
      const sourceSha = await this.source.resolveSourceSha({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch, accessToken: credential.token });
      record = await this.imageEvidence(project, input.profile, sourceSha, buildId);
    } else {
      const checkout = await this.source.checkout({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch, accessToken: credential.token });
      const workspace = await mkdtemp(join(tmpdir(), "deployguard-hosting-build-"));
      try {
        const root = await realpath(checkout.workspacePath);
        const directory = await realpath(service.serviceDirectory === "." ? root : join(root, ...service.serviceDirectory.split("/")));
        if (directory !== root && !directory.startsWith(`${root}/`)) throw new BadRequestException("The service directory escapes the repository.");
        await cp(directory, workspace, { recursive: true, filter: (path) => !/(^|\/)(\.git|\.env[^/]*)$/.test(path) });
        const { evidence, scan } = await this.buildWorkspace(workspace, staging, checkout.sourceSha, { ...input, serviceId: service.id });
        const created = new Date();
        record = { contractVersion: "deployguard.hosting-build/v1", buildId, status: "succeeded", organizationId: project.organizationId, projectId, sourceSha: checkout.sourceSha, profile: input.profile, serviceIds: [service.id],
          evidence, securityScan: scan, createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + 24 * 3600_000).toISOString() };
      } finally { await rm(workspace, { recursive: true, force: true }); await this.source.cleanup(checkout.workspacePath); }
    }
    await writeFile(join(staging, "build.json"), JSON.stringify(record), { mode: 0o600 });
    await this.audit.record({ actorUser: actor, action: "HOSTING_BUILD_EVIDENCE_CREATED", resourceType: "project", resourceId: projectId, status: record.securityScan.status === "passed" ? "success" : "failure",
      metadata: { projectId, organizationId: project.organizationId, buildId, profile: input.profile, sourceSha: record.sourceSha, securityScan: record.securityScan.status } });
    return record;
  }

  // The source-pinned build core: isolated build, Trivy scan and staged, hashed artifacts.
  async buildWorkspace(workspace: string, staging: string, sourceSha: string, input: { profile: BuildProfile; serviceId: string; handler?: string; runtime?: string }) {
    await mkdir(join(staging, "assets"), { recursive: true, mode: 0o700 });
    if (input.profile === "ec2") {
      try { await lstat(join(workspace, "Dockerfile")); } catch { throw new BadRequestException("EC2 image builds require a Dockerfile in the service directory."); }
      const archive = join(staging, "assets", "images", `${input.serviceId}.tar`);
      await mkdir(dirname(archive), { recursive: true, mode: 0o700 });
      await this.imageBuild(workspace, archive);
      // Trivy reads OCI layouts as directories; scan an extracted copy of the exact archive.
      const layout = await mkdtemp(join(tmpdir(), "deployguard-oci-layout-"));
      let scan: HostingBuildRecord["securityScan"];
      try { await run("tar", ["-xf", archive, "-C", layout], { timeout: 300_000 }); scan = await this.scan(layout, ["image", "--input", "/scan"]); }
      finally { await rm(layout, { recursive: true, force: true }); }
      const manifest = await ociArchiveManifest(archive);
      return { scan, evidence: { images: { [input.serviceId]: { digest: manifest.digest, archive: `images/${input.serviceId}.tar`, platform: "linux/amd64" } },
        build: { sourceSha, kind: "ec2", fingerprint: manifest.digest.slice(7), securityScanFingerprint: scan.fingerprint, status: "verified" } } };
    }
    await this.sandbox(workspace, input.profile === "static" ? "npm ci && npm run build"
      : input.runtime === "python3.12" ? "if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt -t .; fi" : "npm ci --omit=dev");
    const scan = await this.scan(workspace);
    const evidence = input.profile === "static" ? await this.stageStatic(workspace, staging, sourceSha, scan.fingerprint)
      : await this.stageLambda(workspace, staging, sourceSha, scan.fingerprint, input);
    return { evidence, scan };
  }

  // BuildKit executes Dockerfile steps in its own isolated build containers; the output is an OCI
  // archive whose manifest digest is fixed before any registry sees it.
  private async imageBuild(context: string, archive: string) {
    const env = { PATH: process.env.PATH || "/usr/bin:/bin", DOCKER_BUILDKIT: "1" };
    try {
      await run("docker", ["buildx", "build", "--platform", "linux/amd64", "--provenance=false", "--sbom=false", "--pull=false",
        "--output", `type=oci,dest=${archive},oci-mediatypes=true`, context], { timeout: 900_000, maxBuffer: 8 * 1024 * 1024, env });
    } catch (error: any) {
      if (error.code === "ENOENT") throw new ServiceUnavailableException("The isolated image builder is unavailable.");
      throw new BadRequestException("The container image build failed.");
    }
  }

  async get(user: User, projectId: string, buildId: string) {
    const { project } = await this.access(user, projectId);
    const record = await this.load(buildId);
    if (record.projectId !== projectId || record.organizationId !== project.organizationId) throw new NotFoundException("Hosting build not found.");
    return record;
  }

  private async load(buildId: string): Promise<HostingBuildRecord> {
    try { return JSON.parse(await readFile(join(this.stagingDirectory(buildId), "build.json"), "utf8")); }
    catch { throw new NotFoundException("Hosting build not found."); }
  }

  private async sandbox(workspace: string, command: string) {
    const image = this.config.get<string>("HOSTING_BUILDER_IMAGE", "");
    const name = `deployguard-build-${randomUUID()}`;
    const env = { PATH: process.env.PATH || "/usr/bin:/bin" };
    // Never root inside the builder: reuse the backend's unprivileged identity, or hand the workspace to nobody.
    const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;
    if (uid === 0) await run("chown", ["-R", "65534:65534", workspace], { timeout: 60_000 });
    const user = uid === 0 ? "65534:65534" : `${uid}:${gid}`;
    try { await run("docker", buildSandboxArguments(workspace, image, command, name, user), { timeout: 600_000, maxBuffer: 4 * 1024 * 1024, env }); }
    catch (error: any) {
      if (error instanceof ServiceUnavailableException) throw error;
      if (error.code === "ENOENT" || error.code === 125) throw new ServiceUnavailableException("The isolated hosting builder is unavailable.");
      throw new BadRequestException("The application build failed inside the isolated builder.");
    } finally { await run("docker", ["rm", "-f", name], { timeout: 15_000, env }).catch(() => undefined); }
  }

  // Reuses the platform's Trivy policy: HIGH/CRITICAL vulnerabilities or detected secrets fail the build evidence.
  private async scan(workspace: string, target: string[] = ["fs", "--scanners", "vuln,secret", "/scan"]): Promise<HostingBuildRecord["securityScan"]> {
    const image = this.config.get<string>("HOSTING_TRIVY_IMAGE", "");
    if (!digestImage(image)) throw new ServiceUnavailableException("A digest-pinned Trivy scanner image is required.");
    const env = { PATH: process.env.PATH || "/usr/bin:/bin" };
    // An optional operator cache avoids re-downloading the vulnerability database for every build.
    const cache = this.config.get<string>("HOSTING_TRIVY_CACHE_DIR", "");
    const [mode, ...rest] = target;
    const args = ["run", "--rm", "--pull", "never", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", process.getuid?.() ? `${process.getuid!()}:${process.getgid!()}` : "65534:65534", "--memory", "2g",
      "--tmpfs", "/tmp:rw,nosuid,size=1g", "--env", "TRIVY_CACHE_DIR=/cache", ...(cache.startsWith("/") ? ["--mount", `type=bind,source=${cache},target=/cache`] : ["--tmpfs", "/cache:rw,nosuid,size=1g"]),
      "--mount", `type=bind,source=${workspace},target=/scan,readonly`,
      image, mode, "--quiet", "--severity", "HIGH,CRITICAL", "--exit-code", "1", "--format", "json", ...rest];
    try {
      const { stdout } = await run("docker", args, { timeout: 600_000, maxBuffer: 32 * 1024 * 1024, env });
      return { status: "passed", fingerprint: sha256(stdout), source: `trivy:${image}` };
    } catch (error: any) {
      if (error.code === 1 && typeof error.stdout === "string" && error.stdout.trim().startsWith("{")) return { status: "failed", fingerprint: sha256(error.stdout), source: `trivy:${image}` };
      this.logger.warn(`Hosting build scanner failed (${error.code ?? "unknown"}): ${String(error.stderr || "").slice(-400)}`);
      throw new ServiceUnavailableException("The isolated security scanner is unavailable.");
    }
  }

  private async files(base: string) {
    const out: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory)) {
        const path = join(directory, entry), info = await lstat(path);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) { if (!["node_modules", ".git"].includes(entry) || base.endsWith("node_modules")) await walk(path); }
        else if (info.isFile()) out.push(relative(base, path).split("\\").join("/"));
        if (out.length > 20000) throw new BadRequestException("The build output contains too many files.");
      }
    };
    await walk(base); return out.sort();
  }

  private async stageStatic(workspace: string, staging: string, sourceSha: string, scanFingerprint: string) {
    let output: string | null = null;
    for (const candidate of ["dist", "build", "out"]) { try { await lstat(join(workspace, candidate, "index.html")); output = join(workspace, candidate); break; } catch { /* next candidate */ } }
    if (!output) throw new BadRequestException("The static build did not produce dist/, build/ or out/ with index.html.");
    const assets: Array<{ path: string; sha256: string; bytes: number; contentType: string }> = [];
    let total = 0;
    for (const path of (await this.files(output)).filter((item) => !item.split("/").some((part) => part.startsWith(".") || part === "node_modules"))) {
      const data = await readFile(join(output, path)); total += data.length;
      if (assets.length >= 1000 || data.length > 50 * 1024 * 1024 || total > 200 * 1024 * 1024) throw new BadRequestException("The static build exceeds the 1000-file or 200 MiB artifact bounds.");
      const destination = join(staging, "assets", path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await writeFile(destination, data, { mode: 0o600 });
      assets.push({ path, sha256: sha256(data), bytes: data.length, contentType: contentTypes[extname(path).toLowerCase()] || "application/octet-stream" });
    }
    return { build: { sourceSha, kind: "static", fingerprint: planFingerprint(assets), securityScanFingerprint: scanFingerprint, status: "verified" }, assets };
  }

  private async stageLambda(workspace: string, staging: string, sourceSha: string, scanFingerprint: string, input: { handler?: string; runtime?: string }) {
    const runtime = input.runtime || "nodejs22.x", handler = input.handler || "index.handler";
    if (!["nodejs22.x", "python3.12"].includes(runtime) || !/^[A-Za-z0-9_/.-]{1,100}\.[A-Za-z0-9_]{1,100}$/.test(handler) || handler.includes("..")) throw new BadRequestException("A supported Lambda runtime and handler are required.");
    const module = handler.slice(0, handler.lastIndexOf("."));
    const candidates = runtime === "python3.12" ? [`${module}.py`] : [`${module}.js`, `${module}.mjs`, `${module}.cjs`];
    let handlerSource: Buffer | null = null;
    for (const candidate of candidates) { try { handlerSource = await readFile(join(workspace, candidate)); break; } catch { /* next candidate */ } }
    if (!handlerSource) throw new BadRequestException(`The Lambda handler module ${module} was not found in the build output.`);
    const files = await this.files(workspace);
    let uncompressed = 0; const entries: Array<{ path: string; content: Buffer }> = [];
    for (const path of files) { const content = await readFile(join(workspace, path)); uncompressed += content.length; entries.push({ path, content }); }
    const zip = buildDeterministicZip(entries);
    if (zip.length > 50 * 1024 * 1024 || uncompressed > 250 * 1024 * 1024) throw new BadRequestException("The Lambda package exceeds the 50 MiB / 250 MiB bounds.");
    await writeFile(join(staging, "assets", "function.zip"), zip, { mode: 0o600 });
    const artifact = { sha256: sha256(zip), bytes: zip.length, uncompressedBytes: Math.max(zip.length, uncompressed) };
    return { build: { sourceSha, kind: "lambda_http", fingerprint: planFingerprint({ artifact, handler, runtime }), securityScanFingerprint: scanFingerprint, status: "verified" },
      runtime, handler, artifact, adapter: { kind: "native_http", fingerprint: sha256(handlerSource), payloadFormat: "2.0", timeoutBounded: true, filesystemEphemeral: true, backgroundWorkers: false, maximumRequestBytes: 6291456, maximumResponseBytes: 6291456 } };
  }

  // VM profiles reuse images already built and Trivy-scanned by the existing Railpack release pipeline.
  private async imageEvidence(project: Project, profile: "ec2" | "lightsail", sourceSha: string, buildId: string): Promise<HostingBuildRecord> {
    const rows = await this.data.query(`SELECT revision.service_id AS "serviceId",revision.image_uri AS "imageUri",revision.image_digest AS "imageDigest",run.metadata->'releaseArtifact'->'securityScan' AS scan,run.id AS "operationId"
      FROM project_generation_service_revisions revision JOIN project_pipeline_runs run ON run.generation_id=revision.generation_id AND run.project_id=revision.project_id
      WHERE revision.project_id=$1 AND revision.source_sha=$2 AND run.commit_sha=$2 ORDER BY run.created_at DESC`, [project.id, sourceSha]);
    const images: Record<string, string> = {}; let scanHash: string | null = null;
    for (const row of rows) {
      if (images[row.serviceId] || !/^sha256:[a-f0-9]{64}$/.test(row.imageDigest || "") || row.scan?.status !== "passed" || row.scan?.projectId !== project.id || row.scan?.commitSha !== sourceSha || !/^[a-f0-9]{64}$/.test(row.scan?.evidenceHash || "")) continue;
      images[row.serviceId] = `${String(row.imageUri).split("@")[0].replace(/:[^/:]+$/, "")}@${row.imageDigest}`; scanHash ||= row.scan.evidenceHash;
    }
    if (!Object.keys(images).length || !scanHash) throw new ConflictException("No Trivy-passed, digest-pinned release images exist for this exact source SHA. Run the existing release pipeline first.");
    const created = new Date();
    return { contractVersion: "deployguard.hosting-build/v1", buildId, status: "succeeded", organizationId: project.organizationId, projectId: project.id, sourceSha, profile, serviceIds: Object.keys(images).sort(),
      evidence: { images }, securityScan: { status: "passed", fingerprint: scanHash, source: "existing-release-pipeline" },
      createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + 24 * 3600_000).toISOString() };
  }

  // Merges trusted build evidence into the user's profile inputs. Trusted keys always win.
  async mergeInputs(buildId: string, expected: { organizationId: string; projectId: string; sourceSha: string; profile: string; accountId?: string; region?: string }, inputs: Record<string, any> | undefined) {
    const record = await this.load(buildId);
    if (record.status !== "succeeded") throw new ConflictException(record.status === "running" ? "The hosting build is still running." : `The hosting build failed: ${record.error || "unknown error"}`);
    if (record.organizationId !== expected.organizationId || record.projectId !== expected.projectId || record.profile !== expected.profile) throw new BadRequestException("The build belongs to another project or profile.");
    if (record.sourceSha !== expected.sourceSha) throw new ConflictException("The build was produced from a different source SHA; rebuild for the current commit.");
    if (Date.parse(record.expiresAt) <= Date.now()) throw new ConflictException("The build evidence expired; rebuild before planning.");
    if (record.securityScan.status !== "passed") throw new ConflictException("The build failed its security scan.");
    const merged: Record<string, any> = { ...(inputs || {}) };
    if (record.profile === "ec2" || record.profile === "lightsail") {
      const images = (record.evidence as any).images as Record<string, string | { digest: string }>;
      const reference = (serviceId: string, value: string | { digest: string }) => {
        if (typeof value === "string") return value;
        if (!/^\d{12}$/.test(expected.accountId || "") || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(expected.region || "")) throw new BadRequestException("The plan's AWS account and region are required to address the built image.");
        return `${expected.accountId}.dkr.ecr.${expected.region}.amazonaws.com/${imageRepository(record.projectId, serviceId)}@${value.digest}`;
      };
      merged.services = (Array.isArray(merged.services) ? merged.services : []).map((service: any) => images[service?.id] ? { ...service, image: reference(service.id, images[service.id]) } : service);
    } else Object.assign(merged, record.evidence);
    return { inputs: merged, record };
  }

  // Writes the signed provenance the provider adapter's buildAdmission() verifies, beside the exact assets.
  async seal(record: HostingBuildRecord, profileInputs: Record<string, unknown>) {
    const directory = resolve(this.root(), record.organizationId, record.projectId, record.sourceSha, planFingerprint(profileInputs));
    const staged = join(this.stagingDirectory(record.buildId), "assets");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await cp(staged, join(directory, "assets"), { recursive: true, force: true }); } catch { /* VM builds have no file assets. */ }
    const verified = new Date();
    const proof = { contractVersion: "deployguard.profile-build/v1", organizationId: record.organizationId, projectId: record.projectId, sourceSha: record.sourceSha, profile: record.profile,
      profileInputsFingerprint: planFingerprint(profileInputs), securityScan: "passed", securityScanFingerprint: record.securityScan.fingerprint, buildId: record.buildId,
      verifiedAt: verified.toISOString(), expiresAt: new Date(Math.min(Date.parse(record.expiresAt), verified.getTime() + 24 * 3600_000)).toISOString() };
    const signature = createHmac("sha256", this.signingKey()).update(planFingerprint(proof)).digest("hex");
    await writeFile(join(directory, "provenance.json"), JSON.stringify({ proof, signature }), { mode: 0o600 });
    return { directory, proof };
  }
}
