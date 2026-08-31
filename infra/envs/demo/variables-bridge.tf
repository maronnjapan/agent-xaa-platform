variable "enable_google_bridge" {
  type    = bool
  default = false
}
variable "saas_connector_mode" {
  type    = string
  default = "stub"
  validation {
    condition     = contains(["stub", "google"], var.saas_connector_mode)
    error_message = "saas_connector_mode must be stub or google."
  }
}
