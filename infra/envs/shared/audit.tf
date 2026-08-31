resource "google_bigquery_dataset" "security_audit" {
  project                     = var.project_id
  dataset_id                  = "security_audit"
  location                    = var.region
  default_table_expiration_ms = 604800000
  delete_contents_on_destroy  = true
  depends_on                  = [google_project_service.required]
}

# The sink's unique writer identity is the logical sa-log-sink; no key-bearing SA is created.
resource "google_logging_project_sink" "audit" {
  project                = var.project_id
  name                   = "audit-bq-sink"
  destination            = "bigquery.googleapis.com/projects/${var.project_id}/datasets/${google_bigquery_dataset.security_audit.dataset_id}"
  unique_writer_identity = true
  bigquery_options { use_partitioned_tables = true }
}

resource "google_bigquery_dataset_iam_binding" "audit_writer" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.security_audit.dataset_id
  role       = "roles/bigquery.dataEditor"
  members    = [google_logging_project_sink.audit.writer_identity]
}
