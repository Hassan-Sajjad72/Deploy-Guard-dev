import { Type } from "class-transformer";
import { IsBoolean, IsDefined, IsIn, IsInt, IsNumber, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { HOSTING_PROFILES, HostingProfile, WorkloadAssumptions } from "./deployment-plan";

export class WorkloadAssumptionsDto implements WorkloadAssumptions {
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0.25) @Max(96) cpu: number;
  @IsInt() @Min(256) @Max(393216) memoryMiB: number;
  @IsInt() @Min(0) @Max(16384) storageGiB: number;
  @IsInt() @Min(1) @Max(100) replicas: number;
  @IsInt() @Min(0) @Max(100000000000) monthlyRequests: number;
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(1000000) monthlyTransferGiB: number;
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(1000000) monthlyLogGiB: number;
  @IsIn(["single_instance", "multi_zone"]) availability: WorkloadAssumptions["availability"];
  @IsBoolean() stateful: boolean;
  @IsBoolean() continuousCompute: boolean;
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }) @Min(0) @Max(10000000) monthlyBudgetUsd: number;
}
export class CreateDeploymentPlanDto {
  @IsUUID() bindingId: string;
  @IsString() @Matches(/^[a-z]{2}(?:-[a-z]+)+-\d$/) region: string;
  @IsIn(HOSTING_PROFILES) profile: HostingProfile;
  @IsDefined() @ValidateNested() @Type(() => WorkloadAssumptionsDto) assumptions: WorkloadAssumptionsDto;
}
export class DeploymentPlanDecisionDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/) fingerprint: string;
  @IsIn(["approved", "rejected"]) decision: "approved" | "rejected";
  @IsString() @MinLength(1) @MaxLength(1000) reason: string;
}
export class InterpretDeploymentGoalDto {
  @IsString() @MaxLength(2000) prompt: string;
}
