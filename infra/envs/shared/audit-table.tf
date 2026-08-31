resource "google_bigquery_table" "agent_lifecycle_audit" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.security_audit.dataset_id
  table_id            = "agent_lifecycle_audit"
  deletion_protection = false
  schema              = file("${path.module}/../../schema/agent-lifecycle-audit.json")

  time_partitioning {
    type  = "DAY"
    field = "destroyed_at"
  }
}
