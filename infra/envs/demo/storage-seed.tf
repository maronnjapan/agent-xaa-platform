resource "google_storage_bucket_object" "seed" {
  for_each     = fileset("${path.module}/../../seed", "**/*.yaml")
  bucket       = google_storage_bucket.platform_config.name
  name         = "seed/${each.value}"
  source       = "${path.module}/../../seed/${each.value}"
  content_type = "application/yaml"
}
