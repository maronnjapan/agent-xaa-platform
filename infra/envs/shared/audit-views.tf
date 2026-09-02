# The four saved detections of DEC-SEC-01, as views rather than as application code.
#
# A view is the smallest thing that can be reviewed, versioned and run without deploying
# anything, which is what makes it the right home for the minimum detection set: the
# rules engine can be wrong or absent and these still answer.
locals {
  # The four of DEC-SEC-01, plus the refresh-token reuse extraction T-SEC-14 adds. All
  # five return the same six columns, so the set can grow without the readers changing.
  audit_views = ["delegation_mismatch", "signing_key_misuse", "cross_agent_access", "dpop_replay", "refresh_token_reuse"]
}

resource "google_bigquery_table" "audit_view" {
  for_each = toset(local.audit_views)

  project             = var.project_id
  dataset_id          = google_bigquery_dataset.security_audit.dataset_id
  table_id            = "v_${each.key}"
  deletion_protection = false

  view {
    # Every view returns the same six columns, so the four can be UNION ALL'd into one
    # feed without the caller knowing which produced a row.
    query          = templatefile("${path.module}/sql/${each.key}.sql", { project_id = var.project_id })
    use_legacy_sql = false
  }

  depends_on = [google_bigquery_table.audit]
}
