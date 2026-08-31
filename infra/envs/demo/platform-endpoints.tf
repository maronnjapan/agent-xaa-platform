resource "google_storage_bucket_object" "platform_endpoints" {
  bucket       = google_storage_bucket.platform_config.name
  name         = "platform-endpoints.json"
  content      = jsonencode(local.platform_endpoints)
  content_type = "application/json"
}
