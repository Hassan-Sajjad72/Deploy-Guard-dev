import { Injectable } from "@nestjs/common";
import { AwsCliService } from "../state-management/aws-cli.service";
import { TerraformRunnerService } from "./terraform-runner.service";

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT = /^(?:dev|production)$/;

export type PersistentResourceExpectation = {
  kind: "ecr_repository" | "efs_file_system" | "efs_access_point";
  identity: string;
  resourceAddress: string;
  requiredTags: Record<string, string>;
};
export type PersistentResourceDescription = {
  id: string;
  identity: string;
  tags: Record<string, string>;
};
export interface PersistentResourceLifecyclePort {
  findExact(expectation: PersistentResourceExpectation): Promise<PersistentResourceDescription[]>;
  stateAddresses(): Promise<Set<string>>;
  importResource(expectation: PersistentResourceExpectation, id: string): Promise<void>;
}

export function expectedPersistentResources(variables: Record<string, unknown>): PersistentResourceExpectation[] {
  const projectId = String(variables.project_id || "");
  const environment = String(variables.environment_name || "");
  if (!PROJECT_ID.test(projectId)) throw new Error("Persistent-resource reconciliation requires a valid project UUID.");
  if (!ENVIRONMENT.test(environment)) throw new Error("Persistent-resource reconciliation requires a supported environment.");
  const baseTags = { ManagedBy: "DeployGuard", DeployGuardProjectId: projectId, Environment: environment };
  const expected: PersistentResourceExpectation[] = [];
  if (variables.manage_ecr_repository === true) {
    const name = String(variables.ecr_repository_name || "");
    if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(name)) throw new Error("Persistent-resource ECR name is invalid.");
    expected.push({ kind: "ecr_repository", identity: name, resourceAddress: "module.registry.aws_ecr_repository.this[0]", requiredTags: baseTags });
  }
  if (variables.enable_efs === true) {
    expected.push(
      { kind: "efs_file_system", identity: `${projectId}-${environment}-efs`, resourceAddress: "module.efs.aws_efs_file_system.this[0]", requiredTags: { ...baseTags, Persistent: "true" } },
      { kind: "efs_access_point", identity: `${projectId}-${environment}-efs-ap`, resourceAddress: "module.efs.aws_efs_access_point.this[0]", requiredTags: { ...baseTags, Persistent: "true" } },
    );
  }
  const database = record(variables.database_service);
  if (database.enabled === true && database.persistence_enabled === true && database.efs_enabled === true) {
    expected.push(
      { kind: "efs_file_system", identity: `deployguard-${projectId}-database`, resourceAddress: "module.database_service.aws_efs_file_system.database[0]", requiredTags: { ...baseTags, Tier: "database" } },
      { kind: "efs_access_point", identity: `deployguard-${projectId}-database-access-point`, resourceAddress: "module.database_service.aws_efs_access_point.database[0]", requiredTags: { ...baseTags, Tier: "database" } },
    );
  }
  return expected;
}

export class PersistentResourceLifecycleReconciler {
  constructor(private readonly port: PersistentResourceLifecyclePort) {}

  async reconcile(expectations: PersistentResourceExpectation[]) {
    const state = await this.port.stateAddresses();
    const results: Array<PersistentResourceExpectation & { status: "missing" | "owned"; importResult: "not_required" | "imported" }> = [];
    for (const expected of expectations) {
      const matches = await this.port.findExact(expected);
      if (matches.length > 1) throw new Error(`${expected.kind} ${expected.identity} is ambiguous; reconciliation stopped.`);
      if (!matches.length) {
        results.push({ ...expected, status: "missing", importResult: "not_required" });
        continue;
      }
      const resource = matches[0];
      for (const [key, value] of Object.entries(expected.requiredTags)) {
        if (resource.tags[key] !== value) throw new Error(`${expected.kind} ${expected.identity} failed ownership verification (${key}).`);
      }
      if (!state.has(expected.resourceAddress)) {
        await this.port.importResource(expected, resource.id);
        state.add(expected.resourceAddress);
        results.push({ ...expected, status: "owned", importResult: "imported" });
      } else {
        results.push({ ...expected, status: "owned", importResult: "not_required" });
      }
    }
    return results;
  }
}

@Injectable()
export class PersistentResourceLifecycleService {
  constructor(private readonly aws: AwsCliService, private readonly terraform: TerraformRunnerService) {}

  async reconcileBeforePlan(workdir: string, variables: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
    const expectations = expectedPersistentResources(variables);
    const port: PersistentResourceLifecyclePort = {
      findExact: (expectation) => this.findExact(expectation),
      stateAddresses: async () => new Set(await this.terraform.listTerraformState(workdir, env)),
      importResource: async (expectation, id) => { await this.terraform.importPersistentResource(workdir, expectation.resourceAddress, id, env); },
    };
    return new PersistentResourceLifecycleReconciler(port).reconcile(expectations);
  }

  private async findExact(expectation: PersistentResourceExpectation): Promise<PersistentResourceDescription[]> {
    if (expectation.kind === "ecr_repository") {
      const result = await this.aws.run(["ecr", "describe-repositories", "--repository-names", expectation.identity, "--output", "json"])
        .catch((error) => /RepositoryNotFoundException/.test(error instanceof Error ? error.message : String(error)) ? null : Promise.reject(error));
      if (!result) return [];
      const repositories = (JSON.parse(result.stdout || "{}").repositories || []) as Array<{ repositoryName?: string; repositoryArn?: string }>;
      return Promise.all(repositories.filter((item) => item.repositoryName === expectation.identity && item.repositoryArn).map(async (item) => ({
        id: item.repositoryName!, identity: item.repositoryName!, tags: await this.tags("ecr", item.repositoryArn!),
      })));
    }
    const fileSystems = JSON.parse((await this.aws.run(["efs", "describe-file-systems", "--output", "json"])).stdout || "{}").FileSystems || [];
    const described = await Promise.all((fileSystems as Array<{ FileSystemId?: string }>).filter((item) => item.FileSystemId).map(async (item) => ({
      id: item.FileSystemId!, tags: await this.tags("efs", item.FileSystemId!),
    })));
    if (expectation.kind === "efs_file_system") {
      return described.filter((item) => item.tags.Name === expectation.identity).map((item) => ({ ...item, identity: expectation.identity }));
    }
    const database = expectation.identity.endsWith("-database-access-point");
    const parentIdentity = database ? expectation.identity.replace(/-access-point$/, "") : expectation.identity.replace(/-ap$/, "");
    const parents = described.filter((item) => item.tags.Name === parentIdentity);
    const accessPoints = (await Promise.all(parents.map(async (parent) => {
      const result = await this.aws.run(["efs", "describe-access-points", "--file-system-id", parent.id, "--output", "json"]);
      return (JSON.parse(result.stdout || "{}").AccessPoints || []) as Array<{ AccessPointId?: string }>;
    }))).flat().filter((item) => item.AccessPointId);
    const candidates = await Promise.all(accessPoints.map(async (item) => ({ id: item.AccessPointId!, tags: await this.tags("efs", item.AccessPointId!) })));
    return candidates.filter((item) => database || item.tags.Name === expectation.identity).map((item) => ({ ...item, identity: expectation.identity }));
  }

  private async tags(service: "ecr" | "efs", id: string) {
    const result = service === "ecr"
      ? await this.aws.run(["ecr", "list-tags-for-resource", "--resource-arn", id, "--output", "json"])
      : await this.aws.run(["efs", "list-tags-for-resource", "--resource-id", id, "--output", "json"]);
    const parsed = JSON.parse(result.stdout || "{}") as { tags?: Array<{ Key?: string; Value?: string }>; Tags?: Array<{ Key?: string; Value?: string }> };
    return Object.fromEntries((parsed.tags || parsed.Tags || []).filter((tag) => tag.Key && tag.Value !== undefined).map((tag) => [tag.Key!, tag.Value!]));
  }
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
