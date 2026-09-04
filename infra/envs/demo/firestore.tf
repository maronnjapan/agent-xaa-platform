locals {
  firestore_database_id = "xaa-db"
}

resource "google_firestore_database" "xaa" {
  project                 = var.project_id
  name                    = local.firestore_database_id
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  deletion_policy         = "DELETE"
  delete_protection_state = "DELETE_PROTECTION_DISABLED"
}

resource "google_firestore_field" "ttl" {
  for_each   = toset(["activity", "dpop_jti", "assertion_jti"])
  provider   = google-beta
  project    = var.project_id
  database   = google_firestore_database.xaa.name
  collection = each.key
  field      = "expire_at"
  ttl_config {}
}
