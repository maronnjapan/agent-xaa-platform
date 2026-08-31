data "google_project" "this" { project_id = var.project_id }

locals {
  run_url     = { for service in local.all_service_names : service => "https://${service}-${data.google_project.this.number}.${var.region}.run.app" }
  jwks_bucket = "${var.project_id}-jwks"
  platform_endpoints = {
    issuer                     = var.issuer_profile == "direct" ? local.run_url["human-idp"] : "https://${var.issuer_domain}"
    jwks_url                   = "https://storage.googleapis.com/${local.jwks_bucket}/jwks.json"
    xaa_token_url              = local.run_url["shared-agent-op"]
    xaa_callback_url           = local.run_url["agent-op-callback"]
    subject_token_url          = "${local.run_url["shared-agent-op"]}/xaa/subject-token"
    authorization_url          = local.run_url["authorization"]
    provisioner_url            = local.run_url["provisioner"]
    lifecycle_url              = local.run_url["lifecycle"]
    resource_docs_as_issuer    = local.resource_servers.docs.issuer
    resource_docs_api_url      = local.resource_servers.docs.resource
    resource_finance_as_issuer = local.resource_servers.finance.issuer
    resource_finance_api_url   = local.resource_servers.finance.resource
    bridge_internal_url        = var.enable_google_bridge ? local.run_url["google-bridge"] : "https://disabled.invalid"
    stub_saas_op_issuer        = var.enable_google_bridge && var.saas_connector_mode == "stub" ? local.run_url["stub-saas-op"] : "https://disabled.invalid"
    agent_max_lifetime_seconds = var.agent_max_lifetime_seconds
    vertex_model               = var.vertex_model
    vertex_location            = var.vertex_location
    enable_google_bridge       = var.enable_google_bridge
  }
}
