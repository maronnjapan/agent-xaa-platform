locals {
  common_env = {
    PROJECT_ID             = var.project_id
    GOOGLE_CLOUD_PROJECT   = var.project_id
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
      KMS_IDJAG_KEY              = data.terraform_remote_state.shared.outputs.kms_key_versions.shared_agent_op_idjag
      KMS_IDP_CONNECTION_KEY     = data.terraform_remote_state.shared.outputs.kms_keys.idp_connection
      HUMAN_IDP_AUTHORIZE_URL    = "${local.run_url["human-idp"]}/authorize"
      HUMAN_IDP_TOKEN_URL        = "${local.run_url["human-idp"]}/token"
      HUMAN_IDP_REVOKE_URL       = "${local.run_url["human-idp"]}/revoke"
      AGENT_OP_CALLBACK_URL      = local.run_url["agent-op-callback"]
      PROVISIONER_SA_EMAIL       = module.service_accounts["provisioner"].email
      LIFECYCLE_SA_EMAIL         = module.service_accounts["lifecycle"].email
      ID_JAG_LIFETIME_SECONDS    = "300"
      AGENT_MAX_LIFETIME_SECONDS = tostring(var.agent_max_lifetime_seconds)
      AUTOMATION_APP_URL         = local.run_url["automation-app"]
    }
    "agent-op-callback" = {
      MODE                       = "callback"
      ISSUER                     = local.platform_endpoints.issuer
      PUBLIC_BASE_URL            = local.run_url["agent-op-callback"]
      XAA_CLIENT_ID              = "agent-platform"
      JWKS_BUCKET                = local.jwks_bucket
      JWKS_OBJECT                = "jwks.json"
      KMS_IDJAG_KEY              = data.terraform_remote_state.shared.outputs.kms_key_versions.shared_agent_op_idjag
      KMS_IDP_CONNECTION_KEY     = data.terraform_remote_state.shared.outputs.kms_keys.idp_connection
      HUMAN_IDP_AUTHORIZE_URL    = "${local.run_url["human-idp"]}/authorize"
      HUMAN_IDP_TOKEN_URL        = "${local.run_url["human-idp"]}/token"
      HUMAN_IDP_REVOKE_URL       = "${local.run_url["human-idp"]}/revoke"
      AGENT_OP_CALLBACK_URL      = local.run_url["agent-op-callback"]
      PROVISIONER_SA_EMAIL       = module.service_accounts["provisioner"].email
      LIFECYCLE_SA_EMAIL         = module.service_accounts["lifecycle"].email
      ID_JAG_LIFETIME_SECONDS    = "300"
      AGENT_MAX_LIFETIME_SECONDS = tostring(var.agent_max_lifetime_seconds)
      AUTOMATION_APP_URL         = local.run_url["automation-app"]
    }
    "automation-app" = {
      ISSUER                     = local.platform_endpoints.issuer
      PUBLIC_BASE_URL            = local.run_url["automation-app"]
      AUTHORIZATION_PLATFORM_URL = local.run_url["authorization"]
      AGENT_PROVISIONER_URL      = local.run_url["provisioner"]
      LIFECYCLE_MANAGER_URL      = local.run_url["lifecycle"]
      DOCS_API_URL               = local.resource_servers.docs.resource
      ACTIVITY_TOPIC             = "agent-activity-stream"
      AGENT_MAX_LIFETIME_SECONDS = tostring(var.agent_max_lifetime_seconds)
    }
    "authorization" = {
      ISSUER                     = local.platform_endpoints.issuer
      PUBLIC_BASE_URL            = local.run_url["authorization"]
      JWKS_URL                   = local.platform_endpoints.jwks_url
      AUTHZ_AUDIENCE             = "authorization-platform"
      LIFECYCLE_MANAGER_URL      = local.run_url["lifecycle"]
      DPOP_IAT_SKEW_SECONDS      = "60"
      ACTIVITY_TOPIC             = "agent-activity-stream"
      TAXONOMY_VERSION           = "v1"
      AGENT_MAX_LIFETIME_SECONDS = tostring(var.agent_max_lifetime_seconds)
    }
    "provisioner" = {
      ISSUER                          = local.platform_endpoints.issuer
      JWKS_URL                        = local.platform_endpoints.jwks_url
      PROVISIONER_AUDIENCE            = "agent-provisioner"
      PUBLIC_BASE_URL                 = local.run_url["provisioner"]
      SHARED_AGENT_OP_URL             = local.run_url["shared-agent-op"]
      STANDARD_JOB_NAME               = module.agent_runtime_standard.name
      MAX_FULL_ISOLATION_AGENTS       = tostring(var.max_full_isolation_agents)
      AGENT_MAX_LIFETIME_SECONDS      = tostring(var.agent_max_lifetime_seconds)
      ACTIVITY_TOPIC                  = "agent-activity-stream"
      IDJAG_KEY_RING                  = data.terraform_remote_state.shared.outputs.kms_key_rings["idjag-signing"]
      IDP_CONNECTION_KEY_RING         = data.terraform_remote_state.shared.outputs.kms_key_rings["idp-connection-encryption"]
      JWKS_BUCKET                     = local.jwks_bucket
      PROVISIONER_SA_EMAIL            = module.service_accounts["provisioner"].email
      AGENT_PLATFORM_CLIENT_SECRET_ID = data.terraform_remote_state.shared.outputs.human_idp_client_secret_ids.agent_platform
      DEDICATED_RUNTIME_INVOKER_SERVICES = jsonencode(compact([
        "projects/${var.project_id}/locations/${var.region}/services/resource-docs-as",
        "projects/${var.project_id}/locations/${var.region}/services/resource-finance-as",
        var.enable_google_bridge ? "projects/${var.project_id}/locations/${var.region}/services/google-bridge" : null,
      ]))
      AGENT_OP_IMAGE        = "${data.terraform_remote_state.shared.outputs.repository_path}/agent-op:${var.image_tag}"
      AGENT_RUNTIME_IMAGE   = "${data.terraform_remote_state.shared.outputs.repository_path}/agent-runtime:${var.image_tag}"
      DEDICATED_RUNTIME_ENV = jsonencode(local.runtime_static_env)
      DEDICATED_OP_ENV = jsonencode({
        MODE                       = "token"
        ISSUER                     = local.platform_endpoints.issuer
        XAA_CLIENT_ID              = "agent-platform"
        GOOGLE_CLOUD_PROJECT       = var.project_id
        FIRESTORE_DATABASE         = "xaa"
        JWKS_BUCKET                = local.jwks_bucket
        JWKS_OBJECT                = "jwks.json"
        HUMAN_IDP_AUTHORIZE_URL    = "${local.run_url["human-idp"]}/authorize"
        HUMAN_IDP_TOKEN_URL        = "${local.run_url["human-idp"]}/token"
        HUMAN_IDP_REVOKE_URL       = "${local.run_url["human-idp"]}/revoke"
        AGENT_OP_CALLBACK_URL      = local.run_url["agent-op-callback"]
        PROVISIONER_SA_EMAIL       = module.service_accounts["provisioner"].email
        LIFECYCLE_SA_EMAIL         = module.service_accounts["lifecycle"].email
        ID_JAG_LIFETIME_SECONDS    = "300"
        SIGNER_MODE                = "kms"
        STORE_MODE                 = "gcp"
        AGENT_MAX_LIFETIME_SECONDS = tostring(var.agent_max_lifetime_seconds)
        AUTOMATION_APP_URL         = local.run_url["automation-app"]
      })
    }
    "lifecycle" = {
      ISSUER                     = local.platform_endpoints.issuer
      PUBLIC_BASE_URL            = local.run_url["lifecycle"]
      AGENT_MAX_LIFETIME_SECONDS = tostring(var.agent_max_lifetime_seconds)
      EXPIRING_WINDOW_SECONDS    = tostring(var.expiring_window_seconds)
      ALLOWED_CALLER_SAS = join(",", [
        module.service_accounts["authorization"].email,
        module.service_accounts["security"].email,
        module.service_accounts["scheduler"].email,
        module.service_accounts["pubsub_push"].email,
      ])
      # RULE-28: the identity feed this service pulls (T-LIFE-15).
      IDENTITY_DISABLED_SUBSCRIPTION = google_pubsub_subscription.identity_disabled_to_lifecycle.name
      ACTIVITY_TOPIC                 = "agent-activity-stream"
      JWKS_BUCKET                    = local.jwks_bucket
      PLATFORM_ENDPOINTS_JSON        = jsonencode(local.platform_endpoints)
    }
    "security-detection" = {
      PUBLIC_BASE_URL          = local.run_url["security-detection"]
      LIFECYCLE_MANAGER_URL    = local.run_url["lifecycle"]
      RESOURCE_FINANCE_API_URL = local.resource_servers.finance.resource
      ACTIVITY_TOPIC           = "agent-activity-stream"
      # The detector reads the topic itself (DEC-SEC-03); the subscription is named here
      # because the service has no way to discover it.
      # The Lifetime rules compare an agent's age against the platform maximum, so the
      # detector needs the same number the Provisioner enforces (DEC-IAC-16).
      AGENT_MAX_LIFETIME_SECONDS   = tostring(var.agent_max_lifetime_seconds)
      SECURITY_EVENTS_SUBSCRIPTION = google_pubsub_subscription.security_logs_to_detection.name
      SECURITY_EVENTS_DELIVERY     = var.security_events_delivery
      # Only consulted by the push route, which stays closed when this is empty.
      ALLOWED_CALLER_SAS = var.security_events_delivery == "push" ? module.service_accounts["security"].email : ""
    }
    "resource-docs-as" = {
      PUBLIC_BASE_URL      = local.run_url["resource-docs-as"]
      AS_KIND              = "docs"
      ISSUER               = local.resource_servers.docs.issuer
      RESOURCE             = local.resource_servers.docs.resource
      TRUSTED_IDP_ISSUER   = local.platform_endpoints.issuer
      TRUSTED_IDP_JWKS_URI = local.platform_endpoints.jwks_url
      REGISTERED_SCOPES    = join(" ", local.resource_servers.docs.scopes)
      SIGNING_KEY_BUCKET   = google_storage_bucket.platform_config.name
      SIGNING_KEY_KMS_KEY  = data.terraform_remote_state.shared.outputs.kms_keys.resource_docs_as
      JWKS_BUCKET          = local.jwks_bucket
      JWKS_KEY_PREFIX      = "docs-as"
    }
    "resource-docs-api" = {
      PUBLIC_BASE_URL      = local.run_url["resource-docs-api"]
      AS_ISSUER            = local.resource_servers.docs.issuer
      RESOURCE             = local.resource_servers.docs.resource
      JWKS_URL             = local.platform_endpoints.jwks_url
      FIRESTORE_COLLECTION = "documents"
      LIFECYCLE_SA_EMAIL   = module.service_accounts["lifecycle"].email
      # T-APP-05: the one other caller `serviceIdentity` ever accepts, and only for
      # `POST /documents` with `type: 'daily_report'` (see internal-write.ts).
      AUTOMATION_APP_SA_EMAIL = module.service_accounts["automation_app"].email
    }
    "resource-finance-as" = {
      PUBLIC_BASE_URL      = local.run_url["resource-finance-as"]
      AS_KIND              = "finance"
      ISSUER               = local.resource_servers.finance.issuer
      RESOURCE             = local.resource_servers.finance.resource
      TRUSTED_IDP_ISSUER   = local.platform_endpoints.issuer
      TRUSTED_IDP_JWKS_URI = local.platform_endpoints.jwks_url
      REGISTERED_SCOPES    = join(" ", local.resource_servers.finance.scopes)
      SIGNING_KEY_BUCKET   = google_storage_bucket.platform_config.name
      SIGNING_KEY_KMS_KEY  = data.terraform_remote_state.shared.outputs.kms_keys.resource_finance_as
      JWKS_BUCKET          = local.jwks_bucket
      JWKS_KEY_PREFIX      = "fin-as"
      # T-RES-19: the redemption gate, the twin of the one on resource-finance-api.
      # Without it the Authorization Server would hand a standard agent a token that
      # the API then refuses, which is the check happening once instead of twice.
      REQUIRE_ISOLATION_LEVEL = "full_isolation"
    }
    "resource-finance-api" = {
      PUBLIC_BASE_URL             = local.run_url["resource-finance-api"]
      AS_ISSUER                   = local.resource_servers.finance.issuer
      RESOURCE                    = local.resource_servers.finance.resource
      JWKS_URL                    = local.platform_endpoints.jwks_url
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
      secret_env = merge(
        name == "human-idp" ? {
          CLIENT_SECRET_AUTOMATION_APP = {
            secret  = data.terraform_remote_state.shared.outputs.human_idp_client_secret_ids.automation_app
            version = "latest"
          }
          CLIENT_SECRET_AGENT_PLATFORM = {
            secret  = data.terraform_remote_state.shared.outputs.human_idp_client_secret_ids.agent_platform
            version = "latest"
          }
        } : {},
        name == "automation-app" ? {
          CLIENT_SECRET_AUTOMATION_APP = {
            secret  = data.terraform_remote_state.shared.outputs.human_idp_client_secret_ids.automation_app
            version = "latest"
          }
        } : {},
        contains(["shared-agent-op", "agent-op-callback"], name) ? {
          CLIENT_SECRET_AGENT_PLATFORM = {
            secret  = data.terraform_remote_state.shared.outputs.human_idp_client_secret_ids.agent_platform
            version = "latest"
          }
        } : {},
        (startswith(name, "google-bridge") && var.saas_connector_mode == "google") ? {
          GOOGLE_OAUTH_CLIENT_SECRET = {
            secret  = data.terraform_remote_state.shared.outputs.google_oauth_client_secret_id
            version = "latest"
          }
        } : {},
      )
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
  depends_on = [
    google_secret_manager_secret_iam_member.human_idp_client,
    google_secret_manager_secret_iam_member.automation_client,
    google_secret_manager_secret_iam_member.agent_op_client,
    google_secret_manager_secret_iam_member.bridge,
  ]
}
