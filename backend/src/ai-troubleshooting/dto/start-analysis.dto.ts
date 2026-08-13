import { IsUUID } from "class-validator";
export class StartAnalysisDto { @IsUUID() pipelineRunId: string; }
