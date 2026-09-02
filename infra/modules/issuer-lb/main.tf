# T-IAC-17 / DEC-ID-04 / DEC-IAC-20. The `loadbalancer` issuer profile.
#
# Only this module creates google_compute_* resources in the demo state, and it is only
# instantiated when `issuer_profile = "loadbalancer"`. The `direct` profile leaves the
# issuer at the Human IdP's own Cloud Run URL and creates nothing here, which is what
# keeps the default apply free of load-balancer cost.
#
# The five OIDC paths, `/jwks.json`, `/xaa/token` and `/xaa/callback` are the whole
# surface: one host serving one issuer identifier, so ID-JAG's `iss` stays the same
# string in both profiles.

resource "google_compute_region_network_endpoint_group" "run" {
  for_each              = var.backend_services
  project               = var.project_id
  name                  = "${var.name_prefix}-${each.key}"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = each.value
  }
}

resource "google_compute_backend_service" "run" {
  for_each              = var.backend_services
  project               = var.project_id
  name                  = "${var.name_prefix}-${each.key}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  backend {
    group = google_compute_region_network_endpoint_group.run[each.key].id
  }
}

# JWKS is a static object, so it is served from the bucket rather than routed into an
# app that would then have to be publicly reachable (DEC-IAC-13).
resource "google_compute_backend_bucket" "jwks" {
  project     = var.project_id
  name        = "${var.name_prefix}-jwks"
  bucket_name = var.jwks_bucket
  enable_cdn  = false
}

resource "google_compute_url_map" "issuer" {
  project         = var.project_id
  name            = var.name_prefix
  default_service = google_compute_backend_service.run["human-idp"].id

  host_rule {
    hosts        = [var.issuer_domain]
    path_matcher = "issuer"
  }

  path_matcher {
    name            = "issuer"
    default_service = google_compute_backend_service.run["human-idp"].id

    path_rule {
      paths   = ["/authorize", "/token", "/userinfo", "/logout", "/.well-known/openid-configuration"]
      service = google_compute_backend_service.run["human-idp"].id
    }
    path_rule {
      paths   = ["/jwks.json"]
      service = google_compute_backend_bucket.jwks.id
    }
    path_rule {
      paths   = ["/xaa/token"]
      service = google_compute_backend_service.run["shared-agent-op"].id
    }
    path_rule {
      paths   = ["/xaa/callback"]
      service = google_compute_backend_service.run["agent-op-callback"].id
    }
  }
}

resource "google_compute_target_https_proxy" "issuer" {
  project          = var.project_id
  name             = var.name_prefix
  url_map          = google_compute_url_map.issuer.id
  ssl_certificates = [var.ssl_certificate]
}

resource "google_compute_global_forwarding_rule" "issuer" {
  project               = var.project_id
  name                  = var.name_prefix
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = var.ip_address
  port_range            = "443"
  target                = google_compute_target_https_proxy.issuer.id
}
