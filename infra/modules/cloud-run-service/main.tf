resource "google_cloud_run_v2_service" "this" {
  project             = var.project_id
  location            = var.region
  name                = var.name
  ingress             = var.ingress
  deletion_protection = false
  template {
    service_account       = var.service_account
    timeout               = "${var.timeout_seconds}s"
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instance_count
    }
    containers {
      image = var.image
      resources {
        limits   = { cpu = var.cpu, memory = var.memory }
        cpu_idle = true
      }
      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret
              version = env.value.version
            }
          }
        }
      }
    }
  }
}
