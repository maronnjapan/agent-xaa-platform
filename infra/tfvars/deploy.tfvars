# The profile the deploy workflow applies when a pull request reaches main.
# project_id, region, and image_tag are not here: they change per project and per commit,
# so the workflow passes them with -var.
agent_max_lifetime_seconds  = 86400
max_full_isolation_agents   = 5
expiring_window_seconds     = 60
issuer_profile              = "direct"
issuer_domain               = "issuer.example.invalid"
enable_google_bridge        = false
saas_connector_mode         = "stub"
security_events_delivery    = "pull"
vertex_model                = "gemini-2.5-flash"
vertex_location             = "us-central1"
finance_absolute_max_amount = 1000000
lifecycle_tick_cron         = "*/5 * * * *"
