import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";
export class RequestRecoveryDto {
  @IsUUID() incidentId: string;
  @IsIn(["verified_rollback", "idempotent_retry", "ecs_restart", "bounded_replicas"]) runbookId: string;
  @IsNumber() @Min(0) @Max(1000000) monthlyBudgetUsd: number;
  @IsOptional() @IsUUID() serviceId?: string;
  @IsOptional() @IsUUID() targetOperationId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(4) replicas?: number;
}
export class RecoveryDecisionDto {
  @Matches(/^[a-f0-9]{64}$/) fingerprint: string;
  @IsIn(["approved", "rejected"]) decision: "approved" | "rejected";
  @IsString() @MaxLength(1000) reason: string;
}
export class RecoveryExecutionDto { @Matches(/^[a-f0-9]{64}$/) fingerprint: string; }
export class RepairFileDto { @IsString() @MaxLength(200) path: string; @IsString() @MaxLength(131072) content: string; }
export class ProposeRepairDto {
  @IsUUID() incidentId: string;
  @Matches(/^[a-f0-9]{40}$/i) sourceSha: string;
  @IsString() @MaxLength(2000) defectEvidence: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => RepairFileDto) files: RepairFileDto[];
}
