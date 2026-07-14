import { Injectable, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import { AuthService, SESSION_COOKIE_NAME } from "../../auth/auth.service";
import { UsersService } from "../../users/users.service";

@Injectable()
export class AuthenticatedUserMiddleware implements NestMiddleware {
  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthService
  ) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const sessionToken = this.getCookie(req, SESSION_COOKIE_NAME);

    if (sessionToken) {
      req.user = await this.authService.getUserFromSessionToken(sessionToken);

      if (req.user) {
        return next();
      }
    }

    const allowInsecureUserHeader =
      process.env.NODE_ENV !== "production" &&
      process.env.ALLOW_INSECURE_USER_HEADER === "true";
    const userId = allowInsecureUserHeader ? req.header("x-user-id") : undefined;

    if (!userId) {
      return next();
    }

    const parsedUserId = Number(userId);

    if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
      return next();
    }

    req.user = await this.usersService.findById(parsedUserId);

    return next();
  }

  private getCookie(req: Request, name: string): string | undefined {
    const cookieHeader = req.headers.cookie;

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
