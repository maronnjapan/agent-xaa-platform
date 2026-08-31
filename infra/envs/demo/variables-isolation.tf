variable "max_full_isolation_agents" {
  type    = number
  default = 5
  validation {
    condition     = var.max_full_isolation_agents >= 1 && var.max_full_isolation_agents <= 20
    error_message = "full isolation capacity must be from 1 through 20."
  }
}
