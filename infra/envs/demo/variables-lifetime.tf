variable "agent_max_lifetime_seconds" {
  type    = number
  default = 86400
  validation {
    condition     = var.agent_max_lifetime_seconds >= 60 && var.agent_max_lifetime_seconds <= 86400
    error_message = "agent lifetime must be from 60 through 86400 seconds."
  }
}
