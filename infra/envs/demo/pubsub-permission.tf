resource "google_pubsub_topic" "human_permission_changed" {
  project = var.project_id
  name    = "human-permission-changed"
}

module "permission_push" {
  source               = "../../modules/pubsub-push"
  project_id           = var.project_id
  topic                = google_pubsub_topic.human_permission_changed.id
  subscription_name    = "permission-to-authorization"
  push_endpoint        = "${local.run_url["authorization"]}/internal/events/human-permission-changed"
  oidc_service_account = module.service_accounts["pubsub_push"].email
  audience             = local.run_url["authorization"]
}

resource "google_pubsub_topic_iam_member" "permission_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.human_permission_changed.name
  role    = "roles/pubsub.publisher"
  member  = module.service_accounts["automation_app"].member
}
