locals {
  required_service_names = toset([
    "human-idp", "automation-app", "authorization", "provisioner", "lifecycle",
    "shared-agent-op", "agent-op-callback", "security-detection",
    "resource-finance-as", "resource-finance-api", "resource-docs-as", "resource-docs-api",
  ])
  bridge_service_names = toset(["google-bridge", "google-bridge-callback"])
  stub_service_names   = toset(["stub-saas-op", "stub-saas-api"])
  optional_service_names = var.enable_google_bridge ? setunion(
    local.bridge_service_names,
    var.saas_connector_mode == "stub" ? local.stub_service_names : toset([]),
  ) : toset([])
  service_names = setunion(local.required_service_names, local.optional_service_names)
  all_service_names = setunion(
    local.required_service_names,
    local.bridge_service_names,
    local.stub_service_names,
  )
  public_services = setunion(
    toset(["automation-app", "human-idp", "agent-op-callback"]),
    var.enable_google_bridge ? setunion(
      toset(["google-bridge-callback"]),
      var.saas_connector_mode == "stub" ? toset(["stub-saas-op"]) : toset([]),
    ) : toset([]),
  )
  image_app = {
    human-idp           = "human-idp", automation-app = "automation-app", authorization = "authorization",
    provisioner         = "provisioner", lifecycle = "lifecycle-manager", shared-agent-op = "agent-op",
    agent-op-callback   = "agent-op", security-detection = "security-detection",
    resource-finance-as = "resource-finance-as", resource-finance-api = "resource-finance-api",
    resource-docs-as    = "resource-docs-as", resource-docs-api = "resource-docs-api",
    google-bridge       = "google-bridge", google-bridge-callback = "google-bridge",
    stub-saas-op        = "stub-saas-op", stub-saas-api = "stub-saas-api",
  }
  service_sa_key = {
    human-idp           = "human_idp", automation-app = "automation_app", authorization = "authorization",
    provisioner         = "provisioner", lifecycle = "lifecycle", shared-agent-op = "shared_agent_op",
    agent-op-callback   = "shared_agent_op", security-detection = "security",
    resource-finance-as = "resource_finance_as", resource-finance-api = "resource_finance_api",
    resource-docs-as    = "resource_docs_as", resource-docs-api = "resource_docs_api",
    google-bridge       = "google_bridge", google-bridge-callback = "google_bridge",
    stub-saas-op        = "stub_saas_op", stub-saas-api = "stub_saas_api",
  }
}
