locals {
  datastore_users = toset([
    "human_idp", "automation_app", "authorization", "provisioner", "lifecycle",
    "shared_agent_op", "resource_docs_api", "resource_finance_api", "agent_runtime",
    "google_bridge", "seed", "stub_saas_op", "stub_saas_api",
  ])
  vertex_users     = toset(["automation_app", "authorization", "agent_runtime", "security"])
  artifact_readers = toset(keys(local.service_accounts))
}

resource "google_project_iam_member" "datastore_users" {
  for_each = local.datastore_users
  project  = var.project_id
  role     = "roles/datastore.user"
  member   = module.service_accounts[each.key].member
}

resource "google_project_iam_member" "vertex_users" {
  for_each = local.vertex_users
  project  = var.project_id
  role     = "roles/aiplatform.user"
  member   = module.service_accounts[each.key].member
}

resource "google_project_iam_member" "artifact_readers" {
  for_each = local.artifact_readers
  project  = var.project_id
  role     = "roles/artifactregistry.reader"
  member   = module.service_accounts[each.key].member
}

resource "google_project_iam_member" "security_bigquery_job" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = module.service_accounts["security"].member
}
