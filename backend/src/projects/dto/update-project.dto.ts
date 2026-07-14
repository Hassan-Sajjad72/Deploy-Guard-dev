import { IsEnum, IsOptional, IsString, Matches } from "class-validator";
import { ProjectVisibility } from "../project.entity";

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
}
