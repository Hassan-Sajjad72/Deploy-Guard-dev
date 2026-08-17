import { IsBoolean, IsIn, IsObject, IsOptional, IsString, Matches } from "class-validator";

export class ResolveDeploymentRequirementsDto {
  @IsIn(["managed"])
  databaseProvider: "managed";

  @IsOptional() @IsString() @Matches(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/)
  databaseName?: string;

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
