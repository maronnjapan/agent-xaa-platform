locals {
  firestore_indexes = {
    human_permissions = { query_scope = "COLLECTION", fields = [["human_subject", "ASCENDING"], ["capability_id", "ASCENDING"]] }
    catalog_tools     = { query_scope = "COLLECTION", fields = [["connector_id", "ASCENDING"], ["required_capability", "ASCENDING"]] }
    documents         = { query_scope = "COLLECTION", fields = [["owner_subject", "ASCENDING"], ["type", "ASCENDING"], ["occurred_at", "DESCENDING"]] }
    payments          = { query_scope = "COLLECTION", fields = [["requester_subject", "ASCENDING"], ["status", "ASCENDING"], ["created_at", "DESCENDING"]] }
    activity          = { query_scope = "COLLECTION_GROUP", fields = [["task_id", "ASCENDING"], ["occurred_at", "ASCENDING"]] }
  }
}

resource "google_firestore_index" "indexes" {
  for_each    = local.firestore_indexes
  project     = var.project_id
  database    = google_firestore_database.xaa.name
  collection  = each.key
  query_scope = each.value.query_scope
  dynamic "fields" {
    for_each = each.value.fields
    content {
      field_path = fields.value[0]
      order      = fields.value[1]
    }
  }
}
