import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import helmet from "helmet";
import { AppModule } from "./app.module";

/**
 * bootstrap()
 * -----------
 * This is the ENTRY POINT of the entire NestJS backend.
 * When you run "npm run start:dev", Node.js runs this file first.
 *
 * What happens here:
 * 1. NestFactory.create() → starts the NestJS app
 * 2. helmet() → adds security HTTP headers automatically
 * 3. enableCors() → allows the Vite frontend to call this backend
 * 4. ValidationPipe → validates all request bodies using DTO rules
 * 5. app.listen() → starts the HTTP server on port 5000 by default
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  /**
   * Helmet
   * ------
   * Adds security headers like:
   * - X-Content-Type-Options: nosniff
   * - X-Frame-Options: DENY
   * - Strict-Transport-Security
   * These protect against common web attacks.
   */
  app.use(helmet());

  /**
   * CORS (Cross-Origin Resource Sharing)
   * -------------------------------------
   * Without this, browsers block requests from the frontend to the backend.
   * We allow ONLY our frontend URL to call this backend.
   * credentials: true = allow cookies/auth headers to be sent.
   */
  app.enableCors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-User-Id"],
    credentials: true,
  });

  /**
   * ValidationPipe
   * --------------
   * Automatically validates incoming request bodies.
   * Uses the decorators in our DTO files (@IsString, @IsEmail, etc.)
   * - whitelist: true → strips any fields not in the DTO (security!)
   * - forbidNonWhitelisted: true → rejects request if unknown fields are sent
   */
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true, // Auto-converts types (e.g. "5432" string → 5432 number)
    })
  );

  const port = process.env.PORT || 5000;
  await app.listen(port);

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  NestJS Backend running!
  URL: http://localhost:${port}
  GitHub OAuth: GET /api/auth/github
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);
}

bootstrap();
