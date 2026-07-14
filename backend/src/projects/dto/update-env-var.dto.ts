import { IsBoolean, IsOptional, IsString, Matches } from "class-validator";

export class UpdateEnvVarDto {
  @IsString()
  @Matches(/^[A-Z_][A-Z0-9_]*$/, {
    message: "key must match environment variable naming rules",
  })
  @IsOptional()
  key?: string;

  @IsString()
  @IsOptional()
  value?: string;

  @IsBoolean()
  @IsOptional()
  isSecret?: boolean;
}
