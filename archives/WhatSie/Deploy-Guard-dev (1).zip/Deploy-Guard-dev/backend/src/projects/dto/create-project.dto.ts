import { IsEnum, IsOptional, IsString, Matches } from "class-validator";
import { ProjectVisibility } from "../project.entity";

export class CreateProjectDto {
  @IsString()
  @Matches(/\S/, { message: "name is required" })
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @Matches(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/, {
    message: "repositoryUrl must be a GitHub repository URL",
  })
  repositoryUrl: string;

  @IsString()
  @IsOptional()
  targetBranch?: string;

  @IsEnum(ProjectVisibility)
  @IsOptional()
  visibility?: ProjectVisibility;
}
