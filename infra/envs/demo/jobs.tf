locals {
  runtime_static_env = merge(local.common_env, {
    APP_NAME                   = "agent-runtime"
    GOOGLE_CLOUD_PROJECT       = var.project_id
    ISOLATION_LEVEL            = "standard"
    AGENT_MAX_LIFETIME_SECONDS = tostring(var.agent_max_lifetime_seconds)
    ACTIVITY_TOPIC             = "agent-activity-stream"
    LOG_LEVEL                  = "info"
  })
}

module "agent_runtime_standard" {
  source               = "../../modules/cloud-run-job"
  project_id           = var.project_id
  region               = var.region
  name                 = "agent-runtime-standard"
  image                = "${data.terraform_remote_state.shared.outputs.repository_path}/agent-runtime:${var.image_tag}"
  service_account      = module.service_accounts["agent_runtime"].email
  task_timeout_seconds = var.agent_max_lifetime_seconds
  env                  = local.runtime_static_env
}

module "jwks_publish" {
  source          = "../../modules/cloud-run-job"
  project_id      = var.project_id
  region          = var.region
  name            = "jwks-publish"
  image           = "${data.terraform_remote_state.shared.outputs.repository_path}/jwks-publish:${var.image_tag}"
  service_account = module.service_accounts["jwks_publish"].email
  # The job now waits for the Human IdP to publish its SSO key before it reads the
  # bucket, and a cold start plus RSA generation plus the KMS wrap does not fit in 120s.
  task_timeout_seconds = 600
  env = {
    JWKS_BUCKET = google_storage_bucket.jwks.name
    # The service's own URL rather than `platform_endpoints.issuer`: under the
    # `loadbalancer` issuer profile the issuer is a domain that may not resolve yet,
    # and what this job needs is the one Cloud Run service that writes `keys/idp-*`.
    # Public ingress and `allUsers` invoker (iam-public.tf), so no token is needed.
    HUMAN_IDP_JWKS_URL = "${local.run_url["human-idp"]}/.well-known/jwks.json"
  }
}

module "seed" {
  source               = "../../modules/cloud-run-job"
  project_id           = var.project_id
  region               = var.region
  name                 = "seed"
  image                = "${data.terraform_remote_state.shared.outputs.repository_path}/seed:${var.image_tag}"
  service_account      = module.service_accounts["seed"].email
  task_timeout_seconds = 600
  env = merge({
    PROJECT_ID             = var.project_id
    FIRESTORE_DATABASE     = local.firestore_database_id
    PLATFORM_ENDPOINTS_URI = "gs://${google_storage_bucket.platform_config.name}/platform-endpoints.json"
    SEED_BUCKET            = google_storage_bucket.platform_config.name
    ENABLE_GOOGLE_BRIDGE   = tostring(var.enable_google_bridge)
    # What the seed writes into connector_definitions for the Bridge (T-BRIDGE-02): the
    # stub's fixed client or the Google client. Secret names only; values stay in
    # Secret Manager.
    SAAS_CONNECTOR_MODE    = var.saas_connector_mode
    STUB_BRIDGE_SECRET_ID  = data.terraform_remote_state.shared.outputs.stub_bridge_client_secret_id
    GOOGLE_OAUTH_SECRET_ID = data.terraform_remote_state.shared.outputs.google_oauth_client_secret_id
  }, var.google_oauth_client_id == "" ? {} : { GOOGLE_OAUTH_CLIENT_ID = var.google_oauth_client_id })
}
