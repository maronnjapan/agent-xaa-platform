resource "google_storage_bucket" "jwks" {
  project                     = var.project_id
  name                        = local.jwks_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true
  public_access_prevention    = "inherited"
}

# The anonymous read grant on this bucket is one of the deliberate public surfaces, so it
# lives with the others in iam-public.tf (T-IAC-16). Every grant to everyone in this
# state is written in exactly one file, which is what makes the public surface readable
# in one place.
