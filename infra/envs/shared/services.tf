locals {
  required_services = toset([
    "run.googleapis.com",
    "iam.googleapis.com",
    "cloudkms.googleapis.com",
    "secretmanager.googleapis.com",
    "firestore.googleapis.com",
    "pubsub.googleapis.com",
    "logging.googleapis.com",
    "bigquery.googleapis.com",
    "cloudscheduler.googleapis.com",
    "aiplatform.googleapis.com",
    "storage.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    # iamcredentials replaces sqladmin because the platform deliberately has no SQL instance.
    "iamcredentials.googleapis.com",
  ])
}

resource "google_project_service" "required" {
  for_each           = local.required_services
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
