import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AdminModule } from "./admin/admin.module";
import { AuditLogModule } from "./audit-log/audit-log.module";
import { AuditLog } from "./audit-log/audit-log.entity";
import { AuthModule } from "./auth/auth.module";
import { AuthenticatedUserMiddleware } from "./common/middleware/authenticated-user.middleware";
import { ProjectEnvironmentVariable } from "./projects/project-environment-variable.entity";
import { ProjectDetectionProfile } from "./projects/project-detection-profile.entity";
import { ProjectPreflightReport } from "./projects/project-preflight-report.entity";
import { ProjectPipelineEvent } from "./projects/project-pipeline-event.entity";
import { ProjectPipelineRun } from "./projects/project-pipeline-run.entity";
import { ProjectSecurityFinding } from "./projects/project-security-finding.entity";
import { ProjectSecurityScan } from "./projects/project-security-scan.entity";
import { Project } from "./projects/project.entity";
import { ProjectsModule } from "./projects/projects.module";
import { UsersModule } from "./users/users.module";
import { User } from "./users/user.entity";

/**
 * AppModule
 * ---------
 * The ROOT module — the starting point of the entire NestJS app.
 * Every other module is imported here.
 *
 * Key parts:
 * 1. ConfigModule → reads .env file and makes variables available everywhere
 * 2. TypeOrmModule → connects to PostgreSQL using the env variables
 * 3. AuthModule → authentication routes
 * 4. UsersModule → user database operations
 */
@Module({
  imports: [
    /**
     * ConfigModule
     * Reads the .env file and loads all variables.
     * isGlobal: true = no need to import ConfigModule in every other module.
     */
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
    }),

    /**
     * TypeOrmModule — THE DATABASE CONNECTION
     * ----------------------------------------
     * This is where we connect to PostgreSQL.
     * useFactory lets us use ConfigService to read .env values.
     *
     * What each option does:
     * - type: "postgres"       → we're using PostgreSQL
     * - host: DB_HOST          → usually "localhost"
     * - port: DB_PORT          → usually 5432 (PostgreSQL's default port)
     * - username: DB_USERNAME  → your PostgreSQL username (usually "postgres")
     * - password: DB_PASSWORD  → your PostgreSQL password
     * - database: DB_NAME      → the database name you created in pgAdmin
     * - entities              → which TypeScript classes = database tables
     * - synchronize: true      → AUTO-creates/updates tables based on entities
     *                           ⚠️ Set to FALSE in production!
     * - logging: true          → prints SQL queries to console (helps debugging)
     */
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres",
        host: config.get<string>(
          "DATABASE_HOST",
          config.get<string>("DB_HOST", "localhost")
        ),
        port: Number(
          config.get<string>("DATABASE_PORT", config.get<string>("DB_PORT", "5432"))
        ),
        username: config.get<string>(
          "DATABASE_USERNAME",
          config.get<string>("DB_USERNAME", "mini_paas_user")
        ),
        password: config.get<string>(
          "DATABASE_PASSWORD",
          config.get<string>("DB_PASSWORD", "mini_paas_password")
        ),
        database: config.get<string>(
          "DATABASE_NAME",
          config.get<string>("DB_NAME", "mini_paas")
        ),
        entities: [
          User,
          AuditLog,
          Project,
          ProjectEnvironmentVariable,
          ProjectDetectionProfile,
          ProjectPreflightReport,
          ProjectPipelineRun,
          ProjectPipelineEvent,
          ProjectSecurityScan,
          ProjectSecurityFinding,
        ],
        synchronize: true, // ← creates "users" table automatically
        logging: ["error", "warn"],
        ssl:
          config.get<string>("DATABASE_SSL", "false") === "true"
            ? { rejectUnauthorized: false }
            : false,
      }),
    }),

    AuthModule,
    UsersModule,
    AdminModule,
    AuditLogModule,
    ProjectsModule,
  ],
  providers: [AuthenticatedUserMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthenticatedUserMiddleware).forRoutes(
      { path: "api/admin/users", method: RequestMethod.ALL },
      { path: "api/admin/users/:userId/role", method: RequestMethod.ALL },
      { path: "api/audit-logs", method: RequestMethod.ALL },
      { path: "api/auth/me", method: RequestMethod.ALL },
      { path: "auth/me", method: RequestMethod.ALL },
      { path: "api/projects", method: RequestMethod.ALL },
      { path: "api/projects/:projectId", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/detect-stack", method: RequestMethod.ALL },
      {
        path: "api/projects/:projectId/detection-profile",
        method: RequestMethod.ALL,
      },
      { path: "api/projects/:projectId/preflight", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/pipeline/runs", method: RequestMethod.ALL },
      {
        path: "api/projects/:projectId/pipeline/runs/:runId",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/pipeline/runs/:runId/events",
        method: RequestMethod.ALL,
      },
      { path: "api/projects/:projectId/security-scans", method: RequestMethod.ALL },
      {
        path: "api/projects/:projectId/security-scans/:scanId",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/security-scans/:scanId/findings",
        method: RequestMethod.ALL,
      },
      {
        path: "api/projects/:projectId/security-scans/:scanId/approve",
        method: RequestMethod.ALL,
      },
      { path: "api/projects/:projectId/repository", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/branches", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/branch", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/env", method: RequestMethod.ALL },
      { path: "api/projects/:projectId/env/:envId", method: RequestMethod.ALL },
      { path: "api/templates", method: RequestMethod.ALL }
    );
  }
}
