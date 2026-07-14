export const PIPELINE_QUEUE_NAME = "pipelineQueue";
export const PIPELINE_QUEUE = Symbol("PIPELINE_QUEUE");

export type PipelineJobOptions = {
  triggerGithubActions: boolean;
  buildImage: boolean;
  pushToEcr: boolean;
  runTerraform: boolean;
};

export type PipelineJobData = {
  pipelineRunId: string;
  projectId: string;
  triggeredByUserId: number;
  jobType?:
    | "pipeline_build"
    | "infrastructure_plan"
    | "infrastructure_apply"
    | "storage_provision"
    | "full_deploy"
    | "resume_after_cost_approval"
    | "resume_after_state_lock";
  resumeOperation?: "plan" | "apply";
  options: PipelineJobOptions;
};

export type PipelineEventMetadata = {
  projectId?: string;
  pipelineRunId?: string;
  repositoryFullName?: string;
  targetBranch?: string;
  commitSha?: string;
  imageTag?: string;
  ecrRepositoryName?: string;
  ecrImageUri?: string;
  shortCommitSha?: string;
  terraformConfigured?: boolean;
  terraformStatus?: string;
  terraformWorkingDirectory?: string;
  scanId?: string;
  criticalCount?: number;
  highCount?: number;
  mediumCount?: number;
  lowCount?: number;
  policyDecision?: string;
  estimateId?: string;
  totalMonthlyCost?: number;
  tierLimitMonthlyCost?: number;
  warningThresholdMonthlyCost?: number;
  approvalRequired?: boolean;
  blockedByTierLimit?: boolean;
  infrastructureEnvironmentId?: string;
  vpcId?: string;
  reason?: string;
  stage?: string;
  status?: string;
  storageId?: string;
  persistentStorageId?: string;
  efsFileSystemId?: string;
  efsAccessPointId?: string;
  backupPlanId?: string;
  backupVaultName?: string;
  deploymentId?: string;
  ecsClusterName?: string;
  ecsServiceName?: string;
  ecsServiceArn?: string;
  taskDefinitionArn?: string;
  albDnsName?: string;
  targetGroupArn?: string;
  toCommitSha?: string;
  diagnosticCode?: string;
  required?: boolean;
};
