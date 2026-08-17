import { IsBoolean } from "class-validator";

export class UpdateUserAccessDto {
  @IsBoolean()
  enabled: boolean;
}
