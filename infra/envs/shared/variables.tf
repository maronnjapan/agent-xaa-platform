variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "asia-northeast1"
}

# The saved detections read the Log Sink's own destination table, and Cloud Logging does
# not create that table until a Cloud Run container has written its first line to stdout.
# On a project that has never been deployed, this state is applied long before that, and
# BigQuery rejects a view over a table that is not there — at creation, not at query
# time. So the views are held back until the table exists, and the deploy path applies
# this state a second time once it does (`make audit-views`).
#
# It defaults to true because the dangerous direction is the other one: a plain
# `terraform apply` that forgot the flag would otherwise delete the deployed detections.
variable "audit_views_enabled" {
  type        = bool
  default     = true
  description = "Create the saved detection views. False while the Log Sink's destination table does not exist yet."
}
