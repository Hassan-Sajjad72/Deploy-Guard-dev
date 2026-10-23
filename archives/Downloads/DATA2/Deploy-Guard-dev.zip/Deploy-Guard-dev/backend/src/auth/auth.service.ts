import { Injectable, Logger } from "@nestjs/common";
import { UsersService } from "../users/users.service";
import { GitHubCallbackDto } from "./dto/github-callback.dto";

/**
 * AuthService
 * -----------
 * Handles authentication business logic.
 * When the frontend calls our /auth/github/callback endpoint,
 * this service processes the GitHub user data.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly usersService: UsersService) {}

  /**
   * handleGitHubCallback
   * ---------------------
   * This runs every time a user signs in with GitHub.
   *
   * Flow:
   * 1. Frontend (NextAuth) → POST /auth/github/callback with user data
   * 2. This method → calls UsersService to save/update in PostgreSQL
   * 3. Returns whether user is new or existing
   */
  async handleGitHubCallback(dto: GitHubCallbackDto) {
    this.logger.log(`GitHub sign-in: githubId=${dto.githubId}, login=${dto.login}`);

    // Save or update in the database
    const { user, isNewUser } = await this.usersService.findOrCreate({
      githubId: String(dto.githubId), // Ensure it's always a string
      name: dto.name || "",
      email: dto.email || "",
      image: dto.image || "",
      login: dto.login || "",
    });

    if (isNewUser) {
      this.logger.log(`New user created: id=${user.id}, login=${user.githubLogin}`);
    } else {
      this.logger.log(`Existing user updated: id=${user.id}, login=${user.githubLogin}`);
    }

    return {
      success: true,
      isNewUser,
      userId: user.id,
      message: isNewUser ? "Account created successfully" : "Welcome back!",
    };
  }
}
