locals {
  common_env = {
    PROJECT_ID             = var.project_id
    REGION                 = var.region
    PLATFORM_ENDPOINTS_URI = "gs://${google_storage_bucket.platform_config.name}/platform-endpoints.json"
    STORE_MODE             = "gcp"
    PUBSUB_MODE            = "gcp"
    SIGNER_MODE            = "kms"
    VERTEX_MODE            = "live"
    VERTEX_MODEL           = var.vertex_model
    VERTEX_LOCATION        = var.vertex_location
    FIRESTORE_DATABASE     = "xaa"
  }
  service_specific_env = {
    "human-idp" = {
      ISSUER                      = local.platform_endpoints.issuer
      PUBLIC_BASE_URL             = local.run_url["human-idp"]
      ISSUER_PROFILE              = var.issuer_profile
      JWKS_PUBLIC_BASE_URL        = "https://storage.googleapis.com/${local.jwks_bucket}"
      JWKS_BUCKET                 = local.jwks_bucket
      KEY_BUCKET                  = google_storage_bucket.platform_config.name
      KMS_SSO_KEY_NAME            = data.terraform_remote_state.shared.outputs.kms_keys.human_idp_sso
      DPOP_REQUIRED               = "true"
      ACCESS_TOKEN_EXPIRES_IN     = "300"
      AUTOMATION_APP_REDIRECT_URI = "${local.run_url["automation-app"]}/callback"
      AGENT_OP_CALLBACK_URI       = "${local.run_url["agent-op-callback"]}/xaa/callback"
    }
    "shared-agent-op" = {
      MODE                       = "token"
      ISSUER                     = local.platform_endpoints.issuer
      PUBLIC_BASE_URL            = local.run_url["shared-agent-op"]
      XAA_CLIENT_ID              = "agent-platform"
      JWKS_BUCKET                = local.jwks_bucket
      JWKS_OBJECT                = "jwks.json"
      KMS_IDJAG_KEY              = data.terraform_remote_state.shared.outputs.kms_keys.shared_agent_op_idjag
      KMS_IDP_CONNECTION_KEY     = data.terraform_remote_state.shared.outputs.kms_keys.idp_connection
      HUMAN_IDP_AUTHORIZE_URL    = "${local.run_url["human-idp"]}/authorize"
      HUMAN_IDP_TOKEN_URL        = "${local.run_url["human-idp"]}/token"
      HUMAN_IDP_REVOKE_URL       = "${local.run_url["human-idp"]}/revoke"
      ID_JAG_LIFETIME_SECONDS    = "300"
      AGENT_MAX_LIFETIME_SECONDS = tostring(var.agent_max_lifetime_seconds)
    }
    "agent-op-callback" = {
      MODE                       = "callback"
      ISSUER                     = local.platform_endpoints.issuer
      PUBLIC_BASE_URL            = local.run_url["agent-op-callback"]
      XAA_CLIENT_ID              = "agent-platform"
      JWKS_BUCKET                = local.jwks_bucket
      JWKS_OBJECT                = "jwks.json"
      KMS_IDJAG_KEY              = data.terraform_remote_state.shared.outputs.kms_keys.shared_agent_op_idjag
      KMS_IDP_CONNECTION_KEY     = data.terraform_remote_state.shared.outputs.kms_keys.idp_connection
      HUMAN_IDP_AUTHORIZE_URL    = "${local.run_url["human-idp"]}/authorize"
      HUMAN_IDP_TOKEN_URL        = "${local.run_url["human-idp"]}/token"
      HUMAN_IDP_REVOKE_URL       = "${local.run_url["human-idp"]}/revoke"
      ID_JAG_LIFETIME_SECONDS    = "300"
      AGENT_MAX_LIFETIME_SECONDS = tostring(var.agent_max_lifetime_seconds)
    }
    "automation-app" = {
      PUBLIC_BASE_URL            = local.run_url["automation-app"]
      LIFECYCLE_MANAGER_URL      = local.run_url["lifecycle"]
      AGENT_MAX_LIFETIME_SECONDS = tostring(var.agent_max_lifetime_seconds)
    }
    "authorization" = {
      PUBLIC_BASE_URL       = local.run_url["authorization"]
      JWKS_URL              = local.platform_endpoints.jwks_url
      LIFECYCLE_MANAGER_URL = local.run_url["lifecycle"]
      DPOP_IAT_SKEW_SECONDS = "60"
      ACTIVITY_TOPIC        = "agent-activity-stream"
    }
    "provisioner" = {
      PUBLIC_BASE_URL            = local.run_url["provisioner"]
      MAX_FULL_ISOLATION_AGENTS  = tostring(var.max_full_isolation_agents)
      AGENT_MAX_LIFETIME_SECONDS = tostring(var.agent_max_lifetime_seconds)
      ACTIVITY_TOPIC             = "agent-activity-stream"
    }
    "lifecycle" = {
      PUBLIC_BASE_URL            = local.run_url["lifecycle"]
      AGENT_MAX_LIFETIME_SECONDS = tostring(var.agent_max_lifetime_seconds)
      ALLOWED_CALLER_SAS         = join(",", [module.service_accounts["authorization"].email, module.service_accounts["security"].email])
      ACTIVITY_TOPIC             = "agent-activity-stream"
    }
    "security-detection" = {
      PUBLIC_BASE_URL       = local.run_url["security-detection"]
      LIFECYCLE_MANAGER_URL = local.run_url["lifecycle"]
      ACTIVITY_TOPIC        = "agent-activity-stream"
    }
    "resource-docs-as" = {
      PUBLIC_BASE_URL          = local.run_url["resource-docs-as"]
      AS_KIND                  = "docs"
      ISSUER                   = local.resource_servers.docs.issuer
      RESOURCE                 = local.resource_servers.docs.resource
      ALLOWED_SCOPES           = jsonencode(local.resource_servers.docs.scopes)
      SIGNING_KEY_WRAP_KMS_KEY = data.terraform_remote_state.shared.outputs.kms_keys.resource_docs_as
      JWKS_BUCKET              = local.jwks_bucket
      JWKS_KEY_PREFIX          = "docs-as"
    }
    "resource-docs-api" = {
      PUBLIC_BASE_URL      = local.run_url["resource-docs-api"]
      AS_ISSUER            = local.resource_servers.docs.issuer
      RESOURCE             = local.resource_servers.docs.resource
      FIRESTORE_COLLECTION = "documents"
      LIFECYCLE_SA_EMAIL   = module.service_accounts["lifecycle"].email
    }
    "resource-finance-as" = {
      PUBLIC_BASE_URL          = local.run_url["resource-finance-as"]
      AS_KIND                  = "finance"
      ISSUER                   = local.resource_servers.finance.issuer
      RESOURCE                 = local.resource_servers.finance.resource
      ALLOWED_SCOPES           = jsonencode(local.resource_servers.finance.scopes)
      SIGNING_KEY_WRAP_KMS_KEY = data.terraform_remote_state.shared.outputs.kms_keys.resource_finance_as
      JWKS_BUCKET              = local.jwks_bucket
      JWKS_KEY_PREFIX          = "fin-as"
    }
    "resource-finance-api" = {
      PUBLIC_BASE_URL             = local.run_url["resource-finance-api"]
      AS_ISSUER                   = local.resource_servers.finance.issuer
      RESOURCE                    = local.resource_servers.finance.resource
      FIRESTORE_COLLECTION        = "payments"
      REQUIRE_ISOLATION_LEVEL     = "full_isolation"
      FINANCE_ABSOLUTE_MAX_AMOUNT = tostring(var.finance_absolute_max_amount)
      LIFECYCLE_SA_EMAIL          = module.service_accounts["lifecycle"].email
    }
    "google-bridge" = {
      BRIDGE_FACE                = "internal"
      PUBLIC_BASE_URL            = local.run_url["google-bridge"]
      BRIDGE_INTERNAL_BASE_URL   = local.run_url["google-bridge"]
      BRIDGE_CALLBACK_BASE_URL   = local.run_url["google-bridge-callback"]
      AUTOMATION_APP_BASE_URL    = local.run_url["automation-app"]
      PROVISIONER_BASE_URL       = local.run_url["provisioner"]
      SHARED_ISSUER              = local.platform_endpoints.issuer
      JWKS_URL                   = local.platform_endpoints.jwks_url
      CONNECTOR_ENCRYPTION_KEY   = data.terraform_remote_state.shared.outputs.kms_keys.google_connector
      AGENT_MAX_LIFETIME_SECONDS = tostring(var.agent_max_lifetime_seconds)
      SAAS_CONNECTOR_MODE        = var.saas_connector_mode
      CALLER_SA_RUNTIME          = module.service_accounts["agent_runtime"].email
      CALLER_SA_SLOTS            = ""
      CALLER_SA_PROVISIONER      = module.service_accounts["provisioner"].email
      CALLER_SA_LIFECYCLE        = module.service_accounts["lifecycle"].email
    }
    "google-bridge-callback" = {
      BRIDGE_FACE                = "callback"
      PUBLIC_BASE_URL            = local.run_url["google-bridge-callback"]
      BRIDGE_INTERNAL_BASE_URL   = local.run_url["google-bridge"]
      BRIDGE_CALLBACK_BASE_URL   = local.run_url["google-bridge-callback"]
      AUTOMATION_APP_BASE_URL    = local.run_url["automation-app"]
      PROVISIONER_BASE_URL       = local.run_url["provisioner"]
      SHARED_ISSUER              = local.platform_endpoints.issuer
      JWKS_URL                   = local.platform_endpoints.jwks_url
      CONNECTOR_ENCRYPTION_KEY   = data.terraform_remote_state.shared.outputs.kms_keys.google_connector
      AGENT_MAX_LIFETIME_SECONDS = tostring(var.agent_max_lifetime_seconds)
      SAAS_CONNECTOR_MODE        = var.saas_connector_mode
      CALLER_SA_RUNTIME          = module.service_accounts["agent_runtime"].email
      CALLER_SA_SLOTS            = ""
      CALLER_SA_PROVISIONER      = module.service_accounts["provisioner"].email
      CALLER_SA_LIFECYCLE        = module.service_accounts["lifecycle"].email
    }
    "stub-saas-op"  = { PUBLIC_BASE_URL = local.run_url["stub-saas-op"] }
    "stub-saas-api" = { PUBLIC_BASE_URL = local.run_url["stub-saas-api"] }
  }
  service_definitions = {
    for name in local.service_names : name => {
      image           = "${data.terraform_remote_state.shared.outputs.repository_path}/${local.image_app[name]}:${var.image_tag}"
      service_account = module.service_accounts[local.service_sa_key[name]].email
      ingress         = contains(local.public_services, name) ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY"
      env = merge(local.common_env, local.service_specific_env[name], {
        APP_NAME = local.image_app[name]
      })
      secret_env = (startswith(name, "google-bridge") && var.saas_connector_mode == "google") ? {
        GOOGLE_OAUTH_CLIENT_SECRET = {
          secret  = data.terraform_remote_state.shared.outputs.google_oauth_client_secret_id
          version = "latest"
        }
      } : {}
    }
  }
}

module "services" {
  for_each        = local.service_definitions
  source          = "../../modules/cloud-run-service"
  project_id      = var.project_id
  region          = var.region
  name            = each.key
  image           = each.value.image
  service_account = each.value.service_account
  ingress         = each.value.ingress
  env             = each.value.env
  secret_env      = each.value.secret_env
}
