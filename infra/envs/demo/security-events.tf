# The one-way feed into Security Detection.
#
# Logs go to a topic; the detector pulls from it. Nothing goes back: no application calls
# the detector, and the detector calls only the Lifecycle Manager (REQ-01-025). That
# shape is what keeps a detection outage from becoming a platform outage.
resource "google_pubsub_topic" "security_events" {
  project = var.project_id
  name    = "security-events"
}

resource "google_logging_project_sink" "security_events" {
  project                = var.project_id
  name                   = "security-events-sink"
  destination            = "pubsub.googleapis.com/${google_pubsub_topic.security_events.id}"
  filter                 = "jsonPayload.log_source != \"\" AND resource.type = \"cloud_run_revision\" AND severity >= \"INFO\""
  unique_writer_identity = true
}

resource "google_pubsub_topic_iam_member" "security_events_writer" {
  project = var.project_id
  topic   = google_pubsub_topic.security_events.name
  role    = "roles/pubsub.publisher"
  member  = google_logging_project_sink.security_events.writer_identity
}

# Pull by default. Security Detection runs with INTERNAL_ONLY ingress, so a push
# subscription cannot reach it unless the spike in DEC-SCOPE-02 says otherwise; pull also
# leaves the acknowledgement in the detector's hands, so a failed run is redelivered
# rather than lost.
resource "google_pubsub_subscription" "security_events" {
  project = var.project_id
  name    = "security-events-detection"
  topic   = google_pubsub_topic.security_events.name

  ack_deadline_seconds       = 60
  message_retention_duration = "86400s"

  dynamic "push_config" {
    for_each = var.security_events_delivery == "push" ? [1] : []
    content {
      push_endpoint = "${local.run_url["security-detection"]}/internal/security-events/push"
      oidc_token {
        service_account_email = module.service_accounts["security"].email
      }
    }
  }
}

resource "google_pubsub_subscription_iam_member" "security_events_reader" {
  project      = var.project_id
  subscription = google_pubsub_subscription.security_events.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${module.service_accounts["security"].email}"
}
