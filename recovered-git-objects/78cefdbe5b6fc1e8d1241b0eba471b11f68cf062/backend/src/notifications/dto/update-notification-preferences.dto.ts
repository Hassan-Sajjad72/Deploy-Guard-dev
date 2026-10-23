import { IsBoolean, IsOptional } from "class-validator";

export class UpdateNotificationPreferencesDto {
  @IsBoolean() @IsOptional() criticalEnabled?: boolean;
  @IsBoolean() @IsOptional() successEnabled?: boolean;
  @IsBoolean() @IsOptional() stageUpdatesEnabled?: boolean;
}
