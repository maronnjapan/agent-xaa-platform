resource "google_pubsub_topic" "agent_activity_stream" {
  project = var.project_id
  name    = "agent-activity-stream"
}

module "activity_push" {
  source               = "../../modules/pubsub-push"
  project_id           = var.project_id
  topic                = google_pubsub_topic.agent_activity_stream.id
  subscription_name    = "activity-to-automation-app"
  push_endpoint        = "${local.run_url["automation-app"]}/internal/activity/push"
  oidc_service_account = module.service_accounts["pubsub_push"].email
  audience             = local.run_url["automation-app"]
}

locals {
  activity_publishers = setunion(toset([
    "automation_app", "authorization", "provisioner", "lifecycle", "shared_agent_op", "agent_runtime", "security",
  ]), var.enable_google_bridge ? toset(["google_bridge"]) : toset([]))
}

resource "google_pubsub_topic_iam_member" "activity_publishers" {
  for_each = local.activity_publishers
  project  = var.project_id
  topic    = google_pubsub_topic.agent_activity_stream.name
  role     = "roles/pubsub.publisher"
  member   = module.service_accounts[each.key].member
}
