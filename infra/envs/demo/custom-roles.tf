locals {
  runtime_custom_roles = {
    run_execution_canceller = ["run.executions.cancel", "run.executions.get"]
    dedicated_op_creator = [
      "run.services.create", "run.services.get", "run.services.update", "run.services.setIamPolicy", "run.services.getIamPolicy",
      "run.jobs.create", "run.jobs.get",
      "resourcemanager.projects.getIamPolicy", "resourcemanager.projects.setIamPolicy",
      "storage.buckets.getIamPolicy", "storage.buckets.setIamPolicy",
      "pubsub.topics.getIamPolicy", "pubsub.topics.setIamPolicy",
      "secretmanager.secrets.getIamPolicy", "secretmanager.secrets.setIamPolicy",
    ]
    dedicated_sa_creator = ["iam.serviceAccounts.create", "iam.serviceAccounts.get", "iam.serviceAccounts.actAs"]
    dedicated_op_destroyer = [
      "run.services.delete", "run.jobs.delete", "iam.serviceAccounts.delete", "run.services.get", "run.jobs.get", "iam.serviceAccounts.get",
      "run.services.getIamPolicy", "run.services.setIamPolicy",
      "resourcemanager.projects.getIamPolicy", "resourcemanager.projects.setIamPolicy",
      "storage.buckets.getIamPolicy", "storage.buckets.setIamPolicy", "storage.objects.delete",
      "pubsub.topics.getIamPolicy", "pubsub.topics.setIamPolicy",
      "secretmanager.secrets.getIamPolicy", "secretmanager.secrets.setIamPolicy",
    ]
  }
}

resource "google_project_iam_custom_role" "runtime" {
  for_each    = local.runtime_custom_roles
  project     = var.project_id
  role_id     = each.key
  title       = replace(each.key, "_", " ")
  permissions = each.value
}
