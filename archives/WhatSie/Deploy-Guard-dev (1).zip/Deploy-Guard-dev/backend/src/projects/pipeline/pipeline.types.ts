export const PIPELINE_QUEUE_NAME = "pipelineQueue";
export const PIPELINE_QUEUE = Symbol("PIPELINE_QUEUE");

export type PipelineJobOptions = {
  triggerGithubActions: boolean;
  buildImage: boolean;
  pushToEcr: boolean;
};

export type PipelineJobData = {
  pipelineRunId: string;
  projectId: string;
  triggeredByUserId: number;
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
  scanId?: string;
  criticalCount?: number;
  highCount?: number;
  mediumCount?: number;
  lowCount?: number;
  policyDecision?: string;
  reason?: string;
  stage?: string;
  status?: string;
};
