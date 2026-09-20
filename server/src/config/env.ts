import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const getRequiredEnv = (key: string): string => {
  const value = process.env[key];

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
};

const parsePort = (value: string | undefined): number => {
  const port = Number(value ?? 5000);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('PORT must be a positive integer');
  }

  return port;
};

/**
 * Express `trust proxy` setting, from TRUST_PROXY.
 *   unset / "false"  -> false   : req.ip is the socket address; X-Forwarded-For is ignored (safe default)
 *   "<integer>"      -> number  : trust that many proxy hops (e.g. "1" behind a single nginx/Render/Railway proxy)
 *   anything else    -> string  : passed through — "loopback", "uniquelocal", or a comma-separated IP/CIDR list
 *   "true"           -> rejected: trusting every X-Forwarded-For lets any client spoof its IP in audit logs
 *                                 and defeats per-IP rate limiting.
 */
const parseTrustProxy = (value: string | undefined): boolean | number | string => {
  const trimmed = value?.trim() ?? '';
  const normalized = trimmed.toLowerCase();

  if (!normalized || normalized === 'false' || normalized === '0') {
    return false;
  }

  if (normalized === 'true') {
    throw new Error('TRUST_PROXY=true is not allowed: use a hop count (e.g. 1), "loopback", or an IP/CIDR list');
  }

  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  return trimmed;
};

export const env = {
  port: parsePort(process.env.PORT),
  mongoUri: getRequiredEnv('MONGO_URI'),
  jwtSecret: getRequiredEnv('JWT_SECRET'),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
} as const;
