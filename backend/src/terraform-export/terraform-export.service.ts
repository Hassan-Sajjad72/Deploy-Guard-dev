import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash, randomUUID } from "crypto";
import { lstat, readdir, readFile, realpath } from "fs/promises";
import { basename, relative, resolve, sep } from "path";
import { LessThan, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { getInfrastructureConfig } from "../infrastructure/infrastructure.config";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { Project } from "../projects/project.entity";
import { User, UserRole } from "../users/user.entity";
import { TerraformExportArtifact } from "./terraform-export-artifact.entity";
import { buildDeterministicZip } from "./zip-builder";

@Injectable()
export class TerraformExportService {
  constructor(@InjectRepository(Project) private readonly projects: Repository<Project>, @InjectRepository(ProjectInfrastructureEnvironment) private readonly environments: Repository<ProjectInfrastructureEnvironment>, @InjectRepository(TerraformExportArtifact) private readonly artifacts: Repository<TerraformExportArtifact>, private readonly config: ConfigService, private readonly audit: AuditLogService) {}
  async create(user: User, projectId: string) {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found.");
    if (user.role === UserRole.READONLY || (user.role !== UserRole.ADMIN && project.ownerUserId !== user.id)) throw new ForbiddenException("You cannot export this project.");
    const environment = await this.environments.findOne({ where: { projectId }, order: { updatedAt: "DESC" } });
    const root = getInfrastructureConfig(this.config).terraformWorkingBaseDir;
    const files = environment?.terraformWorkspacePath
      ? await this.collect(await this.assertSafeDirectory(environment.terraformWorkspacePath, root), root)
      : await this.githubActionsTerraformFiles();
    this.assertNoSecretContent(files);
    files.push({ path: "README.md", content: Buffer.from("# DeployGuard Terraform export\n\nReview variables and backend settings before running Terraform. This bundle contains no state, plan, credentials, or real tfvars values.\n") });
    files.push({ path: "MIGRATION_NOTES.md", content: Buffer.from("Import existing resources deliberately if moving this configuration. Configure a remote backend, validate, and plan before apply. DeployGuard does not export its managed state.\n") });
    files.push({ path: "backend.hcl.example", content: Buffer.from('bucket = "REPLACE_ME"\nkey = "REPLACE_ME/terraform.tfstate"\nregion = "REPLACE_ME"\n') });
    if (!files.some((file) => file.path === "terraform.tfvars.example")) files.push({ path: "terraform.tfvars.example", content: Buffer.from("# Add non-secret values required by variables.tf. Never commit credentials.\n") });
    const manifest = { generator: "DeployGuard", executionEngine: "github_actions", generatorVersion: this.config.get<string>("DEPLOYGUARD_VERSION", "local"), generatedAt: new Date(0).toISOString(), project: { name: project.name, repository: project.repositoryFullName, branch: project.targetBranch }, environment: environment?.environmentName || "dev", files: files.map((file) => ({ path: file.path, sha256: createHash("sha256").update(file.content).digest("hex") })), exclusions: ["state", "plans", "tfvars values", "backend credentials", "provider caches", "symlinks"] };
    files.push({ path: "MANIFEST.json", content: Buffer.from(JSON.stringify(manifest, null, 2)) });
    const sourceBytes = files.reduce((total, file) => total + file.content.length, 0); const maxBytes = Number(this.config.get<string>("TERRAFORM_EXPORT_MAX_BYTES", "10485760")); if (sourceBytes > maxBytes) throw new ForbiddenException("Terraform export exceeds the configured archive size limit.");
    const archive = buildDeterministicZip(files); if (archive.length > maxBytes) throw new ForbiddenException("Terraform export exceeds the configured archive size limit."); const checksum = createHash("sha256").update(archive).digest("hex");
    const artifactId = randomUUID();
    const artifact = await this.artifacts.save(this.artifacts.create({ id: artifactId, projectId, userId: user.id, filename: `${this.slug(project.name)}-terraform.zip`, checksum, sizeBytes: archive.length, archive, manifest, expiresAt: new Date(Date.now() + 15 * 60_000) }));
    await this.cleanup(); await this.audit.record({ actorUser: user, action: "TERRAFORM_EXPORT_CREATED", resourceType: "terraform_export", resourceId: artifact.id, status: "success", metadata: { projectId, sizeBytes: archive.length, checksum } });
    return { id: artifact.id, filename: artifact.filename, checksum, sizeBytes: archive.length, expiresAt: artifact.expiresAt, manifest };
  }
  async download(user: User, projectId: string, artifactId: string) { const artifact = await this.artifacts.createQueryBuilder("artifact").addSelect("artifact.archive").where("artifact.id = :artifactId", { artifactId }).andWhere("artifact.projectId = :projectId", { projectId }).getOne(); if (!artifact || artifact.expiresAt.getTime() <= Date.now()) throw new NotFoundException("Terraform export is missing or expired."); if (user.role !== UserRole.ADMIN && artifact.userId !== user.id) throw new ForbiddenException("You cannot download this export."); return artifact; }
  async assertSafeDirectory(value: string, allowedRoot: string) { const root = await realpath(resolve(allowedRoot)); const candidate = await realpath(resolve(value)); if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new ForbiddenException("Terraform workspace is outside the configured export root."); return candidate; }
  private async collect(workspace: string, root: string) { const output: Array<{ path: string; content: Buffer }> = []; const visit = async (directory: string, prefix = "") => { for (const entry of await readdir(directory, { withFileTypes: true })) { const full = resolve(directory, entry.name); const stat = await lstat(full); if (stat.isSymbolicLink()) continue; const path = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) { if ([".terraform", ".git", "node_modules"].includes(entry.name)) continue; await visit(full, path); continue; } if (!entry.isFile() || !this.allowed(path)) continue; output.push({ path, content: await readFile(full) }); } }; await visit(workspace);
    const tfText = Buffer.concat(output.filter((file) => file.path.endsWith(".tf")).map((file) => file.content)).toString("utf8"); const sources = [...tfText.matchAll(/source\s*=\s*"(\.\.\/[^"\n]+)"/g)].map((match) => match[1]);
    for (const source of new Set(sources)) { const modulePath = resolve(workspace, source); if (modulePath === workspace || !modulePath.startsWith(`${resolve(root)}${sep}`)) continue; try { await this.assertSafeDirectory(modulePath, root); await visit(modulePath, `modules/${basename(modulePath)}`); } catch { /* Omit inaccessible or unsafe module sources. */ } }
    return output;
  }
  private async githubActionsTerraformFiles() {
    const candidates = [resolve(process.cwd(), "../.github/workflows/deployguard-reusable.yml"), resolve(process.cwd(), ".github/workflows/deployguard-reusable.yml")];
    for (const candidate of candidates) {
      try {
        const workflow = await readFile(candidate, "utf8");
        const match = workflow.match(/cat > \.deployguard\/terraform\/main\.tf <<'TERRAFORM'\n([\s\S]*?)\n\s+TERRAFORM/);
        if (!match) continue;
        const main = match[1].split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n") + "\n";
        return [{ path: "main.tf", content: Buffer.from(main) }];
      } catch { /* try the next packaged workflow location */ }
    }
    throw new NotFoundException("The GitHub Actions Terraform template is unavailable for export.");
  }
  private allowed(path: string) { const lower = path.toLowerCase(); if (/terraform\.tfstate|\.tfplan|(^|\/)tfplan$|terraform\.tfvars\.json|backend\.hcl$|\.terraform\.lock\.hcl|\.pem$|credentials|secret|token/.test(lower)) return false; return lower.endsWith(".tf") || lower.endsWith(".md") || lower.endsWith(".example") || lower.endsWith(".json.example"); }
  private assertNoSecretContent(files: Array<{ path: string; content: Buffer }>) {
    const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|(?:password|secret|token|access_key)\s*=\s*"(?!REPLACE_ME|\$\{|var\.)[^"\n]{4,}"/i;
    const unsafe = files.find((file) => secret.test(file.content.toString("utf8")));
    if (unsafe) throw new ForbiddenException(`Terraform export rejected because ${unsafe.path} contains a credential-like literal.`);
  }
  private async cleanup() { await this.artifacts.delete({ expiresAt: LessThan(new Date()) }); }
  private slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "deployguard"; }
}
