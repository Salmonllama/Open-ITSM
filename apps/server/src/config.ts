import { z } from 'zod';

const base64Key32 = z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
  message: 'must be 32 random bytes encoded as base64 (openssl rand -base64 32)',
});

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL'),
  APP_SECRET_KEY: base64Key32,
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  APP_VERSION: z.string().default('0.0.0-dev'),
  WEB_ROOT: z.string().optional(),
  ATTACHMENTS_DIR: z.string().default('/data/attachments'),
  // Microsoft's endpoints; overridden only to test against a stand-in.
  GRAPH_URL: z.url().default('https://graph.microsoft.com/v1.0'),
  LOGIN_URL: z.url().default('https://login.microsoftonline.com'),
});

export type Config = {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  appSecretKey: Buffer;
  sessionSecret: string;
  version: string;
  webRoot: string | undefined;
  attachmentsDir: string;
  graphUrl: string;
  loginUrl: string;
};

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Reads configuration from environment variables. Error messages name the
 * variable and the problem but never echo its value, since several are secrets.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  const parsed = result.data;
  return {
    env: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    appSecretKey: Buffer.from(parsed.APP_SECRET_KEY, 'base64'),
    sessionSecret: parsed.SESSION_SECRET,
    version: parsed.APP_VERSION,
    webRoot: parsed.WEB_ROOT,
    attachmentsDir: parsed.ATTACHMENTS_DIR,
    graphUrl: parsed.GRAPH_URL.replace(/\/+$/, ''),
    loginUrl: parsed.LOGIN_URL.replace(/\/+$/, ''),
  };
}
