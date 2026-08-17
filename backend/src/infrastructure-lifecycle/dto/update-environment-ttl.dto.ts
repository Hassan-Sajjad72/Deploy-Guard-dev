import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateEnvironmentTtlDto {
  @IsIn(["testing", "preview", "production"])
  environmentType: "testing" | "preview" | "production";

  @IsBoolean()
  autoDestroyEnabled: boolean;

  @IsOptional()
  @IsIn([1, 4, 12, 24])
  ttlHours?: 1 | 4 | 12 | 24;

  @IsOptional()
  @IsDateString()
  ttlExpiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  confirmationPhrase?: string;
}
