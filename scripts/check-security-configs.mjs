import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [innerNginx, hostNginx, cloudflareNginx, caddy, traefikOverlay, traefikStandalone] = await Promise.all([
  read('deploy/nginx.conf'),
  read('deploy/nginx-host.conf.example'),
  read('deploy/nginx-host-cloudflare.conf.example'),
  read('deploy/Caddyfile.example'),
  read('compose.traefik.yml'),
  read('deploy/traefik-compose.yml.example'),
]);

function assert(condition, message) {
  if (!condition) throw new Error(`Security configuration invariant failed: ${message}`);
}

const assetLocation = innerNginx.indexOf('location ~ "^/api/v1/assets/');
const genericApiLocation = innerNginx.indexOf('location /api/');
const protectedMediaLocation = innerNginx.indexOf('location ^~ /_protected_media/');
const generationEventsLocation = innerNginx.indexOf('location = /api/v1/generations/events');
const catalogLocation = innerNginx.indexOf('location ~ "^/api/v1/(models|option-labels|style-presets)$"');
assert(assetLocation >= 0 && assetLocation < genericApiLocation, 'private asset route must precede generic API route');
assert(catalogLocation >= 0 && catalogLocation < genericApiLocation, 'privately cacheable catalog routes must precede generic API no-store');
assert(!innerNginx.slice(catalogLocation, genericApiLocation).includes('Cache-Control "no-store"'), 'catalog routes must not force no-store');
assert(protectedMediaLocation >= 0, 'internal protected media location must exist');
assert(innerNginx.slice(protectedMediaLocation).includes('internal;'), 'protected media location must be internal-only');
assert(innerNginx.includes('alias /data/media/;'), 'protected media must use the read-only media mount');
assert(innerNginx.includes('[0-9a-fA-F-]{36}/content$"'), 'Nginx regexes containing braces must be quoted');
assert(innerNginx.includes('add_header Cache-Control "no-store" always;'), 'generic API must set no-store');
assert(innerNginx.includes('add_header Cache-Control "no-cache, no-transform" always;'), 'SSE must disable transformation and caching');
assert(generationEventsLocation >= 0 && generationEventsLocation < genericApiLocation, 'user generation SSE route must precede generic buffered API route');
assert(innerNginx.includes('gzip_comp_level 6;') && innerNginx.includes('gzip_vary on;') && innerNginx.includes('gzip_static on;'), 'static responses must enable bounded gzip compression');
assert(innerNginx.includes('http2 on;'), 'bundled Nginx must accept HTTP/2');
assert(hostNginx.includes('Strict-Transport-Security'), 'host Nginx must set HSTS');
assert(cloudflareNginx.includes('Strict-Transport-Security'), 'Cloudflare origin Nginx must set HSTS');
assert(caddy.includes('Strict-Transport-Security'), 'Caddy must set HSTS');
assert(traefikOverlay.includes('headers.stsSeconds: "31536000"'), 'Traefik must set HSTS');
assert(!/traefik:[\s\S]*\/var\/run\/docker\.sock/.test(traefikStandalone), 'Traefik must not mount the Docker socket');
assert(traefikStandalone.includes('POST: "0"'), 'Socket Proxy must deny write methods');

console.log('Proxy, caching, HSTS, and Docker Socket invariants passed.');
