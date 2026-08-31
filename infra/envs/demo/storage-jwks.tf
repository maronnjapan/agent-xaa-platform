resource "google_storage_bucket" "jwks" {
  project                     = var.project_id
  name                        = local.jwks_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true
  public_access_prevention    = "inherited"
}

resource "google_storage_bucket_iam_member" "jwks_public" {
  bucket = google_storage_bucket.jwks.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}
