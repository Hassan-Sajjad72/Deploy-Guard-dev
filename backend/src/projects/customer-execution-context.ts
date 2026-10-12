import type { CustomerAwsContext } from "../planning/customer-aws-session.service";
import type { WorkloadAssumptions } from "../planning/deployment-plan";

export type CustomerExecutionContext = CustomerAwsContext & {
  organizationId: string; bindingId: string; bindingVersion: number; roleArn: string;
  projectId: string; operationId: string; environmentName: string;
  planId: string; planFingerprint: string;
  deploymentAction: "deploy" | "rollback" | "destroy";
  retry?: { failedOperationId: string; failureFingerprint: string };
  lifecycle?: { action: "rollback" | "destroy"; targetOperationId: string; targetReleaseId: string; targetGenerationId: string; targetFingerprint: string; liveGenerationId: string };
  configurationFingerprint: string; sourceSha: string; assumptions: WorkloadAssumptions;
  buildTargetFingerprints: Array<{serviceId: string; fingerprint: string}>; requirementFingerprint: string;
  vpcId: string; publicSubnetIds: string[]; terraformStateBucket: string; executionRolePermissionsBoundaryArn: string;
};
