variable "topic" { type = string }
variable "subscription_name" { type = string }
variable "push_endpoint" { type = string }
variable "oidc_service_account" { type = string }
variable "audience" { type = string }
variable "ack_deadline_seconds" {
  type    = number
  default = 60
}
variable "message_retention_duration" {
  type    = string
  default = "600s"
}
variable "project_id" { type = string }
