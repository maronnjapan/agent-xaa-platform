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

# Replacing an object in Cloud Storage is a create plus a delete of the generation it
# replaces, so objectCreator alone lets the aggregate be written once and never again:
# the second run of the job answers 403 `storage.objects.delete`, which is what the first
# deploy that reached `make seed` observed.
#
# The rule this bucket is built on stands: nobody may delete a `keys/*.json`, because a
# missing signer disappears from the aggregate without a trace. So the permission is not
# a predefined role — every one of those covers the whole bucket — but a custom role of
# exactly one permission, bound under the same condition as the write above. It names the
# single object `jwks.json`, which the job is the only writer of.
resource "google_project_iam_custom_role" "jwks_aggregate_replacer" {
  project     = var.project_id
  role_id     = "jwks_aggregate_replacer"
  title       = "jwks aggregate replacer"
  description = "Replace the aggregate jwks.json. Deleting any other object in the JWKS bucket stays impossible."
  permissions = ["storage.objects.delete"]
}

resource "google_storage_bucket_iam_member" "jwks_publish_replace" {
  bucket = google_storage_bucket.jwks.name
  role   = google_project_iam_custom_role.jwks_aggregate_replacer.id
  member = module.service_accounts["jwks_publish"].member
  condition {
    title      = "replace-aggregate-jwks"
    expression = "resource.name == 'projects/_/buckets/${google_storage_bucket.jwks.name}/objects/jwks.json'"
  }
}
