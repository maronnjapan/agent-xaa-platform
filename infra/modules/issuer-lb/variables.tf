variable "project_id" { type = string }
variable "region" { type = string }

variable "name_prefix" {
  type        = string
  description = "Prefix for every load-balancer resource this module creates."
}

variable "issuer_domain" {
  type        = string
  description = "Host the issuer answers on. The certificate in the shared state covers it."
}

variable "backend_services" {
  type        = map(string)
  description = "Cloud Run service names by role: human-idp, shared-agent-op, agent-op-callback."
  validation {
    condition     = alltrue([for role in ["human-idp", "shared-agent-op", "agent-op-callback"] : contains(keys(var.backend_services), role)])
    error_message = "backend_services needs human-idp, shared-agent-op and agent-op-callback."
  }
}

variable "jwks_bucket" {
  type        = string
  description = "Bucket holding jwks.json, served through a Backend Bucket rather than an app."
}

variable "ip_address" {
  type        = string
  description = "Reserved global address from the shared state (enable_lb_reservation)."
}

variable "ssl_certificate" {
  type        = string
  description = "Managed certificate id from the shared state (enable_lb_reservation)."
}
