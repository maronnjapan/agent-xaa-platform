locals {
  jwks_writer_prefixes = {
    human_idp           = "idp-"
    shared_agent_op     = "op-shared-"
    resource_docs_as    = "docs-as-"
    resource_finance_as = "fin-as-"
  }
}

resource "google_storage_bucket_iam_member" "jwks_writers" {
  for_each = local.jwks_writer_prefixes
  bucket   = google_storage_bucket.jwks.name
  role     = "roles/storage.objectCreator"
  member   = module.service_accounts[each.key].member
  condition {
    title      = "write-${each.value}keys"
    expression = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.jwks.name}/objects/keys/${each.value}')"
  }
}

resource "google_storage_bucket_iam_member" "jwks_publish_read" {
  bucket = google_storage_bucket.jwks.name
  role   = "roles/storage.objectViewer"
  member = module.service_accounts["jwks_publish"].member
}

resource "google_storage_bucket_iam_member" "jwks_publish_write" {
  bucket = google_storage_bucket.jwks.name
  role   = "roles/storage.objectCreator"
  member = module.service_accounts["jwks_publish"].member
  condition {
    title      = "write-aggregate-jwks"
    expression = "resource.name == 'projects/_/buckets/${google_storage_bucket.jwks.name}/objects/jwks.json'"
  }
}
