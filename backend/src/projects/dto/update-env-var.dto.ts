import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class UpdateEnvVarDto {
  @IsString()
  @Matches(/^[A-Z_][A-Z0-9_]*$/, {
    message: "key must match environment variable naming rules",
  })
  @IsOptional()
  key?: string;

  @IsString()
  @Matches(/\S/, { message: "value is required" })
  @IsOptional()
  value?: string;

  @IsBoolean()
  @IsOptional()
  isSecret?: boolean;

  @IsIn(["build", "runtime", "both"])
  @IsOptional()
  scope?: "build" | "runtime" | "both";

  @IsBoolean()
  @IsOptional()
  isRequired?: boolean;

  @IsString()
  @MaxLength(240)
  @IsOptional()
  detectedSource?: string;
}
