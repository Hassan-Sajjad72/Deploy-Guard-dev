import { IsEnum, IsString, MaxLength, MinLength } from "class-validator";
import { UserRole } from "../../users/user.entity";

export class UpdateUserRoleDto {
  @IsEnum(UserRole)
  role: UserRole;
  @IsString() @MinLength(1) @MaxLength(1000) reason: string;
}
