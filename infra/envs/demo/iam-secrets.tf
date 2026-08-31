resource "google_secret_manager_secret_iam_member" "bridge" {
  count     = var.enable_google_bridge ? 1 : 0
  project   = var.project_id
  secret_id = data.terraform_remote_state.shared.outputs.google_oauth_client_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = module.service_accounts["google_bridge"].member
}
