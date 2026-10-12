import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { UsersService } from "../users/users.service";
import { User } from "../users/user.entity";
import { UserRole } from "../users/user.entity";
import { SignupDto } from "./dto/signup.dto";
import { LoginDto } from "./dto/login.dto";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThanOrEqual, Repository } from "typeorm";
import { SessionRevocation } from "./session-revocation.entity";

export const SESSION_COOKIE_NAME = "deploy_guard_session";
export const ADMIN_SESSION_COOKIE_NAME = "deploy_guard_admin_session";
export const GITHUB_STATE_COOKIE_NAME = "deploy_guard_github_state";

type SessionPayload = {
  sub: number;
  audience: "developer" | "admin";
  iat: number;
  exp: number;
  nonce: string;
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
  constructor(
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
    @InjectRepository(SessionRevocation) private readonly revocations: Repository<SessionRevocation>,
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

    if (!user?.passwordHash || user.disabledAt || !this.verifyPassword(dto.password, user.passwordHash)) {
      throw new UnauthorizedException("Invalid email or password");
    }

    return this.usersService.markLoggedIn(user);
  }

  async adminLogin(dto: LoginDto): Promise<User> {
    const user = await this.login(dto);
    if (user.role !== UserRole.ADMIN || user.githubId) throw new UnauthorizedException("Invalid admin credentials");
    return user;
  }

  async getUserFromSessionToken(token?: string, audience: "developer" | "admin" = "developer"): Promise<User | null> {
    const payload = this.verifySessionToken(token);

    if (!payload) {
      return null;
    }

    if (payload.audience !== audience) return null;
    if (await this.revocations.existsBy({ tokenHash: createHash("sha256").update(token!).digest("hex") })) return null;
    const user = await this.usersService.findById(payload.sub);
    if (!user || user.disabledAt) return null;
    if (audience === "admin") return user.role === UserRole.ADMIN && !user.githubId ? user : null;
    return user.githubId && user.role !== UserRole.ADMIN ? user : null;
  }

  createSessionToken(user: User, audience: "developer" | "admin" = "developer"): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = {
      sub: user.id,
      audience,
      iat: now,
      exp: now + (audience === "admin" ? 8 * 60 * 60 : 7 * 24 * 60 * 60),
      nonce: randomBytes(16).toString("hex"),
    };
    const encodedPayload = this.base64UrlEncode(JSON.stringify(payload));
    const signature = this.sign(encodedPayload);

    return `${encodedPayload}.${signature}`;
  }

  async revokeSessionToken(token?: string, audience: "developer" | "admin" = "developer") {
    const payload = this.verifySessionToken(token);
    if (!payload || payload.audience !== audience) return;
    await this.revocations.upsert({
      tokenHash: createHash("sha256").update(token!).digest("hex"),
      expiresAt: new Date(payload.exp * 1000),
    }, ["tokenHash"]);
    await this.revocations.delete({ expiresAt: LessThanOrEqual(new Date()) });
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
      scope: "read:user user:email repo",
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

    if (user.disabledAt) {
      throw new UnauthorizedException("GitHub account is disabled");
    }

    if (user.role === UserRole.ADMIN) {
      throw new UnauthorizedException("Administrator accounts must use the separate admin login.");
    }

    await this.usersService.storeGithubAccessToken(user.id, accessToken);

    return user;
  }

  toAuthUser(user: User) {
    return {
      id: String(user.id),
      name: user.name,
      email: user.email,
      avatarUrl: user.image,
      githubLogin: user.githubLogin,
      role: user.role,
      internalAdminRole: user.role === UserRole.ADMIN ? user.internalAdminRole : null,
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

    const [encodedPayload, signature, extra] = token.split(".");

    if (
      !encodedPayload ||
      !signature ||
      extra !== undefined ||
      !this.isSameSignature(this.sign(encodedPayload), signature)
    ) {
      return null;
    }

    try {
      const payload = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf8")
      ) as SessionPayload;

      if (!Number.isSafeInteger(payload.sub) || payload.sub <= 0 || !["developer", "admin"].includes(payload.audience) || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) || payload.iat > Math.floor(Date.now() / 1000) || payload.exp <= Math.floor(Date.now() / 1000)) {
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
    const secret = this.configService.get<string>("AUTH_SESSION_SECRET")?.trim();

    if (!secret || secret.length < 32 || secret.includes("change_this")) {
      throw new Error(
        "AUTH_SESSION_SECRET must be configured with at least 32 characters"
      );
    }

    return secret;
  }

  private getGithubCallbackUrl(): string {
    return (
      this.configService.get<string>("GITHUB_CALLBACK_URL") ||
      "http://localhost:5000/api/auth/github/callback"
    );
  }
}
