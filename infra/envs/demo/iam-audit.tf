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

# Only the three tables the detector writes. The ledger is written by the Agent OP and
# read here, so the detector gets no editor role on it (RULE-42).
#
# This lives in the demo state rather than beside the tables because sa-security is
# created here: a setIamPolicy naming a service account that does not exist yet is
# rejected outright, so the binding has to be applied after the account, not before it.
resource "google_bigquery_table_iam_binding" "detection_writer" {
  for_each = toset(["normalized_events", "findings", "rule_hits"])

  project    = var.project_id
  dataset_id = data.terraform_remote_state.shared.outputs.security_audit_dataset
  table_id   = data.terraform_remote_state.shared.outputs.audit_tables[each.key]
  role       = "roles/bigquery.dataEditor"
  members    = [module.service_accounts["security"].member]
}
