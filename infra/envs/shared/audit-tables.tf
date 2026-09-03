# The four tables the detection pipeline reads and writes.
#
# All four are partitioned by day on the event time, so a query over one incident scans
# one day rather than the whole retention window. The sink's own destination table
# (run_googleapis_com_stdout) is created by Cloud Logging and is deliberately not
# declared here: Terraform would fight the sink over its schema on every log-shape change.
locals {
  audit_tables = {
    normalized_events = "occurred_at"
    findings          = "occurred_at"
    rule_hits         = "occurred_at"
    id_jag_ledger     = "occurred_at"
  }
}

resource "google_bigquery_table" "audit" {
  for_each = local.audit_tables

  project             = var.project_id
  dataset_id          = google_bigquery_dataset.security_audit.dataset_id
  table_id            = each.key
  deletion_protection = false
  schema              = file("${path.module}/schemas/${each.key}.json")

  time_partitioning {
    type  = "DAY"
    field = each.value
  }
}

# The detector's write access to three of them is granted by the demo state
# (infra/envs/demo/iam-audit.tf), which is where sa-security is created. Naming that
# account here as a literal string made this state apply before the account existed, and
# GCP answers a setIamPolicy for a principal it cannot resolve with 400, not with a
# binding that starts working once the account appears.
