resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = local.invoker_edges
  project  = var.project_id
  location = var.region
  name     = module.services[each.value.service].name
  role     = "roles/run.invoker"
  member   = each.value.member
}
