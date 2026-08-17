import { IsBoolean, IsEmail, IsOptional, MaxLength } from "class-validator";

export class UpdateNotificationPreferencesDto {
  @IsBoolean() @IsOptional() enabled?: boolean;
  @IsBoolean() @IsOptional() criticalEnabled?: boolean;
  @IsBoolean() @IsOptional() successEnabled?: boolean;
  @IsBoolean() @IsOptional() stageUpdatesEnabled?: boolean;
}

export class SubscribeNotificationDto {
  @IsEmail() @MaxLength(320) email: string;
}
