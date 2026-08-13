import { IsOptional, IsString, IsUUID } from "class-validator";

export class StartSecurityScanDto {
  @IsOptional()
  @IsUUID()
  pipelineRunId?: string;

  @IsOptional()
  @IsString()
  imageName?: string;
}
