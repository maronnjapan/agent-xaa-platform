import { describe, expect, it } from 'vitest';
import { qualifiedJobName } from '../src/job/job-name.js';
import { loadConfig } from '../src/runtime.js';

/**
 * The name Cloud Run will run a job by.
 *
 * `Jobs.runJob` takes `projects/{p}/locations/{l}/jobs/{j}` and refuses a bare job id.
 * Terraform hands over `google_cloud_run_v2_job.name`, which is the bare one, and the
 * call that would have found out sits at `start_job_execution` — after the person has
 * answered the consent screen. A deployment therefore passed every check it had and
 * failed on the first agent anyone actually tried to create.
 */
describe('the job the STANDARD branch runs', () => {
  it('qualifies a bare job id with the project and the region', () => {
    expect(qualifiedJobName({
      jobName: 'agent-runtime-standard', projectId: 'xaa-demo', region: 'asia-northeast1',
    })).toBe('projects/xaa-demo/locations/asia-northeast1/jobs/agent-runtime-standard');
  });

  it('leaves a name that is already full alone', () => {
    const full = 'projects/xaa-demo/locations/asia-northeast1/jobs/agent-runtime-standard';
    expect(qualifiedJobName({ jobName: full, projectId: 'other', region: 'other' })).toBe(full);
  });

  /**
   * Start-up is the only place this can still be caught cheaply: the alternative is a
   * failure four steps into a provisioning, with the person's consent already spent.
   */
  it('refuses to start when a bare name cannot be qualified', () => {
    expect(() => qualifiedJobName({ jobName: 'agent-runtime-standard', projectId: undefined, region: 'asia-northeast1' }))
      .toThrow(/PROJECT_ID and REGION/);
    expect(() => qualifiedJobName({ jobName: 'locations/x/jobs/y', projectId: 'p', region: 'r' }))
      .toThrow(/not a job name/);
  });

  it('is what the Provisioner starts with, whichever shape the deployment set', () => {
    const env = {
      ISSUER: 'https://idp.test', JWKS_URL: 'https://idp.test/jwks', PROVISIONER_AUDIENCE: 'agent-provisioner',
      PUBLIC_BASE_URL: 'https://provisioner.test', SHARED_AGENT_OP_URL: 'https://op.test',
      AGENT_MAX_LIFETIME_SECONDS: '86400', ACTIVITY_TOPIC: 'agent-activity-stream',
      MAX_FULL_ISOLATION_AGENTS: '2', PROJECT_ID: 'xaa-demo', REGION: 'asia-northeast1',
    };
    // What Terraform used to inject, and what it injects now: one config either way.
    expect(loadConfig({ ...env, STANDARD_JOB_NAME: 'agent-runtime-standard' }).standardJobName)
      .toBe('projects/xaa-demo/locations/asia-northeast1/jobs/agent-runtime-standard');
    expect(loadConfig({
      ...env, STANDARD_JOB_NAME: 'projects/xaa-demo/locations/asia-northeast1/jobs/agent-runtime-standard',
    }).standardJobName).toBe('projects/xaa-demo/locations/asia-northeast1/jobs/agent-runtime-standard');
  });
});
