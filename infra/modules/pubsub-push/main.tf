resource "google_pubsub_subscription" "this" {
  project                    = var.project_id
  name                       = var.subscription_name
  topic                      = var.topic
  ack_deadline_seconds       = var.ack_deadline_seconds
  message_retention_duration = var.message_retention_duration
  push_config {
    push_endpoint = var.push_endpoint
    oidc_token {
      service_account_email = var.oidc_service_account
      audience              = var.audience
    }
  }
}
