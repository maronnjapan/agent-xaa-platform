variable "agent_max_lifetime_seconds" {
  type    = number
  default = 86400
  validation {
    condition     = var.agent_max_lifetime_seconds >= 60 && var.agent_max_lifetime_seconds <= 86400
    error_message = "agent lifetime must be from 60 through 86400 seconds."
  }
}

# T-LIFE-10. How far ahead of the deadline an agent is marked EXPIRING. It is a warning
# window, not a grace period: the agent is not cleaned up until `expires_at` passes, so
# widening this only moves when the timeline says the end is coming.
variable "expiring_window_seconds" {
  type    = number
  default = 60
  validation {
    condition     = var.expiring_window_seconds >= 0 && var.expiring_window_seconds <= 3600
    error_message = "the expiring window must be from 0 through 3600 seconds."
  }
}
