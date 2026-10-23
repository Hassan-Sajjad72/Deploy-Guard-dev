import { IsBoolean, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class ResolveDeploymentRequirementsDto {
  @IsIn(["managed", "external"])
  databaseProvider: "managed" | "external";

  @IsOptional() @IsString() @Matches(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/)
  databaseName?: string;

  @IsOptional() @IsString() @MaxLength(255)
  externalHost?: string;

  @IsOptional()
  externalPort?: number;

  @IsOptional() @IsBoolean()
  externalTlsRequired?: boolean;

  @IsOptional() @IsObject()
  values?: Record<string, string>;

  @IsOptional() @IsObject()
  generate?: Record<string, boolean>;

  @IsOptional() @IsBoolean()
  saveAndResume?: boolean;

  @IsOptional() @IsString()
  sourceCommit?: string;

  @IsOptional() @IsString()
  scanRevision?: string;
}
