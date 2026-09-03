resource "google_secret_manager_secret" "google_oauth_client_secret" {
  project   = var.project_id
  secret_id = "google-oauth-client-secret"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.required]
}

# The Human IdP has two stable confidential clients. Terraform owns the Secret
# containers, while the deployment guide creates the first versions without ever
# putting their plaintext in a tfvars file or Terraform state.
locals {
  human_idp_client_secrets = {
    automation_app = "human-idp-automation-client-secret"
    agent_platform = "human-idp-agent-platform-client-secret"
  }
}

resource "google_secret_manager_secret" "human_idp_client" {
  for_each  = local.human_idp_client_secrets
  project   = var.project_id
  secret_id = each.value
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.required]
}

# The stub SaaS the Bridge talks to in `saas_connector_mode = "stub"` checks a fixed client
# secret, and the Bridge reads every connector's secret from Secret Manager by name (T-BRIDGE-09).
# The container therefore exists whenever the shared state does; the deployment guide adds
# the one version, so the value is never in a tfvars file or in Terraform state.
resource "google_secret_manager_secret" "stub_bridge_client_secret" {
  project   = var.project_id
  secret_id = "stub-bridge-client-secret"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.required]
}

# Refresh tokens are KMS-encrypted in Firestore; Secret Manager stores only the OAuth client secret.
resource "google_secret_manager_secret_version" "google_oauth_client_secret" {
  count       = var.google_oauth_client_secret_value == null ? 0 : 1
  secret      = google_secret_manager_secret.google_oauth_client_secret.id
  secret_data = var.google_oauth_client_secret_value
}
