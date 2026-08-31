resource "google_cloud_run_v2_service_iam_member" "public" {
  for_each = local.public_services
  project  = var.project_id
  location = var.region
  name     = module.services[each.key].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
