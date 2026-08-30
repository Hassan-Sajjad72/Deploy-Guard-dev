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

}
