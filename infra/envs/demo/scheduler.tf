# A five-minute tick remains well inside the one-hour verification profile lifetime.
resource "google_cloud_scheduler_job" "lifecycle_tick" {
  project          = var.project_id
  region           = var.region
  name             = "lifecycle-tick"
  schedule         = var.lifecycle_tick_cron
  time_zone        = "Etc/UTC"
  attempt_deadline = "60s"
  retry_config { retry_count = 0 }
  http_target {
    uri         = "${local.run_url["lifecycle"]}/internal/tick"
    http_method = "POST"
    oidc_token {
      service_account_email = module.service_accounts["scheduler"].email
      audience              = local.run_url["lifecycle"]
    }
  }
}
