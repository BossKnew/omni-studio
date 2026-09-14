import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checker = join(root, 'scripts', 'check-compose-security.mjs');

function composeJson(args) {
  const result = spawnSync('docker', ['compose', ...args, 'config', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'docker compose config failed');
  }
  return result.stdout;
}

function check(json, mode) {
  const dir = mkdtempSync(join(tmpdir(), 'omnistudio-compose-'));
  const path = join(dir, `${mode}.json`);
  try {
    writeFileSync(path, json);
    const result = spawnSync(process.execPath, [checker, path, mode], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

check(composeJson(['--env-file', '.env.example']), 'base');
check(composeJson(['--env-file', '.env.example', '-f', 'docker-compose.yml', '-f', 'compose.worker.yml']), 'base');
check(composeJson(['--env-file', '.env.example', '-f', 'docker-compose.yml', '-f', 'compose.traefik.yml']), 'traefik');
check(composeJson(['-f', 'deploy/traefik-compose.yml.example']), 'standalone');
