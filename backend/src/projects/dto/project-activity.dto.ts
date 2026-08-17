import { IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class ProjectActivityDto {
  @IsString()
  @MaxLength(500)
  @Matches(/^\/projects\//, { message: "route must be a project route" })
  route: string;

  @IsString()
  @IsOptional()
  @MaxLength(80)
  section?: string;
}
