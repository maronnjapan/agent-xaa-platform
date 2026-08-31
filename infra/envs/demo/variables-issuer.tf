variable "issuer_profile" {
  type    = string
  default = "direct"
  validation {
    condition     = contains(["direct", "loadbalancer"], var.issuer_profile)
    error_message = "issuer_profile must be direct or loadbalancer."
  }
}
variable "issuer_domain" {
  type    = string
  default = "issuer.example.invalid"
}
