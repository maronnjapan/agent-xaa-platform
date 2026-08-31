resource "google_artifact_registry_repository" "xaa" {
  project       = var.project_id
  location      = var.region
  repository_id = "xaa"
  format        = "DOCKER"
  cleanup_policies {
    id     = "keep-latest-three"
    action = "KEEP"
    most_recent_versions { keep_count = 3 }
  }
  depends_on = [google_project_service.required]
}
