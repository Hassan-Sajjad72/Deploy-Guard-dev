import { IsString, Matches } from "class-validator";

export class UpdateRepositoryDto {
  @IsString()
  @Matches(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/, {
    message: "repositoryUrl must be a GitHub repository URL",
  })
  repositoryUrl: string;
}
