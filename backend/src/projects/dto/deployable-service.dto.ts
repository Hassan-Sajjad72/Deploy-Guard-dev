import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";

export class DeployableServiceInputDto {
  @IsUUID() @IsOptional() id?: string;
  @IsString() @MaxLength(80) @Matches(/\S/, { message: "service name is required" }) name: string;
  @IsString() @MaxLength(512) serviceDirectory: string;
  @IsInt() @Min(1) @Max(65535) @IsOptional() servicePort?: number;
  @IsInt() @Min(0) @Max(999) @IsOptional() position?: number;
}

export class UpdateDeployableServiceDto {
  @IsString() @MaxLength(80) @Matches(/\S/, { message: "service name is required" }) @IsOptional() name?: string;
  @IsString() @MaxLength(512) @IsOptional() serviceDirectory?: string;
  @IsInt() @Min(1) @Max(65535) @IsOptional() servicePort?: number;
  @IsInt() @Min(0) @Max(999) @IsOptional() position?: number;
}
