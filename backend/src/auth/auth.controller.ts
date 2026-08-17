import {
  Controller,
  Post,
  HttpCode,
  HttpStatus,
  Get,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { Request, Response } from "express";
import { AuditLogService } from "../audit-log/audit-log.service";
import { AuthService } from "./auth.service";
import {
  GITHUB_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "./auth.service";

/**
 * AuthController
 * --------------
 * Defines the HTTP endpoints (URLs) for authentication.
 * The @Controller("auth") means all routes here start with /auth
 *
 * OAuth callbacks are accepted only through the state-validated GET flow.
 */
@Controller(["auth", "api/auth"])
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly auditLogService: AuditLogService
  ) {}

  @Get("me")
  async me(@Req() request: Request) {
    if (!request.user) {
      throw new UnauthorizedException("Authentication required");
    }

    return {
      user: this.authService.toAuthUser(request.user),
    };
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const sessionUser = await this.authService.getUserFromSessionToken(
      this.getCookie(request, SESSION_COOKIE_NAME)
    );
    response.clearCookie(SESSION_COOKIE_NAME, this.cookieOptions());
    await this.auditLogService.record({
      actorUser: sessionUser,
      action: "AUTH_LOGOUT",
      resourceType: "auth",
      resourceId: sessionUser?.id,
      status: "success",
      metadata: { provider: sessionUser?.githubId ? "github" : "email" },
      req: request,
    });

    return {
      message: "Logged out successfully",
    };
  }

  @Get("github")
  async github(@Req() request: Request, @Res() response: Response) {
    try {
      const state = this.authService.createOAuthState();
      response.cookie(GITHUB_STATE_COOKIE_NAME, state, {
        ...this.cookieOptions(),
        maxAge: 10 * 60 * 1000,
      });

      await this.auditLogService.record({
        action: "GITHUB_OAUTH_STARTED",
        resourceType: "auth",
        status: "success",
        metadata: { provider: "github" },
        req: request,
      });

      return response.redirect(this.authService.getGithubAuthorizationUrl(state));
    } catch (error) {
      await this.auditLogService.record({
        action: "GITHUB_OAUTH_FAILED",
        resourceType: "auth",
        status: "failed",
        metadata: { provider: "github", stage: "start" },
        req: request,
      });
      response.clearCookie(GITHUB_STATE_COOKIE_NAME, this.cookieOptions());
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      return response.redirect(`${frontendUrl.replace(/\/$/, "")}/auth/github?error=github_oauth_unavailable`);
    }
  }

  @Get("github/callback")
  async githubOAuthCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Req() request: Request,
    @Res() response: Response
  ) {
    try {
      if (!code || !state || state !== this.getCookie(request, GITHUB_STATE_COOKIE_NAME)) {
        throw new UnauthorizedException("Invalid GitHub OAuth state");
      }

      const user = await this.authService.handleGitHubOAuthCallback(code);
      this.setSessionCookie(response, this.authService.createSessionToken(user));
      response.clearCookie(GITHUB_STATE_COOKIE_NAME, this.cookieOptions());

      await this.auditLogService.record({
        actorUser: user,
        action: "GITHUB_OAUTH_SUCCESS",
        resourceType: "auth",
        resourceId: user.id,
        status: "success",
        metadata: { provider: "github", userId: user.id },
        req: request,
      });

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

      return response.redirect(`${frontendUrl.replace(/\/$/, "")}/auth/github?complete=1`);
    } catch (error) {
      await this.auditLogService.record({
        action: "GITHUB_OAUTH_FAILED",
        resourceType: "auth",
        status: "failed",
        metadata: { provider: "github", stage: "callback" },
        req: request,
      });
      response.clearCookie(GITHUB_STATE_COOKIE_NAME, this.cookieOptions());
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      return response.redirect(`${frontendUrl.replace(/\/$/, "")}/auth/github?error=github_oauth_failed`);
    }
  }

  private setSessionCookie(response: Response, token: string) {
    response.cookie(SESSION_COOKIE_NAME, token, {
      ...this.cookieOptions(),
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: process.env.NODE_ENV === "production",
      path: "/",
    };
  }

  private getCookie(request: Request, name: string): string | undefined {
    const cookieHeader = request.headers.cookie;

    if (!cookieHeader) {
      return undefined;
    }

    return cookieHeader
      .split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${name}=`))
      ?.split("=")[1];
  }

}
