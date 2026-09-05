# Who may operate the two admin consoles: the permission screens on the Authorization
# Platform and the mapping screen on the Provisioner.
#
# Neither service is on the public surface (RULE-37) — no `allUsers` invoker grant
# reaches them — so an administrator opens a console through
# `gcloud run services proxy`, which attaches a Google-signed identity token for their
# own account. The app checks that token's `email` against this list.
#
# Empty by default, and empty means nobody. Treating "not configured" as "anyone with
# run.invoker" would turn a missing tfvars line into an open editor for what every
# future agent may be granted.
variable "admin_principals" {
  type        = list(string)
  default     = []
  description = "Google account emails allowed on the admin consoles."
  validation {
    condition     = alltrue([for principal in var.admin_principals : can(regex("^[^@[:space:]]+@[^@[:space:]]+$", principal))])
    error_message = "admin_principals must be email addresses."
  }
}
