import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsDefined, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { HOSTING_PROFILES, HostingProfile, WorkloadAssumptions } from "./deployment-plan";

export class WorkloadPricingQuantitiesDto {
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(1000000000) imageStorageGiB: number;
  @IsInt() @Min(0) @Max(1000000000) publicIpv4Count: number;
  @IsInt() @Min(0) @Max(1000000000) albNewConnectionsPerSecond: number;
  @IsInt() @Min(0) @Max(1000000000) albActiveConnectionsPerMinute: number;
  @IsInt() @Min(0) @Max(1000000000) albRuleEvaluationsPerSecond: number;
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(1000000000) monthlyIntraRegionGiB: number;
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(1000000000) stateStorageGiB: number;
  @IsInt() @Min(0) @Max(1000000000) monthlyStateWriteRequests: number;
  @IsInt() @Min(0) @Max(1000000000) monthlyStateReadRequests: number;
  @IsInt() @Min(0) @Max(1000000000) monthlySecretApiRequests: number;
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(1000000000) backupStorageGiB: number;
}
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
  @IsOptional() @ValidateNested() @Type(() => WorkloadPricingQuantitiesDto) pricing?: WorkloadPricingQuantitiesDto;
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }) @Min(0) @Max(10000000) monthlyBudgetUsd: number;
}
export class CustomerInfrastructureDto {
  @IsOptional() @IsString() @Matches(/^arn:aws:iam::[0-9]{12}:policy\/deployguard\/[0-9a-f-]{36}\/ecs-task-boundary$/) executionRolePermissionsBoundaryArn?: string;
  @IsString() @Matches(/^vpc-[0-9a-f]{8}(?:[0-9a-f]{9})?$/) vpcId: string;
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(6) @ArrayUnique() @Matches(/^subnet-[0-9a-f]{8}(?:[0-9a-f]{9})?$/, { each: true }) publicSubnetIds: string[];
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/) terraformStateBucket: string;
}
export class CreateDeploymentPlanDto {
  @IsOptional() @IsObject() profileInputs?: Record<string, unknown>;
  @IsUUID() bindingId: string;
  @IsString() @Matches(/^[a-z]{2}(?:-[a-z]+)+-\d$/) region: string;
  @IsIn(HOSTING_PROFILES) profile: HostingProfile;
  @IsDefined() @ValidateNested() @Type(() => WorkloadAssumptionsDto) assumptions: WorkloadAssumptionsDto;
  @IsOptional() @ValidateNested() @Type(() => CustomerInfrastructureDto) infrastructure?: CustomerInfrastructureDto;
}
export class ExecuteDeploymentPlanDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/) fingerprint: string;
}
export class DeploymentPlanDecisionDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/) fingerprint: string;
  @IsIn(["approved", "rejected"]) decision: "approved" | "rejected";
  @IsString() @MinLength(1) @MaxLength(1000) reason: string;
}
export class InterpretDeploymentGoalDto {
  @IsString() @MaxLength(2000) prompt: string;
}

export class CreateCustomerLifecyclePlanDto {
  @IsIn(["rollback", "destroy"]) action: "rollback" | "destroy";
  @IsOptional() @IsUUID() targetOperationId?: string;
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }) @Min(0) @Max(10000000) monthlyBudgetUsd: number;
  @IsString() @MinLength(1) @MaxLength(1000) reason: string;
  @IsOptional() @IsString() @MaxLength(20) confirmationPhrase?: string;
}
