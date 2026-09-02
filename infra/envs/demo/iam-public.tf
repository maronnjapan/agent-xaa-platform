# The whole public surface of the demo state. Nothing outside this file grants anything
# to everyone, so `grep -rn 'allUsers' infra/envs/` answers "what is reachable without a
# credential" in one read (T-IAC-16).
resource "google_cloud_run_v2_service_iam_member" "public" {
  for_each = local.public_services
  project  = var.project_id
  location = var.region
  name     = module.services[each.key].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# JWKS is published from Cloud Storage rather than from an app (DEC-IAC-13), so the
# object read has to be anonymous for a relying party to fetch it. Read only: writes stay
# with the prefix-scoped creators in iam-jwks.tf.
resource "google_storage_bucket_iam_member" "jwks_public" {
  bucket = google_storage_bucket.jwks.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}
