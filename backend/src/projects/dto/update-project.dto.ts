import { Type } from "class-transformer";
import { IsArray, IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { ProjectVisibility } from "../project.entity";

export class DeploymentOverridesDto {
  @IsString() @MaxLength(500) @IsOptional() installCommand?: string;
  @IsString() @MaxLength(500) @IsOptional() buildCommand?: string;
  @IsString() @MaxLength(500) @IsOptional() startCommand?: string;
  @IsString() @MaxLength(200) @Matches(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/) @IsOptional() outputDirectory?: string;
  @IsInt() @Min(1) @Max(65535) @IsOptional() port?: number;
  @IsString() @MaxLength(200) @Matches(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/) @IsOptional() healthCheckPath?: string;
  @IsIn(["static", "server"]) @IsOptional() runtimeType?: "static" | "server";
  @IsArray() @IsString({ each: true }) @Matches(/^[A-Z][A-Z0-9_]*$/, { each: true }) @IsOptional() requiredEnvironmentVariables?: string[];
  @IsIn(["generated", "custom"]) @IsOptional() dockerfileMode?: "generated" | "custom";
}

export class UpdateProjectDto {
  @IsString()
  @Matches(/\S/, { message: "name cannot be empty" })
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsEnum(ProjectVisibility)
  @IsOptional()
  visibility?: ProjectVisibility;

  @IsString()
  @IsOptional()
  @Matches(/^(?:|\.|(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+)$/, {
    message: "appDirectory must be a repository-relative path",
  })
  appDirectory?: string;

  @ValidateNested()
  @Type(() => DeploymentOverridesDto)
  @IsOptional()
  deploymentOverrides?: DeploymentOverridesDto;
}
