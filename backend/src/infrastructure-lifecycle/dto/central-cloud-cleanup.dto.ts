import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

export class CentralCloudResourceQueryDto {
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsString() @MaxLength(80) resourceType?: string;
  @IsOptional() @IsString() @MaxLength(80) status?: string;
  @IsOptional() @IsString() @MaxLength(20) risk?: string;
  @IsOptional() @IsString() @MaxLength(40) region?: string;
  @IsOptional() @IsIn(["safe", "manual", "protected"]) eligibility?: string;
}

export class IssueCentralCleanupChallengeDto {
  @IsIn(["selected", "safe_orphans", "emergency_non_production"]) action: "selected" | "safe_orphans" | "emergency_non_production";
}

export class ExecuteCentralCleanupDto {
  @IsUUID() challengeId: string;
  @IsString() @MinLength(16) @MaxLength(256) challengeToken: string;
  @IsString() @MinLength(18) @MaxLength(100) confirmationPhrase: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID(undefined, { each: true }) resourceIds?: string[];
}

export class RetryCentralProjectDestroyDto {
  @IsUUID() projectId: string;
  @IsUUID() operationId: string;
}

export class MarkProjectCleanupCompleteDto {
  @IsUUID() projectId: string;
}

export class MarkCentralManualReviewDto {
  @IsArray() @ArrayMaxSize(200) @IsUUID(undefined, { each: true }) resourceIds: string[];
}
