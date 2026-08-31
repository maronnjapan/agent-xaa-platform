variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "asia-northeast1"
}
variable "image_tag" { type = string }
variable "finance_absolute_max_amount" {
  type    = number
  default = 1000000
}

# Pull is the default because Security Detection is INTERNAL_ONLY; `push` is available
# only if the DEC-SCOPE-02 spike shows a push subscription can reach it.
variable "security_events_delivery" {
  type        = string
  default     = "pull"
  description = "How security events reach the detector: pull or push."
  validation {
    condition     = contains(["pull", "push"], var.security_events_delivery)
    error_message = "security_events_delivery must be pull or push."
  }
}
