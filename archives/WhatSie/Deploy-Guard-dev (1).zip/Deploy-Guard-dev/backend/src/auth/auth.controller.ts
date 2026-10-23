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
  constructor(private readonly authService: AuthService) {}

  @Post("signup")
  @HttpCode(HttpStatus.OK)
  async signup(
    @Body() dto: SignupDto,
    @Res({ passthrough: true }) response: Response
  ) {
    const user = await this.authService.signup(dto);
    this.setSessionCookie(response, this.authService.createSessionToken(user));

    return {
      user: this.authService.toAuthUser(user),
    };
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response
  ) {
    const user = await this.authService.login(dto);
    this.setSessionCookie(response, this.authService.createSessionToken(user));

    return {
      user: this.authService.toAuthUser(user),
    };
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
  async logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(SESSION_COOKIE_NAME, this.cookieOptions());

    return {
      message: "Logged out successfully",
    };
  }

  @Get("github")
  async github(@Res() response: Response) {
    const state = this.authService.createOAuthState();
    response.cookie(GITHUB_STATE_COOKIE_NAME, state, {
      ...this.cookieOptions(),
      maxAge: 10 * 60 * 1000,
    });

    return response.redirect(this.authService.getGithubAuthorizationUrl(state));
  }

  @Get("github/callback")
  async githubOAuthCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Req() request: Request,
    @Res() response: Response
  ) {
    if (!code || !state || state !== this.getCookie(request, GITHUB_STATE_COOKIE_NAME)) {
      throw new UnauthorizedException("Invalid GitHub OAuth state");
    }

    const user = await this.authService.handleGitHubOAuthCallback(code);
    this.setSessionCookie(response, this.authService.createSessionToken(user));
    response.clearCookie(GITHUB_STATE_COOKIE_NAME, this.cookieOptions());

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

    return response.redirect(`${frontendUrl.replace(/\/$/, "")}/dashboard`);
  }

  /**
   * POST /auth/github/callback
   * --------------------------
   * NextAuth calls this from the frontend signIn() callback.
   * It receives the GitHub user's profile and saves it to PostgreSQL.
   *
   * @Body() dto → NestJS automatically validates the incoming JSON
   *               using the rules in GitHubCallbackDto
   */
  @Post("github/callback")
  @HttpCode(HttpStatus.OK) // Return 200, not 201 (201 = Created, used for resources)
  async githubCallback(@Body() dto: GitHubCallbackDto) {
    if (!dto.githubId) {
      throw new BadRequestException("githubId is required");
    }

    return this.authService.handleGitHubCallback(dto);
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
