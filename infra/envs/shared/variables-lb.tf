variable "enable_lb_reservation" {
  type    = bool
  default = false
}

variable "issuer_domain" {
  type    = string
  default = "issuer.example.invalid"
}
