locals {
  # sa-op-* and sa-agent-* are runtime-created and intentionally absent.
  service_accounts = {
    human_idp            = "sa-human-idp"
    automation_app       = "sa-automation-app"
    authorization        = "sa-authorization"
    provisioner          = "sa-provisioner"
    lifecycle            = "sa-lifecycle"
    shared_agent_op      = "sa-shared-agent-op"
    google_bridge        = "sa-google-bridge"
    security             = "sa-security"
    resource_finance_as  = "sa-resource-finance-as"
    resource_finance_api = "sa-resource-finance-api"
    resource_docs_as     = "sa-resource-docs-as"
    resource_docs_api    = "sa-resource-docs-api"
    agent_runtime        = "sa-agent-runtime"
    scheduler            = "sa-scheduler"
    pubsub_push          = "sa-pubsub-push"
    seed                 = "sa-seed"
    jwks_publish         = "sa-jwks-publish"
    stub_saas_op         = "sa-stub-saas-op"
    stub_saas_api        = "sa-stub-saas-api"
  }
}
