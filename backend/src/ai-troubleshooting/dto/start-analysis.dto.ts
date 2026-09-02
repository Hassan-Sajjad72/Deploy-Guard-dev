import { IsOptional, IsUUID } from "class-validator";
export class StartAnalysisDto { @IsUUID() pipelineRunId: string; @IsOptional() @IsUUID() serviceId?: string; }
