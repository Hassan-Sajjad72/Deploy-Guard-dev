import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthModule } from "./auth/auth.module";
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
     * - entities: [User]       → which TypeScript classes = database tables
     * - synchronize: true      → AUTO-creates/updates tables based on entities
     *                           ⚠️ Set to FALSE in production!
     * - logging: true          → prints SQL queries to console (helps debugging)
     */
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres",
        host: config.get<string>("DB_HOST", "localhost"),
        port: config.get<number>("DB_PORT", 5432),
        username: config.get<string>("DB_USERNAME", "postgres"),
        password: config.get<string>("DB_PASSWORD"),
        database: config.get<string>("DB_NAME", "github_auth_db"),
        entities: [User],
        synchronize: true, // ← creates "users" table automatically
        logging: ["error", "warn"],
        ssl: false, // Set to true if using cloud PostgreSQL (e.g. RDS, Supabase)
      }),
    }),

    AuthModule,
    UsersModule,
  ],
})
export class AppModule {}
