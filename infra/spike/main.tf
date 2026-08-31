terraform {
  required_version = "= 1.9.8"
  required_providers {
    google      = { source = "hashicorp/google", version = "= 6.14.1" }
    google-beta = { source = "hashicorp/google-beta", version = "= 6.14.1" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
provider "google-beta" {
  project = var.project_id
  region  = var.region
}
data "google_project" "this" { project_id = var.project_id }

resource "google_project_service" "spike" {
  for_each           = toset(["run.googleapis.com", "iam.googleapis.com", "pubsub.googleapis.com", "cloudscheduler.googleapis.com", "cloudresourcemanager.googleapis.com"])
  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}

resource "google_service_account" "probe" {
  project      = var.project_id
  account_id   = "xaa-spike-probe"
  display_name = "Disposable XAA spike probe"
}
resource "google_service_account" "push" {
  project      = var.project_id
  account_id   = "xaa-spike-push"
  display_name = "Disposable XAA spike push"
}

resource "google_cloud_run_v2_service" "target" {
  project             = var.project_id
  location            = var.region
  name                = "xaa-spike-target"
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = false
  template {
    service_account = google_service_account.probe.email
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    containers { image = var.probe_image }
  }
  depends_on = [google_project_service.spike]
}

resource "google_cloud_run_v2_service" "caller" {
  project             = var.project_id
  location            = var.region
  name                = "xaa-spike-caller"
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  template {
    service_account = google_service_account.probe.email
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    containers {
      image = var.probe_image
      env {
        name  = "TARGET_URL"
        value = google_cloud_run_v2_service.target.uri
      }
    }
  }
  depends_on = [google_project_service.spike]
}

resource "google_cloud_run_v2_service_iam_member" "probe_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.target.name
  role     = "roles/run.invoker"
  member   = google_service_account.probe.member
}
resource "google_cloud_run_v2_service_iam_member" "caller_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.caller.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_pubsub_topic" "probe" {
  project = var.project_id
  name    = "xaa-spike-push"
}
resource "google_pubsub_subscription" "probe" {
  project = var.project_id
  name    = "xaa-spike-push"
  topic   = google_pubsub_topic.probe.id
  push_config {
    push_endpoint = "${google_cloud_run_v2_service.target.uri}/echo"
    oidc_token {
      service_account_email = google_service_account.push.email
      audience              = google_cloud_run_v2_service.target.uri
    }
  }
}
resource "google_cloud_run_v2_service_iam_member" "push_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.target.name
  role     = "roles/run.invoker"
  member   = google_service_account.push.member
}
resource "google_service_account_iam_member" "push_token" {
  service_account_id = google_service_account.push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_cloud_scheduler_job" "probe" {
  project  = var.project_id
  region   = var.region
  name     = "xaa-spike-scheduler"
  schedule = "0 0 1 1 *"
  http_target {
    uri         = "${google_cloud_run_v2_service.target.uri}/echo"
    http_method = "POST"
    oidc_token {
      service_account_email = google_service_account.push.email
      audience              = google_cloud_run_v2_service.target.uri
    }
  }
}

resource "google_iam_deny_policy" "probe" {
  count        = var.enable_deny_probe ? 1 : 0
  provider     = google-beta
  parent       = urlencode("cloudresourcemanager.googleapis.com/projects/${data.google_project.this.number}")
  name         = "xaa-spike-deny"
  display_name = "Disposable XAA deny policy probe"
  rules {
    deny_rule {
      denied_principals  = ["principal://iam.googleapis.com/projects/-/serviceAccounts/${google_service_account.push.email}"]
      denied_permissions = ["iam.googleapis.com/serviceAccounts.get"]
    }
  }
}

output "observed_uri" { value = google_cloud_run_v2_service.target.uri }
output "expected_uri" { value = "https://xaa-spike-target-${data.google_project.this.number}.${var.region}.run.app" }
output "caller_url" { value = google_cloud_run_v2_service.caller.uri }
