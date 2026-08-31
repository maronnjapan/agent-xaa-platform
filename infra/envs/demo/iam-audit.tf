resource "google_bigquery_dataset_iam_member" "security_viewer" {
  project    = var.project_id
  dataset_id = data.terraform_remote_state.shared.outputs.security_audit_dataset
  role       = "roles/bigquery.dataViewer"
  member     = module.service_accounts["security"].member
}

# The dataset writer binding is authoritative, so Lifecycle append access is table-scoped.
resource "google_bigquery_table_iam_member" "lifecycle_appender" {
  project    = var.project_id
  dataset_id = data.terraform_remote_state.shared.outputs.security_audit_dataset
  table_id   = data.terraform_remote_state.shared.outputs.agent_lifecycle_audit_table
  role       = "roles/bigquery.dataEditor"
  member     = module.service_accounts["lifecycle"].member
}
