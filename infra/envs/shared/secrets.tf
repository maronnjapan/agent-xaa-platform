resource "google_secret_manager_secret" "google_oauth_client_secret" {
  project   = var.project_id
  secret_id = "google-oauth-client-secret"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.required]
}

# Refresh tokens are KMS-encrypted in Firestore; Secret Manager stores only the OAuth client secret.
resource "google_secret_manager_secret_version" "google_oauth_client_secret" {
  count       = var.google_oauth_client_secret_value == null ? 0 : 1
  secret      = google_secret_manager_secret.google_oauth_client_secret.id
  secret_data = var.google_oauth_client_secret_value
}
