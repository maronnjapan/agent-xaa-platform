module "service_accounts" {
  for_each     = local.service_accounts
  source       = "../../modules/service-account"
  project_id   = var.project_id
  account_id   = each.value
  display_name = "XAA ${replace(each.key, "_", " ")}"
}
