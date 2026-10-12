import { IsIn, IsObject, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

export class RegisterApiContractDto {
  @IsUUID() serviceId: string;
  @IsString() @MinLength(1) @MaxLength(256) healthPath: string;
  @IsObject() specification: Record<string, unknown>;
}
export class ApproveApiContractDto {
  @IsString() @MinLength(64) @MaxLength(64) fingerprint: string;
  @IsString() @MinLength(1) @MaxLength(1000) reason: string;
}
export class CreateOptimizationDto {
  @IsUUID() serviceId: string;
  @IsIn(["24h"]) range: "24h";
}
