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

export const MASTER_KEY_GENERATE_HINT = 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"';

/**
 * DOCUMENT_MASTER_KEY: the key-encryption key that wraps every document's per-file data key.
 * Exactly 32 bytes, given as base64 (44 chars) or hex (64 chars). There is deliberately no development
 * fallback: a silently generated ephemeral key next to a persistent database would make every encrypted
 * file unreadable after a restart. Losing this key loses every document — back it up.
 */
const parseMasterKey = (value: string | undefined): Buffer => {
  const trimmed = value?.trim() ?? '';

  if (!trimmed) {
    throw new Error(`Missing required environment variable: DOCUMENT_MASTER_KEY (generate one with: ${MASTER_KEY_GENERATE_HINT})`);
  }

  const decoded = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');

  if (decoded.length !== 32) {
    throw new Error(
      `DOCUMENT_MASTER_KEY must decode to exactly 32 bytes (base64 or hex), got ${decoded.length}. Generate one with: ${MASTER_KEY_GENERATE_HINT}`
    );
  }

  return decoded;
};

/** Identifies which master key wrapped a document's data key, so rotation can find the right one. */
const parseMasterKeyId = (value: string | undefined): string => {
  const keyId = value?.trim() || 'primary';

  if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) {
    throw new Error('DOCUMENT_MASTER_KEY_ID must be 1-32 characters of letters, digits, "_" or "-"');
  }

  return keyId;
};

export const env = {
  port: parsePort(process.env.PORT),
  mongoUri: getRequiredEnv('MONGO_URI'),
  jwtSecret: getRequiredEnv('JWT_SECRET'),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  documentMasterKey: parseMasterKey(process.env.DOCUMENT_MASTER_KEY),
  documentMasterKeyId: parseMasterKeyId(process.env.DOCUMENT_MASTER_KEY_ID),
} as const;
