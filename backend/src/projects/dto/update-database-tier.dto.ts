import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";
import { DatabaseTierProvider } from "../project-database-tier.entity";

export class UpdateDatabaseTierDto {
  @IsEnum(DatabaseTierProvider) provider: DatabaseTierProvider;
  @IsOptional() @IsIn(["postgres", "mysql", "mongodb"]) engine?: "postgres" | "mysql" | "mongodb";
  @IsOptional() @IsString() @MaxLength(253) externalHost?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) externalPort?: number;
  @IsOptional() @IsString() @MaxLength(63) @Matches(/^[A-Za-z_][A-Za-z0-9_-]*$/) databaseName?: string;
  @IsOptional() @IsString() @MaxLength(63) @Matches(/^[A-Za-z_][A-Za-z0-9_-]*$/) databaseUser?: string;
  @IsOptional() @IsBoolean() persistenceEnabled?: boolean;
  @IsOptional() @IsBoolean() backupEnabled?: boolean;
  @IsOptional() @IsUUID() attachedServiceId?: string;
}
