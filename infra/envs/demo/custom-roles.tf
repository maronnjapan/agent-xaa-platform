locals {
  runtime_custom_roles = {
    run_execution_canceller = ["run.executions.cancel", "run.executions.get"]
    dedicated_op_creator    = ["run.services.create", "run.services.get", "run.services.setIamPolicy", "run.jobs.create", "run.jobs.get"]
    dedicated_sa_creator    = ["iam.serviceAccounts.create", "iam.serviceAccounts.get", "iam.serviceAccounts.actAs"]
    dedicated_op_destroyer  = ["run.services.delete", "run.jobs.delete", "iam.serviceAccounts.delete", "run.services.get", "run.jobs.get", "iam.serviceAccounts.get"]
  }
}

resource "google_project_iam_custom_role" "runtime" {
  for_each    = local.runtime_custom_roles
  project     = var.project_id
  role_id     = each.key
  title       = replace(each.key, "_", " ")
  permissions = each.value
}
