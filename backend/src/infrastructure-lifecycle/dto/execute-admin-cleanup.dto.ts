import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

export class ExecuteAdminCleanupDto {
  @IsUUID() challengeId: string;
  @IsString() @MinLength(16) @MaxLength(256) challengeToken: string;
  @IsString() @MinLength(22) @MaxLength(200) confirmationPhrase: string;
  @IsString() @MinLength(1) @MaxLength(50) environmentName: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) selectedResourceIds?: string[];
}
