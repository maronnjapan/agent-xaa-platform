output "url_map" { value = google_compute_url_map.issuer.name }
output "forwarding_rule" { value = google_compute_global_forwarding_rule.issuer.name }
