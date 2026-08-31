output "name" { value = google_cloud_run_v2_service.this.name }
output "service_account" { value = var.service_account }
# Consumers use the deterministic run_url locals; this output is diagnostic only.
output "uri" { value = google_cloud_run_v2_service.this.uri }
