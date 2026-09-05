output "name" { value = google_cloud_run_v2_job.this.name }

# What Cloud Run's own API calls a job: `projects/{p}/locations/{l}/jobs/{j}`. `name`
# above is the short one, which is what the IAM resources take and what `runJob`
# refuses, so the two are kept apart rather than left to the caller to tell apart.
output "full_name" {
  value = "projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.this.name}"
}
