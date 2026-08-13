import { IsEnum, IsOptional, IsString, Matches } from "class-validator";
import { ProjectVisibility } from "../project.entity";

export class CreateProjectDto {
  @IsString()
  @IsOptional()
  @Matches(/\S/, { message: "name is required" })
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  @Matches(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/, {
    message: "repositoryUrl must be a GitHub repository URL",
  })
  repositoryUrl?: string;

  @IsString()
  @IsOptional()
  @Matches(/^[^/\s]+\/[^/\s]+$/, { message: "repositoryFullName must be owner/repository" })
  repositoryFullName?: string;

  @IsString()
  @IsOptional()
  targetBranch?: string;

  @IsString()
  @IsOptional()
  @Matches(/^[a-z0-9][a-z0-9-]{0,39}$/, { message: "environmentName must use lowercase letters, numbers, and hyphens" })
  environmentName?: string;

  @IsString()
  @IsOptional()
  @Matches(/^(?:|\.|(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+)$/, {
    message: "appDirectory must be a repository-relative path",
  })
  appDirectory?: string;

  @IsEnum(ProjectVisibility)
  @IsOptional()
  visibility?: ProjectVisibility;
}
