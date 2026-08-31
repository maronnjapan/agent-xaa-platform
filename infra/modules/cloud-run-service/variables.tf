variable "name" { type = string }
variable "image" { type = string }
variable "project_id" { type = string }
variable "region" { type = string }
variable "service_account" {
  type = string
  validation {
    condition     = length(trimspace(var.service_account)) > 0
    error_message = "service_account is required."
  }
  validation {
    condition     = !can(regex("-compute@developer\\.gserviceaccount\\.com$", var.service_account))
    error_message = "default compute service accounts are forbidden."
  }
}
variable "ingress" {
  type    = string
  default = "INGRESS_TRAFFIC_INTERNAL_ONLY"
}
variable "env" {
  type    = map(string)
  default = {}
}
variable "secret_env" {
  type    = map(object({ secret = string, version = string }))
  default = {}
}
variable "max_instance_count" {
  type    = number
  default = 2
}
variable "memory" {
  type    = string
  default = "512Mi"
}
variable "cpu" {
  type    = string
  default = "1"
}
variable "timeout_seconds" {
  type    = number
  default = 300
}
