import { httpControllersEnabled, mediaStagingDirName, processRole, runsBackgroundMaintenance, runsGenerationWorkers } from './process-role';

describe('processRole', () => {
  it('defaults to a combined API and worker process', () => {
    expect(processRole(undefined)).toBe('all');
    expect(processRole('')).toBe('all');
    expect(runsGenerationWorkers('all')).toBe(true);
    expect(httpControllersEnabled('all')).toBe(true);
  });

  it('splits HTTP from queue consumers', () => {
    expect(processRole('api')).toBe('api');
    expect(runsGenerationWorkers('api')).toBe(false);
    expect(runsBackgroundMaintenance('api')).toBe(false);
    expect(httpControllersEnabled('api')).toBe(true);
    expect(processRole('worker')).toBe('worker');
    expect(runsGenerationWorkers('worker')).toBe(true);
    expect(httpControllersEnabled('worker')).toBe(false);
  });

  it('rejects unknown roles', () => {
    expect(() => processRole('scheduler')).toThrow(/PROCESS_ROLE/);
  });

  it('keeps a shared staging directory for combined processes', () => {
    expect(mediaStagingDirName('all')).toBe('.staging');
    expect(mediaStagingDirName('api')).toBe('.staging-api');
    expect(mediaStagingDirName('worker')).toBe('.staging-worker');
  });
});
