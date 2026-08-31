variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "asia-northeast1"
}
variable "probe_image" { type = string }
variable "enable_deny_probe" {
  type    = bool
  default = true
}
