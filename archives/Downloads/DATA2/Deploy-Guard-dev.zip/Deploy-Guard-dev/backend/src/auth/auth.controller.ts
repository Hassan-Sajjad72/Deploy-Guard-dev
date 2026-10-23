import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from "@nestjs/common";
import { AuthService } from "./auth.service";
import { GitHubCallbackDto } from "./dto/github-callback.dto";

/**
 * AuthController
 * --------------
 * Defines the HTTP endpoints (URLs) for authentication.
 * The @Controller("auth") means all routes here start with /auth
 *
 * Endpoints:
 * POST /auth/github/callback  → called by Next.js after GitHub OAuth completes
 */
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
}
