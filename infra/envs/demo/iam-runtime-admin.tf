# IAM cannot constrain create/delete by prefix. Application calls are guarded by assertRuntimeName.
resource "google_project_iam_member" "provisioner_creator" {
  for_each = toset(["dedicated_op_creator", "dedicated_sa_creator"])
  project  = var.project_id
  role     = google_project_iam_custom_role.runtime[each.key].id
  member   = module.service_accounts["provisioner"].member
}

resource "google_project_iam_member" "lifecycle_destroyer" {
  for_each = toset(["run_execution_canceller", "dedicated_op_destroyer"])
  project  = var.project_id
  role     = google_project_iam_custom_role.runtime[each.key].id
  member   = module.service_accounts["lifecycle"].member
}

resource "google_cloud_run_v2_job_iam_member" "runtime_executor" {
  for_each = toset(["provisioner", "lifecycle"])
  project  = var.project_id
  location = var.region
  name     = module.agent_runtime_standard.name
  role     = "roles/run.jobsExecutorWithOverrides"
  member   = module.service_accounts[each.key].member
}
