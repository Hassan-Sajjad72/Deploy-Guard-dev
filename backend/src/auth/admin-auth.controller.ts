import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { Request, Response } from "express";
import { AuditLogService } from "../audit-log/audit-log.service";
import { LoginDto } from "./dto/login.dto";
import { ADMIN_SESSION_COOKIE_NAME, AuthService } from "./auth.service";

@Controller("api/admin-auth")
export class AdminAuthController {
  constructor(private readonly auth: AuthService, private readonly audit: AuditLogService) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const user = await this.auth.adminLogin(dto);
    response.cookie(ADMIN_SESSION_COOKIE_NAME, this.auth.createSessionToken(user, "admin"), this.cookieOptions());
    await this.audit.record({ actorUser: user, action: "ADMIN_AUTH_LOGIN", resourceType: "auth", resourceId: user.id, status: "success", metadata: { provider: "admin_password" }, req: request });
    return { user: this.auth.toAuthUser(user) };
  }

  @Get("me")
  me(@Req() request: Request) {
    if (!request.user) throw new UnauthorizedException("Admin authentication required");
    return { user: this.auth.toAuthUser(request.user) };
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.clearCookie(ADMIN_SESSION_COOKIE_NAME, this.cookieOptions());
    if (request.user) await this.audit.record({ actorUser: request.user, action: "ADMIN_AUTH_LOGOUT", resourceType: "auth", resourceId: request.user.id, status: "success", metadata: { provider: "admin_password" }, req: request });
    return { message: "Admin logged out successfully" };
  }

  private cookieOptions() {
    return { httpOnly: true, sameSite: "strict" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 8 * 60 * 60 * 1000 };
  }
}
