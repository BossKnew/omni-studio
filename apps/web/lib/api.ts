import { getCookieLocale, getInitialLocale, translateMessage } from '@/lib/i18n';
import { apiCacheMode } from './api-cache';

export { apiCacheMode };

let csrfToken = '';

async function ensureCsrf() {
  if (csrfToken) return;
  const response = await fetch('/api/v1/auth/me', { credentials: 'include', cache: 'no-store' });
  if (!response.ok) return;
  const payload = await response.json();
  if (typeof payload.csrfToken === 'string') csrfToken = payload.csrfToken;
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const unsafe = Boolean(init?.method && !['GET', 'HEAD', 'OPTIONS'].includes(init.method.toUpperCase()));
  if (unsafe && !['/auth/login', '/auth/register'].includes(path)) await ensureCsrf();
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (unsafe && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'include', cache: apiCacheMode(path, init) });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const rawMessage = Array.isArray(payload.message) ? payload.message.join('\n') : payload.message ?? `请求失败：${response.status}`;
    const activeLocale = getCookieLocale() ?? getInitialLocale();
    throw new Error(translateMessage(rawMessage, activeLocale));
  }
  const payload = await response.json();
  if (payload && typeof payload.csrfToken === 'string') csrfToken = payload.csrfToken;
  return payload;
}

export function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) };
}
