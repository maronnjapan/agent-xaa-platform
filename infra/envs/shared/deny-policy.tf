data "google_project" "this" { project_id = var.project_id }

resource "google_iam_deny_policy" "audit_protection" {
  count        = var.enable_deny_policy ? 1 : 0
  provider     = google-beta
  parent       = urlencode("cloudresourcemanager.googleapis.com/projects/${data.google_project.this.number}")
  name         = "audit-protection"
  display_name = "Protect audit sinks and data from platform service accounts"
  rules {
    description = "Platform service accounts cannot delete audit data or logging sinks"
    deny_rule {
      denied_principals = ["principalSet://goog/public:all"]
      denied_permissions = [
        "bigquery.googleapis.com/tables.delete",
        "bigquery.googleapis.com/tables.deleteData",
        "bigquery.googleapis.com/datasets.delete",
        "logging.googleapis.com/sinks.delete",
      ]
      exception_principals = ["principalSet://goog/project/${data.google_project.this.number}/group/projectOwners"]
    }
  }
}
