import { readFile } from 'node:fs/promises';

const [configPath, mode = 'base'] = process.argv.slice(2);
if (!configPath) throw new Error('Usage: node scripts/check-compose-security.mjs <compose.json> [base|traefik|standalone]');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const services = config.services ?? {};

function assert(condition, message) {
  if (!condition) throw new Error(`Compose security invariant failed: ${message}`);
}

function networks(service) {
  if (!service?.networks) return [];
  return Array.isArray(service.networks) ? service.networks : Object.keys(service.networks);
}

function exactNetworks(service, expected) {
  const actual = networks(service).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function hasDockerSocket(service) {
  return (service?.volumes ?? []).some((volume) => {
    if (typeof volume === 'string') return volume.includes('/var/run/docker.sock');
    return volume?.source === '/var/run/docker.sock' || volume?.target === '/var/run/docker.sock';
  });
}

function volumeAt(service, target) {
  return (service?.volumes ?? []).find((volume) => {
    if (typeof volume === 'string') return volume.split(':')[1] === target;
    return volume?.target === target;
  });
}

if (mode === 'standalone') {
  assert(services.traefik && services['socket-proxy'], 'standalone proxy services must exist');
  assert(!hasDockerSocket(services.traefik), 'Traefik must not mount the Docker socket');
  assert(hasDockerSocket(services['socket-proxy']), 'Socket Proxy must be the only Docker socket consumer');
  assert(exactNetworks(services['socket-proxy'], ['socket_api']), 'Socket Proxy must only join socket_api');
  assert(exactNetworks(services.traefik, ['proxy', 'socket_api']), 'Traefik must only join proxy and socket_api');
  assert(!(services['socket-proxy'].ports?.length), 'Socket Proxy must not publish ports');
  assert(String(services['socket-proxy'].environment?.POST) === '0', 'Socket Proxy POST access must be disabled');
  assert(config.networks?.socket_api?.internal === true, 'socket_api must be internal');
} else {
  assert(services.api && services.nginx && services.migrate, 'application services must exist');
  assert(!(services.api.ports?.length), 'API must not publish host ports');
  assert(exactNetworks(services.api, ['app', 'data']), 'API must join only app and data');
  assert(exactNetworks(services.migrate, ['app', 'data']), 'migrate must join only app and data');
  if (services.worker) {
    assert(!(services.worker.ports?.length), 'worker must not publish host ports');
    assert(exactNetworks(services.worker, ['app', 'data']), 'worker must join only app and data');
  }
  assert(config.networks?.data?.internal === true, 'data network must be internal');
  const nginxMedia = volumeAt(services.nginx, '/data/media');
  assert(nginxMedia, 'Web service must mount media for authenticated sendfile delivery');
  assert(typeof nginxMedia === 'string' ? nginxMedia.endsWith(':ro') : nginxMedia.read_only === true, 'Web media mount must be read-only');
  for (const name of ['postgres', 'redis']) {
    if (!services[name]) continue;
    assert(!(services[name].ports?.length), `${name} must not publish host ports`);
    assert(exactNetworks(services[name], ['data']), `${name} must only join data`);
  }
  if (mode === 'traefik') {
    assert(exactNetworks(services.nginx, ['app', 'proxy']), 'Traefik Web service must join only app and proxy');
    assert(!(services.nginx.ports?.length), 'Traefik Web service must not publish host ports');
  } else {
    assert(exactNetworks(services.nginx, ['app']), 'Web service must only join app');
  }
}

console.log(`Compose security invariants passed (${mode}).`);
