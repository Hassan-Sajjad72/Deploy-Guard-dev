import { Injectable } from "@nestjs/common";
import { AwsCliService } from "../state-management/aws-cli.service";
import { TerraformRunnerService } from "./terraform-runner.service";

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT = /^(?:dev|production)$/;

export type ProjectLogPurpose = "app" | "database" | "deployment";
export type ProjectLogGroupExpectation = {
  name: string;
  resourceAddress: string;
  purpose: ProjectLogPurpose;
  retentionInDays: number;
};
export type ProjectLogGroupDescription = {
  arn: string;
  name: string;
  retentionInDays: number | null;
  tags: Record<string, string>;
};
export interface ProjectLogGroupLifecyclePort {
  findExact(name: string): Promise<ProjectLogGroupDescription[]>;
  stateAddresses(): Promise<Set<string>>;
  importResource(address: string, name: string): Promise<void>;
}

export function expectedProjectLogGroups(variables: Record<string, unknown>): ProjectLogGroupExpectation[] {
  const projectId = String(variables.project_id || "");
  const environment = String(variables.environment_name || "");
  if (!PROJECT_ID.test(projectId)) throw new Error("CloudWatch reconciliation requires a valid project UUID.");
  if (!ENVIRONMENT.test(environment)) throw new Error("CloudWatch reconciliation requires a supported environment.");
  const prefix = `/deployguard/${projectId}/${environment}`;
  const expected: ProjectLogGroupExpectation[] = [
    { name: `${prefix}/app`, resourceAddress: "module.ecs_service.aws_cloudwatch_log_group.app[0]", purpose: "app", retentionInDays: 14 },
    { name: `${prefix}/deployment`, resourceAddress: "module.ecs_service.aws_cloudwatch_log_group.deployment[0]", purpose: "deployment", retentionInDays: 14 },
  ];
  const database = variables.database_service as { enabled?: unknown } | undefined;
  if (database?.enabled === true) {
    expected.push({ name: `${prefix}/database`, resourceAddress: "module.database_service.aws_cloudwatch_log_group.database[0]", purpose: "database", retentionInDays: 14 });
  }
  return expected;
}

export class ProjectLogGroupLifecycleReconciler {
  constructor(private readonly port: ProjectLogGroupLifecyclePort) {}

  async reconcile(expectations: ProjectLogGroupExpectation[]) {
    const state = await this.port.stateAddresses();
    const results: Array<ProjectLogGroupExpectation & { status: "missing" | "owned"; importResult: "not_required" | "imported" }> = [];
    for (const expected of expectations) {
      const matches = await this.port.findExact(expected.name);
      if (matches.length > 1) throw new Error(`CloudWatch log group ${expected.name} is ambiguous; reconciliation stopped.`);
      if (!matches.length) {
        results.push({ ...expected, status: "missing", importResult: "not_required" });
        continue;
      }
      this.assertOwnership(matches[0], expected);
      if (!state.has(expected.resourceAddress)) {
        await this.port.importResource(expected.resourceAddress, expected.name);
        state.add(expected.resourceAddress);
        results.push({ ...expected, status: "owned", importResult: "imported" });
      } else {
        results.push({ ...expected, status: "owned", importResult: "not_required" });
      }
    }
    return results;
  }

  private assertOwnership(group: ProjectLogGroupDescription, expected: ProjectLogGroupExpectation) {
    const parts = expected.name.split("/");
    const required = {
      ManagedBy: "DeployGuard",
      DeployGuardProjectId: parts[2],
      Environment: parts[3],
      LogPurpose: expected.purpose,
    };
    if (group.name !== expected.name) throw new Error(`CloudWatch log group ${expected.name} failed namespace verification.`);
    for (const [key, value] of Object.entries(required)) {
      if (group.tags[key] !== value) throw new Error(`CloudWatch log group ${expected.name} failed ownership verification (${key}).`);
    }
  }
}

@Injectable()
export class CloudWatchLogLifecycleService {
  constructor(private readonly aws: AwsCliService, private readonly terraform: TerraformRunnerService) {}

  async reconcileBeforePlan(workdir: string, variables: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
    const expectations = expectedProjectLogGroups(variables);
    const port: ProjectLogGroupLifecyclePort = {
      findExact: async (name) => {
        const groupsResult = await this.aws.run(["logs", "describe-log-groups", "--log-group-name-prefix", name, "--output", "json"]);
        const parsed = JSON.parse(groupsResult.stdout || "{}") as { logGroups?: Array<{ arn?: string; logGroupArn?: string; logGroupName?: string; retentionInDays?: number }> };
        const exact = (parsed.logGroups || []).filter((group) => group.logGroupName === name);
        return Promise.all(exact.map(async (group) => {
          const tagsResult = await this.aws.run(["logs", "list-tags-log-group", "--log-group-name", name, "--output", "json"]);
          const tags = JSON.parse(tagsResult.stdout || "{}") as { tags?: Record<string, string> };
          return { arn: group.logGroupArn || group.arn || "", name, retentionInDays: group.retentionInDays ?? null, tags: tags.tags || {} };
        }));
      },
      stateAddresses: async () => new Set(await this.terraform.listTerraformState(workdir, env)),
      importResource: async (address, name) => { await this.terraform.importCloudWatchLogGroup(workdir, address, name, env); },
    };
    return new ProjectLogGroupLifecycleReconciler(port).reconcile(expectations);
  }
}
