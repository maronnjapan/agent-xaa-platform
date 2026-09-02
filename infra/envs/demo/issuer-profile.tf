# T-IAC-17. `issuer_profile` decides where the issuer identifier points, and it is the
# only switch that puts a load balancer in this state.
#
# `direct` (the default) instantiates nothing here, so a default plan contains no
# google_compute_* resource and nothing bills while the demo sits idle. The address and
# the managed certificate are reserved in the shared state behind
# `enable_lb_reservation`, so switching this profile off does not release them and
# switching it back on does not have to re-validate a certificate.
module "issuer_lb" {
  count           = var.issuer_profile == "loadbalancer" ? 1 : 0
  source          = "../../modules/issuer-lb"
  project_id      = var.project_id
  region          = var.region
  name_prefix     = "xaa-issuer"
  issuer_domain   = var.issuer_domain
  jwks_bucket     = google_storage_bucket.jwks.name
  ip_address      = data.terraform_remote_state.shared.outputs.issuer_lb_address
  ssl_certificate = data.terraform_remote_state.shared.outputs.issuer_lb_certificate
  backend_services = {
    "human-idp"         = module.services["human-idp"].name
    "shared-agent-op"   = module.services["shared-agent-op"].name
    "agent-op-callback" = module.services["agent-op-callback"].name
  }
}
