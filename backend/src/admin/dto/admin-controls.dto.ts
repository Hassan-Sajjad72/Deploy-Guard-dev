import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator";
import { INTERNAL_ADMIN_ROLES, InternalAdminRole } from "../internal-admin-scope";

export class VerifyAdminIdentityDto { @IsString() @MinLength(1) @MaxLength(200) password: string; }
export class AdminAccountControlDto {
  @IsString() @MinLength(1) @MaxLength(1000) reason: string;
  @IsOptional() @IsBoolean() disabled?: boolean;
  @IsOptional() @IsIn(INTERNAL_ADMIN_ROLES) internalAdminRole?: InternalAdminRole;
}
export class SupportAccessDto {
  @IsInt() @Min(1) operatorUserId: number;
  @IsOptional() @IsUUID() projectId?: string;
  @IsString() @MinLength(1) @MaxLength(1000) purpose: string;
  @IsInt() @Min(5) @Max(1440) durationMinutes: number;
}
