import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  mixin,
  Type,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { UserRole } from "../../users/user.entity";

export function requireRole(allowedRoles: UserRole[]): Type<CanActivate> {
  class RoleGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<Request>();
      const user = request.user;

      if (!user) {
        throw new UnauthorizedException("Authentication required");
      }

      if (!allowedRoles.includes(user.role)) {
        throw new ForbiddenException("Insufficient permissions");
      }

      return true;
    }
  }

  return mixin(RoleGuard);
}
