// ═══════════════════════════════════════════════════
// Application Configuration
// ═══════════════════════════════════════════════════

import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3001', 10),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',

  // JWT
  jwtSecret: process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION',
  jwtExpiration: process.env.JWT_EXPIRATION || '15m',
  jwtRefreshExpiration: process.env.JWT_REFRESH_EXPIRATION || '7d',

  // GitHub OAuth
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    callbackUrl: process.env.GITHUB_CALLBACK_URL || '',
  },

  // AWS
  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    accountId: process.env.AWS_ACCOUNT_ID || '',
  },

  // Redis
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  // Encryption
  encryptionKey: process.env.ENCRYPTION_KEY || 'CHANGE_ME_32_BYTE_KEY_HERE!!!!!',

  // AI / LLM
  llm: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4',
    temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.3'),
  },

  // Infracost
  infracostApiKey: process.env.INFRACOST_API_KEY || '',
}));
