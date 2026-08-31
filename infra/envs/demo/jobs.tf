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
  source               = "../../modules/cloud-run-job"
  project_id           = var.project_id
  region               = var.region
  name                 = "jwks-publish"
  image                = "${data.terraform_remote_state.shared.outputs.repository_path}/jwks-publish:${var.image_tag}"
  service_account      = module.service_accounts["jwks_publish"].email
  task_timeout_seconds = 120
  env = {
    JWKS_BUCKET = google_storage_bucket.jwks.name
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
  env = {
    PROJECT_ID             = var.project_id
    FIRESTORE_DATABASE     = "xaa"
    PLATFORM_ENDPOINTS_URI = "gs://${google_storage_bucket.platform_config.name}/platform-endpoints.json"
    SEED_BUCKET            = google_storage_bucket.platform_config.name
    ENABLE_GOOGLE_BRIDGE   = tostring(var.enable_google_bridge)
  }
}
