resource "google_compute_global_address" "issuer" {
  count   = var.enable_lb_reservation ? 1 : 0
  project = var.project_id
  name    = "xaa-issuer"
}

resource "google_compute_managed_ssl_certificate" "issuer" {
  count   = var.enable_lb_reservation ? 1 : 0
  project = var.project_id
  name    = "xaa-issuer"
  managed {
    domains = [var.issuer_domain]
  }
}
