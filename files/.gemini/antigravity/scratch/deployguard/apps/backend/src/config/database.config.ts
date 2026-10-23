// ═══════════════════════════════════════════════════
// Database Configuration — TypeORM + PostgreSQL
// ═══════════════════════════════════════════════════
// Provides both the NestJS module config (via registerAs) and
// a standalone DataSource for CLI-driven migrations.

import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export const databaseConfig = registerAs(
  'database',
  (): TypeOrmModuleOptions => ({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'deployguard',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'deployguard',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,

    // Entity auto-loading — NestJS discovers via forRootAsync
    autoLoadEntities: true,

    // NEVER synchronize in production — use migrations
    synchronize: process.env.DB_SYNCHRONIZE === 'true',
    logging: process.env.DB_LOGGING === 'true',

    // Migration paths
    migrations: [__dirname + '/../migrations/*{.ts,.js}'],
    migrationsTableName: 'deployguard_migrations',

    // Connection pool tuning
    extra: {
      max: parseInt(process.env.DB_POOL_MAX || '20', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    },
  }),
);
