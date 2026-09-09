# The Google API the bridged Tool actually calls, enabled only when this deployment is
# pointed at Google. It is here rather than in `infra/envs/shared/services.tf` because
# that list is what every deployment needs and this one is what `saas_connector_mode`
# needs; enabling a Calendar API in a project whose Bridge talks to the stub SaaS would
# be a permission granted for a call nothing makes.
#
# `scripts/google-bridge-guide.sh` also enables it, and earlier: the Google Auth Platform
# lists a scope only for an API the project has switched on, so a person configuring the
# consent screen needs it before this apply runs. Enabling an already-enabled service is
# a no-op, so the two do not fight; this one is what keeps it enabled.
resource "google_project_service" "google_saas_api" {
  count              = var.enable_google_bridge && var.saas_connector_mode == "google" ? 1 : 0
  project            = var.project_id
  service            = "calendar-json.googleapis.com"
  disable_on_destroy = false
}
