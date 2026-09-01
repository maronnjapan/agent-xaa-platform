resource "google_secret_manager_secret_iam_member" "bridge" {
  count     = var.enable_google_bridge ? 1 : 0
  project   = var.project_id
  secret_id = data.terraform_remote_state.shared.outputs.google_oauth_client_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = module.service_accounts["google_bridge"].member
}

resource "google_secret_manager_secret_iam_member" "human_idp_client" {
  for_each  = data.terraform_remote_state.shared.outputs.human_idp_client_secret_ids
  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = module.service_accounts["human_idp"].member
}

resource "google_secret_manager_secret_iam_member" "automation_client" {
  project   = var.project_id
  secret_id = data.terraform_remote_state.shared.outputs.human_idp_client_secret_ids.automation_app
  role      = "roles/secretmanager.secretAccessor"
  member    = module.service_accounts["automation_app"].member
}

resource "google_secret_manager_secret_iam_member" "agent_op_client" {
  project   = var.project_id
  secret_id = data.terraform_remote_state.shared.outputs.human_idp_client_secret_ids.agent_platform
  role      = "roles/secretmanager.secretAccessor"
  member    = module.service_accounts["shared_agent_op"].member
}
