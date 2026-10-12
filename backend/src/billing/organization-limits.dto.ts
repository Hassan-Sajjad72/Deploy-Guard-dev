import { Type } from "class-transformer";
import { IsDefined, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
export class OrganizationLimitsDto {
  @IsOptional() @IsInt() @Min(1) @Max(100000) members?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(100000) projects?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(100000) environments?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(100000) agencyClients?: number | null;
  @IsOptional() @IsInt() @Min(90) @Max(3650) evidenceRetentionDays?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(10000) aiRequestsPerDay?: number | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000) aiBudgetUsdPerDay?: number | null;
}
export class PublishOrganizationLimitsDto {
  @IsIn(["startup", "team", "agency"]) tier: "startup" | "team" | "agency";
  @IsDefined() @ValidateNested() @Type(() => OrganizationLimitsDto) limits: OrganizationLimitsDto;
  @IsString() @MinLength(1) @MaxLength(1000) reason: string;
  @IsUUID() idempotencyKey: string;
}
