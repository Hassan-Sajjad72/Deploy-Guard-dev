import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DescribeClustersCommand, ECSClient } from "@aws-sdk/client-ecs";
type SharedFoundation = { ecsClusterArn: string; ecsClusterName: string };
type EcsSender = { send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<any> };

export type SharedEcsClusterRecord = {
  clusterArn?: string;
  clusterName?: string;
  status?: string;
  tags?: Array<{ key?: string; value?: string }>;
};

export function validateSharedEcsCluster(
  foundation: Pick<SharedFoundation, "ecsClusterArn" | "ecsClusterName">,
  clusters: SharedEcsClusterRecord[],
  failures: Array<{ arn?: string; reason?: string }> = [],
) {
  const cluster = clusters.find((item) => item.clusterArn === foundation.ecsClusterArn);
  if (!cluster || failures.length) {
    throw new Error("The canonical DeployGuard shared ECS cluster does not exist.");
  }
  if (cluster.clusterName !== foundation.ecsClusterName || cluster.status !== "ACTIVE") {
    throw new Error("The canonical DeployGuard shared ECS cluster is inactive or has an unexpected identity.");
  }
  const tags = new Map((cluster.tags || []).map((tag) => [tag.key, tag.value]));
  if (tags.get("ManagedBy") !== "DeployGuard" || tags.get("DeployGuardScope") !== "shared-platform") {
    throw new Error("The configured ECS cluster is not verified DeployGuard shared-platform infrastructure.");
  }
  return cluster;
}

@Injectable()
export class SharedPlatformFoundationService {
  constructor(private readonly config: ConfigService) {}

  async assertActive(foundation: SharedFoundation, sender?: EcsSender) {
    const region = this.config.get<string>("AWS_REGION", "us-east-1");
    const client = sender || new ECSClient({ region });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    timeout.unref();
    try {
      const response = await client.send(new DescribeClustersCommand({
        clusters: [foundation.ecsClusterArn],
        include: ["TAGS"],
      }), { abortSignal: controller.signal });
      return validateSharedEcsCluster(foundation, response.clusters || [], response.failures || []);
    } catch (error) {
      throw new ServiceUnavailableException({
        code: "shared_ecs_cluster_unavailable",
        classification: "platform_configuration",
        message: "The canonical DeployGuard shared ECS cluster is missing or inactive.",
        detail: `${error instanceof Error ? error.message : "Shared ECS cluster verification failed."} Reconcile the DeployGuard platform foundation before retrying this operation.`,
      });
    } finally {
      clearTimeout(timeout);
      if (!sender) (client as ECSClient).destroy();
    }
  }
}
