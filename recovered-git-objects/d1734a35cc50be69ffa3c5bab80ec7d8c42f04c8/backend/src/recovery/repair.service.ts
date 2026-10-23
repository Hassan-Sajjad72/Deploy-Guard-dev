import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, sep } from "path";
import { User } from "../users/user.entity";
import { UsersService } from "../users/users.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import { RepositorySourceService } from "../projects/repository-source.service";
import { GithubAppService } from "../projects/github-app.service";
import { canApproveProject } from "../workspaces/project-access";
import { RecoveryService } from "./recovery.service";
import { SupervisedRepairProposal } from "./recovery.entity";
import { recoveryFingerprint, validateRepairFiles } from "./recovery-policy";
import { ProposeRepairDto } from "./recovery.dto";
import { runRepairSandbox } from "./repair-sandbox";

const execFileAsync = promisify(execFile);
@Injectable()
export class RepairService {
  private readonly logger = new Logger(RepairService.name);
  constructor(private readonly db: DataSource, private readonly recovery: RecoveryService, private readonly source: RepositorySourceService,
    private readonly github: GithubAppService, private readonly users: UsersService, private readonly config: ConfigService, private readonly audit: AuditLogService) {}
  async list(user: User, projectId: string) {
    await this.recovery.access(user, projectId);
    await this.db.query(`UPDATE supervised_repair_proposals SET status='unverified', checks=checks || '{"reason":"Sandbox verification deadline elapsed; review the proposal before retrying."}'::jsonb WHERE project_id=$1 AND status='checking' AND (checks->>'startedAt')::timestamptz < now()-interval '20 minutes'`, [projectId]);
    return { proposals: await this.db.getRepository(SupervisedRepairProposal).find({ where: { projectId }, order: { createdAt: "DESC" }, take: 50 }) };
  }
  async propose(user: User, projectId: string, dto: ProposeRepairDto) {
    validateRepairFiles(dto.files); if (!dto.defectEvidence.trim()) throw new BadRequestException("Reproducible defect evidence is required.");
    const access = await this.recovery.access(user, projectId, true); const incident = await this.recovery.incident(projectId, dto.incidentId);
    if (incident.content.scope.sourceSha !== dto.sourceSha || incident.content.scope.bindingId !== (access.project.awsAccountBindingId || null) || incident.content.scope.environment !== access.project.environmentName) throw new ConflictException("Repair source and environment do not match the verified incident.");
    const content = { contractVersion: 1, incidentId: dto.incidentId, incidentFingerprint: incident.fingerprint, sourceSha: dto.sourceSha,
      repository: access.project.repositoryFullName, targetBranch: access.project.targetBranch, environment: access.project.environmentName,
      defectEvidence: dto.defectEvidence.trim(), files: dto.files, requiresHumanReview: true, automaticMerge: false, automaticDeploy: false };
    const proposal = this.db.getRepository(SupervisedRepairProposal).create({ id: randomUUID(), projectId, organizationId: access.project.organizationId || null,
      createdByUserId: user.id, fingerprint: recoveryFingerprint(content), content, status: "unverified" });
    await this.db.getRepository(SupervisedRepairProposal).save(proposal); await this.record(access.user, proposal, "repair_proposed"); return { proposal };
  }
  private async proposal(user: User, projectId: string, id: string, fingerprint: string, write = true) {
    const access = await this.recovery.access(user, projectId, write); const proposal = await this.db.getRepository(SupervisedRepairProposal).findOne({ where: { id, projectId } });
    if (!proposal) throw new NotFoundException("Repair proposal not found.");
    if (proposal.fingerprint !== fingerprint || recoveryFingerprint(proposal.content) !== fingerprint) throw new ConflictException("Repair fingerprint changed.");
    if (proposal.content.repository !== access.project.repositoryFullName || proposal.content.targetBranch !== access.project.targetBranch || proposal.content.environment !== access.project.environmentName) throw new ConflictException("Repair project configuration changed.");
    return { ...access, proposal };
  }
  private command(key: string) {
    const configured = this.config.get<string>(key, ""); if (!configured) return null;
    try { const command = JSON.parse(configured); if (!Array.isArray(command) || command.some((value) => typeof value !== "string")) throw new Error(); return command as string[]; }
    catch { throw new ServiceUnavailableException("Configured sandbox test command is invalid."); }
  }
  async check(user: User, projectId: string, id: string, fingerprint: string) {
    const { project, proposal } = await this.proposal(user, projectId, id, fingerprint);
    const image = this.config.get<string>("REPAIR_SANDBOX_IMAGE", ""); const test = this.command("REPAIR_TEST_COMMAND_JSON"); const contract = this.command("REPAIR_CONTRACT_TEST_COMMAND_JSON");
    if (!image || !test || !contract) { proposal.status = "unverified"; proposal.checks = { defectReproduction: "UNVERIFIED", applicationTests: "UNVERIFIED", apiContractTests: "UNVERIFIED", reason: "Configure a digest-pinned isolated image and approved application/API contract commands." }; await this.db.getRepository(SupervisedRepairProposal).save(proposal); return { proposal }; }
    const [rows] = await this.db.query(`UPDATE supervised_repair_proposals SET status='checking', checks=jsonb_build_object('startedAt',now()) WHERE id=$1 AND status IN ('unverified','failed','passed') RETURNING id`, [id]);
    if (!rows?.length && !rows?.id) throw new ConflictException("A sandbox check is already running or this proposal was published.");
    proposal.status = "checking"; proposal.checks = { startedAt: new Date().toISOString(), defectReproduction: "UNVERIFIED", applicationTests: "UNVERIFIED", apiContractTests: "UNVERIFIED" };
    void this.executeChecks(user, project, proposal, image, test, contract).catch(() => this.logger.warn(`Bounded repair check did not complete for proposal ${proposal.id}.`));
    return { proposal };
  }
  private async executeChecks(user: User, project: any, proposal: SupervisedRepairProposal, image: string, test: string[], contract: string[]) {
    const fingerprint = proposal.fingerprint;
    let checkout: { workspacePath: string; sourceSha: string } | null = null; let staged: string | null = null;
    try {
      const authorization = await this.github.tokenForRepository(project.ownerUserId, project.repositoryFullName, project.githubInstallationId);
      const token = authorization.token;
      if (!token) throw new ForbiddenException("Authorized repository access is required for repair checks.");
      checkout = await this.source.checkout({ repositoryUrl: project.repositoryUrl, branch: project.targetBranch, accessToken: token });
      if (checkout.sourceSha !== proposal.content.sourceSha) throw new ConflictException("Repair source changed. Prepare a new exact-SHA proposal.");
      staged = await mkdtemp(join(tmpdir(), "deployguard-repair-")); await chmod(staged, 0o755);
      const tracked = await execFileAsync("git", ["ls-files", "-z"], { cwd: checkout.workspacePath, timeout: 10000, maxBuffer: 1024 * 1024 });
      const root = await realpath(checkout.workspacePath); const trackedPaths = new Set(tracked.stdout.split("\0").filter(Boolean));
      for (const path of trackedPaths) {
        if (/(?:^|\/)(?:\.env(?:\.[^/]*)?|.*\.(?:pem|key)|credentials|secrets)(?:\/|$)/i.test(path)) continue;
        const original = join(root, path); const entry = await lstat(original);
        if (!entry.isFile() || entry.isSymbolicLink() || path.split("/").some((part) => part === ".git" || part === "..")) throw new BadRequestException("Sandbox source contains unsupported file links or metadata.");
        const target = join(staged, path); await mkdir(dirname(target), { recursive: true }); await copyFile(original, target); await chmod(target, 0o644);
      }
      const baseline = await runRepairSandbox(staged, image, test);
      if (baseline.status !== "FAILED") { proposal.status = baseline.status === "UNVERIFIED" ? "unverified" : "failed"; proposal.checks = { defectReproduction: baseline.status === "UNVERIFIED" ? "UNVERIFIED" : "FAILED", applicationTests: "UNVERIFIED", apiContractTests: "UNVERIFIED", reason: "The unmodified exact-SHA source did not reproduce a failing test." }; }
      else {
        for (const file of proposal.content.files) {
          if (!trackedPaths.has(file.path)) throw new BadRequestException("Repairs may replace only existing tracked application files.");
          const target = join(staged, file.path); const resolved = await realpath(target); if (!resolved.startsWith(`${staged}${sep}`) || !(await lstat(target)).isFile()) throw new BadRequestException("Repair target escaped its sandbox source.");
          await writeFile(target, file.content, { mode: 0o644 });
        }
        const tests = await runRepairSandbox(staged, image, test); const contracts = await runRepairSandbox(staged, image, contract);
        proposal.status = tests.status === "PASSED" && contracts.status === "PASSED" ? "passed" : tests.status === "FAILED" || contracts.status === "FAILED" ? "failed" : "unverified";
        proposal.checks = { defectReproduction: "PASSED", applicationTests: tests.status, apiContractTests: contracts.status, sandboxImage: image, checkedAt: new Date().toISOString(), sourceSha: checkout.sourceSha, fingerprint };
      }
    } catch (error) { proposal.status = "unverified"; proposal.checks = { defectReproduction: "UNVERIFIED", applicationTests: "UNVERIFIED", apiContractTests: "UNVERIFIED", reason: "The bounded isolated repair check could not complete." }; throw error; }
    finally {
      await Promise.allSettled([checkout ? this.source.cleanup(checkout.workspacePath) : Promise.resolve(), staged ? rm(staged, { recursive: true, force: true }) : Promise.resolve()]);
      await this.db.getRepository(SupervisedRepairProposal).save(proposal); await this.record(user, proposal, "repair_checked");
    }
    return { proposal };
  }
  async publish(user: User, projectId: string, id: string, fingerprint: string) {
    const { project, user: fresh, proposal } = await this.proposal(user, projectId, id, fingerprint, false);
    if (!canApproveProject(fresh, project) || project.archivedAt || project.deletionIntentId) throw new ForbiddenException("An active project's owner, administrator or approver must approve repair publication.");
    if (proposal.pullRequestUrl) return { proposal };
    if (proposal.status !== "passed" || proposal.checks?.fingerprint !== fingerprint || proposal.checks?.apiContractTests !== "PASSED") throw new ConflictException("Reproduced defect and passing isolated application/API checks are required before publication.");
    const authorization = await this.github.tokenForRepository(project.ownerUserId, project.repositoryFullName, project.githubInstallationId); const token = authorization.token;
    if (!token) throw new ForbiddenException("A repository-authorized GitHub App is required to publish repair pull requests.");
    const branch = `deployguard/repair-${proposal.id}`; const repo = project.repositoryFullName;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new BadRequestException("Invalid repair repository identity.");
    const api = async (path: string, method = "GET", body?: unknown): Promise<any> => {
      const result = await fetch(`https://api.github.com/repos/${repo}/${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      if (!result.ok) throw new ServiceUnavailableException("GitHub repair publication could not complete; no merge or deployment was requested."); return result.json();
    };
    const existing = await api(`pulls?state=all&head=${encodeURIComponent(repo.split("/")[0] + ":" + branch)}`);
    if (existing.length) { proposal.pullRequestUrl = existing[0].html_url; proposal.status = "pull_request_opened"; await this.db.getRepository(SupervisedRepairProposal).save(proposal); return { proposal }; }
    const head = await api(`git/ref/heads/${project.targetBranch.split("/").map(encodeURIComponent).join("/")}`);
    if (head.object?.sha !== proposal.content.sourceSha) throw new ConflictException("Protected source branch changed; prepare and test a new repair proposal.");
    const commit = await api(`git/commits/${proposal.content.sourceSha}`);
    const treeEntries = [];
    for (const file of proposal.content.files) { const blob = await api("git/blobs", "POST", { content: file.content, encoding: "utf-8" }); treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha }); }
    const tree = await api("git/trees", "POST", { base_tree: commit.tree.sha, tree: treeEntries });
    const repaired = await api("git/commits", "POST", { message: `DeployGuard supervised repair ${proposal.id}\n\nRequested by user ${proposal.createdByUserId}; reviewed by user ${user.id}; fingerprint ${fingerprint}`, tree: tree.sha, parents: [proposal.content.sourceSha] });
    const authority = await this.recovery.access(user, projectId);
    if (!canApproveProject(authority.user, authority.project)) throw new ForbiddenException("Repair publication authority was revoked.");
    await api("git/refs", "POST", { ref: `refs/heads/${branch}`, sha: repaired.sha });
    const pull = await api("pulls", "POST", { title: `Supervised repair ${proposal.id.slice(0, 8)}`, head: branch, base: project.targetBranch, draft: true,
      body: `Defect evidence and bounded patch retained in DeployGuard proposal ${proposal.id}.\nExact source: ${proposal.content.sourceSha}\nFingerprint: ${fingerprint}\nIsolated application/API checks passed. Human code review and a separately approved deployment are required. Operational recovery remains UNVERIFIED.` });
    proposal.pullRequestUrl = pull.html_url; proposal.status = "pull_request_opened"; proposal.checks = { ...proposal.checks, approvedByUserId: user.id, publicationApprovedAt: new Date().toISOString(), operationalRecovery: "UNVERIFIED" };
    await this.db.getRepository(SupervisedRepairProposal).save(proposal); await this.record(fresh, proposal, "repair_pull_request_opened"); return { proposal };
  }
  private record(user: User, proposal: SupervisedRepairProposal, action: string) { return this.audit.record({ actorUser: user, action, resourceType: "project", resourceId: proposal.projectId, status: proposal.status, metadata: { organizationId: proposal.organizationId, repairProposalId: proposal.id, fingerprint: proposal.fingerprint, sourceSha: proposal.content.sourceSha, pullRequestUrl: proposal.pullRequestUrl } }); }
}
