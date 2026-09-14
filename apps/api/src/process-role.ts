export type ProcessRole = 'all' | 'api' | 'worker';

export function processRole(raw = process.env.PROCESS_ROLE): ProcessRole {
  const value = (raw ?? 'all').trim().toLowerCase();
  if (value === 'api' || value === 'worker' || value === 'all' || value === '') return value === '' ? 'all' : value;
  throw new Error('PROCESS_ROLE must be all, api, or worker');
}

export function runsGenerationWorkers(role = processRole()) {
  return role !== 'api';
}

export function runsBackgroundMaintenance(role = processRole()) {
  return role !== 'api';
}

export function httpControllersEnabled(role = processRole()) {
  return role !== 'worker';
}

export function mediaStagingDirName(role = processRole()) {
  return role === 'all' ? '.staging' : `.staging-${role}`;
}
