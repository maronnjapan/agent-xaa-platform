output "kms_key_rings" { value = { for name, ring in google_kms_key_ring.rings : name => ring.id } }
output "kms_keys" {
  value = merge(
    { shared_agent_op_idjag = google_kms_crypto_key.shared_idjag.id },
    { for name, key in google_kms_crypto_key.symmetric : name => key.id },
  )
}
# google_kms_crypto_key creates version 1 implicitly. Signing APIs require the
# version resource name, while IAM bindings above deliberately use the key name.
output "kms_key_versions" {
  value = {
    shared_agent_op_idjag = "${google_kms_crypto_key.shared_idjag.id}/cryptoKeyVersions/1"
  }
}
output "registry_host" { value = "${var.region}-docker.pkg.dev" }
output "repository_path" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.xaa.repository_id}" }
output "security_audit_dataset" { value = google_bigquery_dataset.security_audit.dataset_id }
output "agent_lifecycle_audit_table" { value = google_bigquery_table.agent_lifecycle_audit.table_id }
output "google_oauth_client_secret_id" { value = google_secret_manager_secret.google_oauth_client_secret.secret_id }
output "human_idp_client_secret_ids" {
  value = { for name, secret in google_secret_manager_secret.human_idp_client : name => secret.secret_id }
}
# Reserved only when enable_lb_reservation is true (T-IAC-17). The demo state consumes
# these when issuer_profile = "loadbalancer"; both are null otherwise, and the module
# that reads them is not instantiated in that case.
output "issuer_lb_address" { value = one(google_compute_global_address.issuer[*].address) }
output "issuer_lb_certificate" { value = one(google_compute_managed_ssl_certificate.issuer[*].id) }
