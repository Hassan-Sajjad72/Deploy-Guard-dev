// ═══════════════════════════════════════════════════
// Standalone DataSource — for TypeORM CLI migrations
// ═══════════════════════════════════════════════════
// Usage: typeorm migration:run -d dist/config/data-source.js

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

// Load env from monorepo root
dotenv.config({ path: '../../.env' });

import { User } from '../entities/user.entity';
import { Project } from '../entities/project.entity';
import { Deployment } from '../entities/deployment.entity';
import { AuditLog } from '../entities/audit-log.entity';
import { EnvironmentVariable } from '../entities/environment-variable.entity';

export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'deployguard',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE || 'deployguard',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  entities: [User, Project, Deployment, AuditLog, EnvironmentVariable],
  migrations: [__dirname + '/../migrations/*{.ts,.js}'],
  migrationsTableName: 'deployguard_migrations',
  logging: process.env.DB_LOGGING === 'true',
});
