import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
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
import { GitHubCallbackDto } from "./dto/github-callback.dto";
import { SignupDto } from "./dto/signup.dto";
import { LoginDto } from "./dto/login.dto";

/**
 * AuthController
 * --------------
 * Defines the HTTP endpoints (URLs) for authentication.
 * The @Controller("auth") means all routes here start with /auth
 *
 * Endpoints:
 * POST /auth/github/callback  → called by Next.js after GitHub OAuth completes
 */
@Controller(["auth", "api/auth"])
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly auditLogService: AuditLogService
  ) {}

  @Post("signup")
  @HttpCode(HttpStatus.OK)
  async signup(
    @Body() dto: SignupDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    try {
      const user = await this.authService.signup(dto);
      this.setSessionCookie(response, this.authService.createSessionToken(user));

      await this.auditLogService.record({
        actorUser: user,
        action: "AUTH_SIGNUP_SUCCESS",
        resourceType: "auth",
        resourceId: user.id,
        status: "success",
        metadata: this.safeAuthMetadata(dto.email, "email"),
        req: request,
      });

      return {
        user: this.authService.toAuthUser(user),
      };
    } catch (error) {
      await this.auditLogService.record({
        action: "AUTH_SIGNUP_FAILED",
        resourceType: "auth",
        status: "failed",
        metadata: this.safeAuthMetadata(dto.email, "email"),
        req: request,
      });
      throw error;
    }
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    try {
      const user = await this.authService.login(dto);
      this.setSessionCookie(response, this.authService.createSessionToken(user));

      await this.auditLogService.record({
        actorUser: user,
        action: "AUTH_LOGIN_SUCCESS",
        resourceType: "auth",
        resourceId: user.id,
        status: "success",
        metadata: this.safeAuthMetadata(dto.email, "email"),
        req: request,
      });

      return {
        user: this.authService.toAuthUser(user),
      };
    } catch (error) {
      await this.auditLogService.record({
        action: "AUTH_LOGIN_FAILED",
        resourceType: "auth",
        status: "failed",
        metadata: this.safeAuthMetadata(dto.email, "email"),
        req: request,
      });
      throw error;
    }
  }

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
      throw error;
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

      return response.redirect(`${frontendUrl.replace(/\/$/, "")}/dashboard`);
    } catch (error) {
      await this.auditLogService.record({
        action: "GITHUB_OAUTH_FAILED",
        resourceType: "auth",
        status: "failed",
        metadata: { provider: "github", stage: "callback" },
        req: request,
      });
      throw error;
    }
  }

  /**
   * Legacy POST /auth/github/callback
   * --------------------------
   * Deprecated compatibility path for older frontend GitHub callbacks.
   * It receives the GitHub user's profile and saves it to PostgreSQL.
   * Do not log or persist dto.accessToken from this route.
   *
   * @Body() dto → NestJS automatically validates the incoming JSON
   *               using the rules in GitHubCallbackDto
   */
  @Post("github/callback")
  @HttpCode(HttpStatus.OK) // Return 200, not 201 (201 = Created, used for resources)
  async githubCallback(@Body() dto: GitHubCallbackDto, @Req() request: Request) {
    try {
      if (!dto.githubId) {
        throw new BadRequestException("githubId is required");
      }

      const result = await this.authService.handleGitHubCallback(dto);
      await this.auditLogService.record({
        action: "GITHUB_OAUTH_LEGACY_CALLBACK_SUCCESS",
        resourceType: "auth",
        resourceId: result.userId,
        status: "success",
        metadata: this.safeLegacyGithubCallbackMetadata(dto.email, result.userId, "success"),
        req: request,
      });

      return result;
    } catch (error) {
      await this.auditLogService.record({
        action: "GITHUB_OAUTH_LEGACY_CALLBACK_FAILED",
        resourceType: "auth",
        status: "failed",
        metadata: this.safeLegacyGithubCallbackMetadata(dto.email, undefined, "failed"),
        req: request,
      });
      throw error;
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

  private safeAuthMetadata(email: string | undefined, provider: string) {
    const domain = email?.includes("@") ? email.split("@").pop()?.toLowerCase() : null;

    return {
      provider,
      emailDomain: domain || null,
    };
  }

  private safeLegacyGithubCallbackMetadata(
    email: string | undefined,
    userId: number | undefined,
    status: string
  ) {
    return {
      provider: "github",
      routeType: "legacy_post_callback",
      userId,
      emailDomain: email?.includes("@") ? email.split("@").pop()?.toLowerCase() : null,
      status,
    };
  }
}
