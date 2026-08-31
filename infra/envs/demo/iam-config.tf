resource "google_storage_bucket_iam_member" "config_readers" {
  for_each = toset(keys(local.service_accounts))
  bucket   = google_storage_bucket.platform_config.name
  role     = "roles/storage.objectViewer"
  member   = module.service_accounts[each.key].member
}
