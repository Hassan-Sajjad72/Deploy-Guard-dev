import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";
export class IssueDestroyChallengeDto { @IsOptional() @IsString() @MinLength(1) @MaxLength(50) environmentName?: string; }
