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
# The OAuth client ID the Google Auth Platform issued for the Bridge. Only the ID: the
# secret stays in Secret Manager, and the seed writes this into the connector definition
# the Bridge reads (T-BRIDGE-02). Empty when the connector mode is stub.
variable "google_oauth_client_id" {
  type    = string
  default = ""
}
