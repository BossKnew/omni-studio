import ipaddr from 'ipaddr.js';
import { processRole } from './process-role';

export function intEnv(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export const securityConfig = {
  loginIpLimit: () => intEnv('LOGIN_IP_LIMIT', 50, 1, 10_000),
  loginPairLimit: () => intEnv('LOGIN_PAIR_LIMIT', 10, 1, 1_000),
  loginAccountFailureLimit: () => intEnv('LOGIN_ACCOUNT_FAILURE_LIMIT', 30, 1, 1_000),
  registrationLimit: () => intEnv('REGISTRATION_IP_LIMIT', 5, 1, 1_000),
  generationLimit: () => intEnv('GENERATION_RATE_LIMIT', 10, 1, 10_000),
  uploadLimit: () => intEnv('UPLOAD_RATE_LIMIT', 30, 1, 10_000),
  maxConcurrentUploadsPerUser: () => intEnv('MAX_CONCURRENT_UPLOADS_PER_USER', 2, 1, 20),
  activeJobsPerUser: () => intEnv('MAX_ACTIVE_JOBS_PER_USER', 3, 1, 100),
  queuedJobsGlobal: () => intEnv('MAX_QUEUED_JOBS', 200, 1, 100_000),
  storageBytesPerUser: () => BigInt(intEnv('USER_STORAGE_QUOTA_GIB', 10, 1, 10_000)) * 1024n * 1024n * 1024n,
  ssePerUser: () => intEnv('MAX_SSE_CONNECTIONS_PER_USER', 3, 1, 20),
  workerConcurrency: () => intEnv('WORKER_CONCURRENCY', 1, 1, 32),
  videoWorkerConcurrency: () => intEnv('VIDEO_WORKER_CONCURRENCY', 1, 1, 8),
  imageProcessingConcurrency: () => intEnv('IMAGE_PROCESSING_CONCURRENCY', 1, 1, 4),
};

export function allowedOrigins() {
  return new Set((process.env.APP_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean));
}

export function isProduction() {
  return process.env.NODE_ENV === 'production';
}

export type ForwardedHeadersMode = 'ignore' | 'trusted-single-proxy';

export function forwardedHeadersMode(): ForwardedHeadersMode {
  const value = process.env.FORWARDED_HEADERS_MODE || 'ignore';
  if (value !== 'ignore' && value !== 'trusted-single-proxy') {
    throw new Error('FORWARDED_HEADERS_MODE must be ignore or trusted-single-proxy');
  }
  return value;
}

function isPrivateHttpHost(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true;
  if (!ipaddr.isValid(normalized)) return false;
  const range = ipaddr.parse(normalized).range();
  return ['loopback', 'private', 'linkLocal', 'uniqueLocal'].includes(range);
}

function encryptionKeys(singleName: string, ringName: string) {
  const values: string[] = [];
  const single = process.env[singleName]?.trim();
  if (single) values.push(single);
  for (const entry of (process.env[ringName] ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    if (separator < 1 || !/^[a-zA-Z0-9_-]{1,32}$/.test(entry.slice(0, separator))) {
      throw new Error(`${ringName} contains an invalid key ID`);
    }
    values.push(entry.slice(separator + 1));
  }
  return values;
}

function validateSecretMaterial() {
  const providerKeys = encryptionKeys('PROVIDER_SECRET_KEY', 'PROVIDER_SECRET_KEYS');
  const mfaKeys = encryptionKeys('MFA_SECRET_KEY', 'MFA_SECRET_KEYS');
  const bootstrapUsername = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim();
  const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (Boolean(bootstrapUsername) !== Boolean(bootstrapPassword)) {
    throw new Error('BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD must be configured together');
  }

  const criticalValues = [
    ...providerKeys,
    ...mfaKeys,
    ...[process.env.POSTGRES_PASSWORD, process.env.REDIS_PASSWORD, process.env.DATABASE_URL, process.env.REDIS_URL, bootstrapPassword].filter((value): value is string => Boolean(value)),
  ];
  if (criticalValues.some((value) => value.toLowerCase().includes('change-me'))) {
    throw new Error('Placeholder secret values containing change-me are not allowed');
  }
  if (bootstrapPassword && (bootstrapPassword.length < 15 || bootstrapPassword.length > 128)) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must contain 15 to 128 characters');
  }

  const decode = (value: string, name: string) => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${name} entries must be Base64 encoded`);
    const key = Buffer.from(value, 'base64');
    const canonical = key.toString('base64').replace(/=+$/, '');
    if (key.length !== 32 || canonical !== value.replace(/=+$/, '')) throw new Error(`${name} entries must be 32-byte Base64 keys`);
    return key;
  };
  const decodedProviderKeys = providerKeys.map((value) => decode(value, 'PROVIDER_SECRET_KEY(S)'));
  const decodedMfaKeys = mfaKeys.map((value) => decode(value, 'MFA_SECRET_KEY(S)'));
  if (decodedProviderKeys.some((provider) => decodedMfaKeys.some((mfa) => provider.equals(mfa)))) {
    throw new Error('Provider credential and MFA encryption keys must be independent');
  }
}

export function validateSecurityConfig() {
  processRole();
  validateSecretMaterial();
  const mediaAcceleration = process.env.MEDIA_X_ACCEL_REDIRECT || 'false';
  if (!['true', 'false'].includes(mediaAcceleration)) throw new Error('MEDIA_X_ACCEL_REDIRECT must be true or false');
  const rawOrigins = (process.env.APP_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (isProduction() && !rawOrigins.length) throw new Error('APP_ORIGINS is required in production');

  const origins = rawOrigins.map((raw) => {
    if (raw.includes('*')) throw new Error('APP_ORIGINS must not contain wildcards');
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error(`APP_ORIGINS contains an invalid origin: ${raw}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== raw) {
      throw new Error(`APP_ORIGINS must contain exact HTTP(S) origins without paths: ${raw}`);
    }
    return url;
  });

  const insecureValue = process.env.ALLOW_INSECURE_HTTP || 'false';
  if (!['true', 'false'].includes(insecureValue)) throw new Error('ALLOW_INSECURE_HTTP must be true or false');
  const insecure = insecureValue === 'true';
  if (insecure && origins.some((url) => url.protocol !== 'http:' || !isPrivateHttpHost(url.hostname))) {
    throw new Error('ALLOW_INSECURE_HTTP=true is restricted to local or private-network HTTP origins');
  }
  if (!insecure && origins.some((url) => url.protocol !== 'https:')) throw new Error('APP_ORIGINS must use HTTPS when insecure HTTP is disabled');
  const proxyMode = forwardedHeadersMode();
  const bindAddress = (process.env.HTTP_BIND_ADDRESS || '127.0.0.1').replace(/^\[|\]$/g, '').toLowerCase();
  if (proxyMode === 'trusted-single-proxy' && !['127.0.0.1', '::1', 'localhost'].includes(bindAddress)) {
    throw new Error('trusted-single-proxy requires a loopback HTTP_BIND_ADDRESS');
  }

  if (insecure) {
    console.warn('[security] Insecure HTTP is enabled. Session cookies are not Secure; never expose this mode to the public internet.');
  }
}
