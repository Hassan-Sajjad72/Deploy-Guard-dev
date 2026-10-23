import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { UsersService } from "../users/users.service";
import { User } from "../users/user.entity";
import { GitHubCallbackDto } from "./dto/github-callback.dto";
import { SignupDto } from "./dto/signup.dto";
import { LoginDto } from "./dto/login.dto";

export const SESSION_COOKIE_NAME = "deploy_guard_session";
export const GITHUB_STATE_COOKIE_NAME = "deploy_guard_github_state";

type SessionPayload = {
  sub: number;
  iat: number;
  exp: number;
};

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

  constructor(
    private readonly usersService: UsersService,
    private readonly configService: ConfigService
  ) {}

  async signup(dto: SignupDto): Promise<User> {
    const passwordHash = this.hashPassword(dto.password);

    return this.usersService.createWithPassword({
      name: dto.name.trim(),
      email: dto.email.toLowerCase(),
      passwordHash,
    });
  }

  async login(dto: LoginDto): Promise<User> {
    const user = await this.usersService.findByEmailWithPassword(dto.email);

    if (!user?.passwordHash || !this.verifyPassword(dto.password, user.passwordHash)) {
      throw new UnauthorizedException("Invalid email or password");
    }

    return this.usersService.markLoggedIn(user);
  }

  async getUserFromSessionToken(token?: string): Promise<User | null> {
    const payload = this.verifySessionToken(token);

    if (!payload) {
      return null;
    }

    return this.usersService.findById(payload.sub);
  }

  createSessionToken(user: User): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = {
      sub: user.id,
      iat: now,
      exp: now + 7 * 24 * 60 * 60,
    };
    const encodedPayload = this.base64UrlEncode(JSON.stringify(payload));
    const signature = this.sign(encodedPayload);

    return `${encodedPayload}.${signature}`;
  }

  getGithubAuthorizationUrl(state: string): string {
    const clientId = this.configService.get<string>("GITHUB_CLIENT_ID");

    if (!clientId) {
      throw new BadRequestException("GitHub OAuth is not configured");
    }

    const callbackUrl = this.getGithubCallbackUrl();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      scope: "read:user user:email",
      state,
    });

    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  async handleGitHubOAuthCallback(code: string): Promise<User> {
    const clientId = this.configService.get<string>("GITHUB_CLIENT_ID");
    const clientSecret = this.configService.get<string>("GITHUB_CLIENT_SECRET");

    if (!clientId || !clientSecret) {
      throw new BadRequestException("GitHub OAuth is not configured");
    }

    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: this.getGithubCallbackUrl(),
      }),
    });
    const tokenPayload = await tokenResponse.json();
    const accessToken = tokenPayload?.access_token;

    if (!accessToken) {
      throw new UnauthorizedException("GitHub OAuth failed");
    }

    const profileResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    });
    const profile = await profileResponse.json();

    const emailsResponse = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    });
    const emails = emailsResponse.ok ? await emailsResponse.json() : [];
    const primaryEmail =
      emails.find((email: { primary?: boolean; email?: string }) => email.primary)
        ?.email ||
      profile.email ||
      "";

    const { user } = await this.usersService.findOrCreate({
      githubId: String(profile.id),
      name: profile.name || profile.login || "",
      email: primaryEmail,
      image: profile.avatar_url || "",
      login: profile.login || "",
    });

    return user;
  }

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

  toAuthUser(user: User) {
    return {
      id: String(user.id),
      name: user.name,
      email: user.email,
      avatarUrl: user.image,
      role: user.role,
    };
  }

  createOAuthState(): string {
    return randomBytes(24).toString("hex");
  }

  private hashPassword(password: string): string {
    const iterations = 120000;
    const salt = randomBytes(16).toString("hex");
    const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString(
      "hex"
    );

    return `pbkdf2$${iterations}$${salt}$${hash}`;
  }

  private verifyPassword(password: string, storedHash: string): boolean {
    const [algorithm, iterationsValue, salt, expectedHash] = storedHash.split("$");

    if (algorithm !== "pbkdf2" || !iterationsValue || !salt || !expectedHash) {
      return false;
    }

    const hash = pbkdf2Sync(
      password,
      salt,
      Number(iterationsValue),
      32,
      "sha256"
    );
    const expected = Buffer.from(expectedHash, "hex");

    return expected.length === hash.length && timingSafeEqual(expected, hash);
  }

  private verifySessionToken(token?: string): SessionPayload | null {
    if (!token) {
      return null;
    }

    const [encodedPayload, signature] = token.split(".");

    if (
      !encodedPayload ||
      !signature ||
      !this.isSameSignature(this.sign(encodedPayload), signature)
    ) {
      return null;
    }

    try {
      const payload = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf8")
      ) as SessionPayload;

      if (!payload.sub || payload.exp < Math.floor(Date.now() / 1000)) {
        return null;
      }

      return payload;
    } catch {
      return null;
    }
  }

  private sign(value: string): string {
    return createHmac("sha256", this.getSessionSecret())
      .update(value)
      .digest("base64url");
  }

  private isSameSignature(expected: string, actual: string): boolean {
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);

    return (
      expectedBuffer.length === actualBuffer.length &&
      timingSafeEqual(expectedBuffer, actualBuffer)
    );
  }

  private base64UrlEncode(value: string): string {
    return Buffer.from(value).toString("base64url");
  }

  private getSessionSecret(): string {
    return (
      this.configService.get<string>("AUTH_SESSION_SECRET") ||
      "development-only-change-me"
    );
  }

  private getGithubCallbackUrl(): string {
    return (
      this.configService.get<string>("GITHUB_CALLBACK_URL") ||
      "http://localhost:4000/api/auth/github/callback"
    );
  }
}
