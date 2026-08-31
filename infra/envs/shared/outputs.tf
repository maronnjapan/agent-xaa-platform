output "kms_key_rings" { value = { for name, ring in google_kms_key_ring.rings : name => ring.id } }
output "kms_keys" {
  value = merge(
    { shared_agent_op_idjag = google_kms_crypto_key.shared_idjag.id },
    { for name, key in google_kms_crypto_key.symmetric : name => key.id },
  )
}
output "registry_host" { value = "${var.region}-docker.pkg.dev" }
output "repository_path" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.xaa.repository_id}" }
output "security_audit_dataset" { value = google_bigquery_dataset.security_audit.dataset_id }
output "agent_lifecycle_audit_table" { value = google_bigquery_table.agent_lifecycle_audit.table_id }
output "google_oauth_client_secret_id" { value = google_secret_manager_secret.google_oauth_client_secret.secret_id }
