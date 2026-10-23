import { ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient, ListTagsForResourceCommand } from "@aws-sdk/client-ecs";
import { DescribeLoadBalancersCommand, DescribeTargetGroupsCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { Project } from "../projects/project.entity";
import { CustomerAwsSessionService } from "../planning/customer-aws-session.service";
import { resourceFingerprint } from "./intelligence-evidence";
import { planFingerprint } from "../planning/deployment-plan";

@Injectable()
export class CustomerRuntimeEvidenceService {
  constructor(private readonly data: DataSource, private readonly sessions: CustomerAwsSessionService) {}
  private async persisted(project: Project, serviceId: string) {
    if (!project.organizationId || !project.awsAccountBindingId) throw new ServiceUnavailableException("An active customer account binding is required");
    const [record] = await this.data.query(`SELECT release.id AS "releaseId",release.commit_sha AS "sourceSha",release.deployed_at AS "deployedAt",release.deployed_by_pipeline_run_id AS "operationId",release.generation_id AS "generationId",revision.runtime_identity AS identity,revision.image_uri AS "imageUri",revision.image_digest AS "imageDigest",revision.source_sha AS "revisionSourceSha",binding.account_id AS "accountId",plan.content AS plan,plan.fingerprint AS "planFingerprint"
      FROM project_environment_routes route JOIN project_deployment_generations generation ON generation.id=route.live_generation_id AND generation.project_id=route.project_id AND generation.environment_name=route.environment_name AND generation.status='live'
      JOIN project_stable_releases release ON release.project_id=route.project_id AND release.environment_name=route.environment_name AND release.generation_id=generation.id AND release.status='stable' AND release.metadata->>'releaseEvidenceVerified'='true'
      JOIN project_generation_service_revisions revision ON revision.project_id=route.project_id AND revision.generation_id=generation.id AND revision.service_id=$3
      JOIN aws_account_bindings binding ON binding.id=$4 AND binding.organization_id=$5 AND binding.verification_status='verified'
      JOIN deployment_plans plan ON plan.project_id=route.project_id AND plan.organization_id=$5 AND plan.content->>'operationId'=release.deployed_by_pipeline_run_id::text
      JOIN deployment_plan_decisions approval ON approval.plan_id=plan.id AND approval.decision='approved' AND approval.fingerprint=plan.fingerprint
      WHERE route.project_id=$1 AND route.environment_name=$2 ORDER BY release.deployed_at DESC LIMIT 1`, [project.id, project.environmentName, serviceId, project.awsAccountBindingId, project.organizationId]);
    if (!record || planFingerprint(record.plan) !== record.planFingerprint || record.plan.ownership.bindingId !== project.awsAccountBindingId || record.plan.ownership.accountId !== record.accountId || record.plan.ownership.environment !== project.environmentName || !record.plan.services.some((service: any) => service.id === serviceId) || record.plan.repository.sourceSha !== record.sourceSha || record.revisionSourceSha !== record.sourceSha || record.plan.selectedProfile !== "ecs_fargate") throw new ServiceUnavailableException("An approved source-bound customer ECS release and immutable service revision are required");
    const identity = record.identity || {}; const region = record.plan.ownership.region;
    const name = `dg-${project.id.replaceAll("-", "").slice(0, 12)}`; const prefix = `arn:aws:ecs:${region}:${record.accountId}`;
    if (identity.region !== region || identity.ecsClusterArn !== `${prefix}:cluster/${name}` || !String(identity.ecsServiceArn || "").startsWith(`${prefix}:service/${name}/${name}-`) || !String(identity.taskDefinitionArn || "").startsWith(`${prefix}:task-definition/${name}-`) || !/^sha256:[a-f0-9]{64}$/.test(record.imageDigest)) throw new ConflictException("Customer runtime resource scope does not match the approved project, account and region");
    return { ...record, region, serviceId, scope: { projectId: project.id, organizationId: project.organizationId, bindingId: project.awsAccountBindingId, region, operationId: record.operationId, purpose: "read" as const } };
  }
  private async observe(project: Project, serviceId: string, measurement: boolean, endpoint: boolean) {
    const record = await this.persisted(project, serviceId);
    return this.sessions.withEcsSession(record.scope, async ({ credentials, region }) => {
      const ecs = new ECSClient({ region, credentials, maxAttempts: 1 });
      const cloudwatch = measurement ? new CloudWatchClient({ region, credentials, maxAttempts: 1 }) : null;
      const elb = endpoint ? new ElasticLoadBalancingV2Client({ region, credentials, maxAttempts: 1 }) : null;
      try {
        const signal = AbortSignal.timeout(15_000); const identity = record.identity;
        const [services, task, tags] = await Promise.all([
          ecs.send(new DescribeServicesCommand({ cluster: identity.ecsClusterArn, services: [identity.ecsServiceArn] }), { abortSignal: signal }),
          ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: identity.taskDefinitionArn }), { abortSignal: signal }),
          ecs.send(new ListTagsForResourceCommand({ resourceArn: identity.ecsServiceArn }), { abortSignal: signal }),
        ]);
        const service = services.services?.[0]; const owned = (key: string, value: string) => tags.tags?.some((tag) => tag.key === key && tag.value === value);
        if (services.failures?.length || !service || service.serviceArn !== identity.ecsServiceArn || service.clusterArn !== identity.ecsClusterArn || service.taskDefinition !== identity.taskDefinitionArn || service.status !== "ACTIVE" || !owned("DeployGuardProjectId", project.id) || !owned("ManagedBy", "DeployGuard") || task.taskDefinition?.taskDefinitionArn !== identity.taskDefinitionArn || !task.taskDefinition.containerDefinitions?.some((container) => container.name === identity.applicationContainerName && container.image === record.imageUri && container.image.endsWith(`@${record.imageDigest}`))) throw new ConflictException("Customer runtime observation failed exact ownership, image or release validation");
        if (endpoint) {
          const prefix = `arn:aws:elasticloadbalancing:${region}:${record.accountId}:`;
          if (!String(identity.albArn || "").startsWith(`${prefix}loadbalancer/app/`) || !String(identity.targetGroupArn || "").startsWith(`${prefix}targetgroup/`)) throw new ConflictException("Customer application endpoint ownership is incomplete");
          const [lbs, groups] = await Promise.all([elb!.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [identity.albArn] }), { abortSignal: signal }), elb!.send(new DescribeTargetGroupsCommand({ TargetGroupArns: [identity.targetGroupArn] }), { abortSignal: signal })]);
          const lb = lbs.LoadBalancers?.[0]; const group = groups.TargetGroups?.[0]; const url = new URL(identity.publicUrl || "");
          if (url.hostname !== lb?.DNSName || lb.LoadBalancerArn !== identity.albArn || group?.TargetGroupArn !== identity.targetGroupArn || !group.LoadBalancerArns?.includes(identity.albArn) || !service.loadBalancers?.some((attachment) => attachment.targetGroupArn === identity.targetGroupArn && attachment.containerName === identity.applicationContainerName)) throw new ConflictException("Customer endpoint DNS and target routing do not match the verified service");
        }
        const end = new Date(); const start = new Date(end.getTime() - 24 * 3600_000);
        const rows: any[] = [];
        if (measurement && new Date(record.deployedAt).getTime() <= start.getTime()) {
          const dimensions = [{ Name: "ClusterName", Value: identity.ecsClusterArn.split("/").pop() }, { Name: "ServiceName", Value: identity.ecsServiceArn.split("/").pop() }];
          const response = await cloudwatch!.send(new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: [
            { Id: "cpu", ReturnData: true, MetricStat: { Period: 300, Stat: "Average", Metric: { Namespace: "AWS/ECS", MetricName: "CPUUtilization", Dimensions: dimensions } } },
            { Id: "memory", ReturnData: true, MetricStat: { Period: 300, Stat: "Average", Metric: { Namespace: "AWS/ECS", MetricName: "MemoryUtilization", Dimensions: dimensions } } },
          ] }), { abortSignal: signal });
          if (!response.NextToken) for (const result of response.MetricDataResults || []) if (result.StatusCode === "Complete" && ["cpu", "memory"].includes(result.Id || "")) for (let index = 0; index < (result.Timestamps?.length || 0); index++) rows.push({ metric_name: result.Id === "cpu" ? "ecs_cpu_utilization" : "ecs_memory_utilization", timestamp: result.Timestamps![index].toISOString(), value: result.Values?.[index], labels: { releaseId: record.releaseId, serviceId } });
        }
        const current = await this.persisted(project, serviceId);
        if (current.releaseId !== record.releaseId || resourceFingerprint(current.identity) !== resourceFingerprint(identity)) throw new ConflictException("Customer release changed during observation");
        return { record, allocation: { cpu: Number(task.taskDefinition!.cpu) / 1024, memoryMiB: Number(task.taskDefinition!.memory), replicas: service.desiredCount || 0 }, rows, start, end };
      } finally { ecs.destroy(); cloudwatch?.destroy(); elb?.destroy(); }
    });
  }
  async apiTarget(project: Project, serviceId: string) {
    const { record } = await this.observe(project, serviceId, false, true);
    const url = new URL(record.identity.publicUrl || "");
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) throw new ConflictException("Customer API assurance requires a verified credential-free HTTPS release endpoint");
    return { projectId: project.id, organizationId: project.organizationId, environment: project.environmentName, serviceId, origin: url.origin, releaseId: record.releaseId, sourceSha: record.sourceSha, generationId: record.generationId, resourceFingerprint: resourceFingerprint(record.identity) };
  }
  measure(project: Project, serviceId: string) { return this.observe(project, serviceId, true, false); }
}
