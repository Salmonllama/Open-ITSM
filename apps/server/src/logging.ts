import type pino from 'pino';
import { TOKEN_PREFIX } from './auth/tokens.js';

const TOKEN_IN_TEXT = new RegExp(`${TOKEN_PREFIX}[0-9A-Za-z_-]+`, 'g');

/** Replaces anything shaped like an API token, so a token sent in a URL never reaches the log. */
export function scrubTokens(text: string): string {
  return text.replace(TOKEN_IN_TEXT, `${TOKEN_PREFIX}[redacted]`);
}

type RawRequest = {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
};

/**
 * Logger options for the app. Headers are never logged by Fastify's request serializer; the
 * redact paths are a second line of defence should a header object reach a log call.
 */
export function loggerOptions(level: string): pino.LoggerOptions {
  return {
    level,
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
      'headers.authorization',
      'headers.cookie',
    ],
    serializers: {
      req: (req: RawRequest) => ({
        method: req.method,
        url: req.url === undefined ? undefined : scrubTokens(req.url),
        host: req.host,
        remoteAddress: req.ip ?? req.socket?.remoteAddress,
      }),
    },
  };
}
