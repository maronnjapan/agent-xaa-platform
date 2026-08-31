locals {
  key_rings = toset([
    "sso-signing",
    "idjag-signing",
    "resource-as-signing",
    "connector-encryption",
    "idp-connection-encryption",
  ])
  symmetric_keys = {
    human_idp_sso       = { ring = "sso-signing", id = "human-idp-sso-wrap" }
    resource_docs_as    = { ring = "resource-as-signing", id = "resource-docs-as-wrap" }
    resource_finance_as = { ring = "resource-as-signing", id = "resource-finance-as-wrap" }
    google_connector    = { ring = "connector-encryption", id = "google-connector" }
    idp_connection      = { ring = "idp-connection-encryption", id = "idp-connection" }
  }
}

resource "google_kms_key_ring" "rings" {
  for_each   = local.key_rings
  project    = var.project_id
  location   = var.region
  name       = each.value
  depends_on = [google_project_service.required]
  lifecycle { prevent_destroy = true }
}

resource "google_kms_crypto_key" "shared_idjag" {
  name                       = "shared-agent-op-idjag"
  key_ring                   = google_kms_key_ring.rings["idjag-signing"].id
  purpose                    = "ASYMMETRIC_SIGN"
  destroy_scheduled_duration = "86400s"
  version_template { algorithm = "EC_SIGN_P256_SHA256" }
  lifecycle { prevent_destroy = true }
}

# DEV-10: Human and Resource AS signing JWKs are envelope-encrypted; kid separation remains explicit.
resource "google_kms_crypto_key" "symmetric" {
  for_each                   = local.symmetric_keys
  name                       = each.value.id
  key_ring                   = google_kms_key_ring.rings[each.value.ring].id
  purpose                    = "ENCRYPT_DECRYPT"
  destroy_scheduled_duration = "86400s"
  lifecycle { prevent_destroy = true }
}
