variable "name" { type = string }
variable "image" { type = string }
variable "project_id" { type = string }
variable "region" { type = string }
variable "service_account" {
  type = string
  validation {
    condition     = length(trimspace(var.service_account)) > 0 && !can(regex("-compute@developer\\.gserviceaccount\\.com$", var.service_account))
    error_message = "a dedicated service account is required."
  }
}
variable "task_timeout_seconds" { type = number }
variable "env" {
  type    = map(string)
  default = {}
}
variable "memory" {
  type    = string
  default = "512Mi"
}
variable "cpu" {
  type    = string
  default = "1"
}
