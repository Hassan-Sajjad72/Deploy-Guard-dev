import { IsEnum } from "class-validator";
import { UserRole } from "../../users/user.entity";

export class UpdateUserRoleDto {
  @IsEnum(UserRole)
  role: UserRole;
}
