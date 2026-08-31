variable "project_id" { type = string }
variable "display_name" { type = string }
variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.account_id))
    error_message = "account_id must satisfy the Google service-account naming constraint."
  }
}
