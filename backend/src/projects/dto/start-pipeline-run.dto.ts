import { IsBoolean, IsOptional } from "class-validator";

export class StartPipelineRunDto {
  @IsOptional()
  @IsBoolean()
  triggerGithubActions?: boolean;

  @IsOptional()
  @IsBoolean()
  buildImage?: boolean;

  @IsOptional()
  @IsBoolean()
  pushToEcr?: boolean;
}
