resource "google_storage_bucket" "platform_config" {
  project                     = var.project_id
  name                        = "${var.project_id}-platform-config"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true
  public_access_prevention    = "enforced"
}
