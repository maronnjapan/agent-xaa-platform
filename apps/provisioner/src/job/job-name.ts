/**
 * Cloud Run takes one shape of job name, and the STANDARD branch was handing it another.
 *
 * `Jobs.runJob` names the job it is to run in full —
 * `projects/{project}/locations/{location}/jobs/{job}` — and refuses anything shorter.
 * The FULL_ISOLATION branch has always satisfied that without trying: it reads the name
 * back off the Job the API has just created, and the API returns the full one. The
 * STANDARD branch passes `STANDARD_JOB_NAME` through untouched, and what Terraform put
 * there is `google_cloud_run_v2_job.name` — the short name, `agent-runtime-standard`,
 * with neither project nor location in it.
 *
 * Where that lands is what made it invisible. `start_job_execution` is the second to
 * last step of a provisioning, and on the path a person actually takes it runs only
 * after they have answered a consent screen: everything before it — the decision, the
 * transaction, the IdP connection, the registration — succeeded, so a deployment looked
 * healthy until the first person consented and got a failure page instead of an agent.
 *
 * The name is qualified here rather than trusted from the variable, so the deployment's
 * shape is not something a later Terraform edit can quietly break again. A name that
 * cannot be qualified stops the process at start-up, which is where a missing variable
 * belongs — not four steps into a provisioning that has already spent someone's consent.
 */
export function qualifiedJobName(input: {
  jobName: string;
  projectId: string | undefined;
  region: string | undefined;
}): string {
  const name = input.jobName.trim();
  if (name.startsWith('projects/')) return name;
  // Anything else carrying a slash is a half-written resource path rather than a job
  // id, and guessing at what was meant would only move the failure further downstream.
  if (name.includes('/') || name === '') {
    throw new Error(`STANDARD_JOB_NAME is not a job name: ${JSON.stringify(input.jobName)}`);
  }
  if (!input.projectId || !input.region) {
    throw new Error('STANDARD_JOB_NAME needs PROJECT_ID and REGION, or must name the job in full');
  }
  return `projects/${input.projectId}/locations/${input.region}/jobs/${name}`;
}
