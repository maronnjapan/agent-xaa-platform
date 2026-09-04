locals {
  # Each self-bootstrapping issuer owns one immutable wrapped-key object. Keeping the
  # Resource AS paths distinct is essential: their KMS keys cannot decrypt each
  # other's envelopes.
  signing_key_objects = {
    human_idp           = "sso-signing/current.json"
    resource_docs_as    = "resource-as-signing/docs/current.json"
    resource_finance_as = "resource-as-signing/finance/current.json"
  }
}

resource "google_storage_bucket_iam_member" "config_readers" {
  for_each = toset(keys(local.service_accounts))
  bucket   = google_storage_bucket.platform_config.name
  role     = "roles/storage.objectViewer"
  member   = module.service_accounts[each.key].member
}

# objectCreator permits the create-if-absent bootstrap but neither replacement nor
# deletion. The condition prevents an issuer from creating any other config object.
resource "google_storage_bucket_iam_member" "signing_key_writers" {
  for_each = local.signing_key_objects
  bucket   = google_storage_bucket.platform_config.name
  role     = "roles/storage.objectCreator"
  member   = module.service_accounts[each.key].member
  condition {
    title      = "create-${replace(each.value, "/", "-")}"
    expression = "resource.name == 'projects/_/buckets/${google_storage_bucket.platform_config.name}/objects/${each.value}'"
  }
}
