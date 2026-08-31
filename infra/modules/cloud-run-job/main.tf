resource "google_cloud_run_v2_job" "this" {
  project             = var.project_id
  location            = var.region
  name                = var.name
  deletion_protection = false
  template {
    task_count  = 1
    parallelism = 1
    template {
      service_account = var.service_account
      max_retries     = 0
      timeout         = "${var.task_timeout_seconds}s"
      containers {
        image = var.image
        resources {
          limits = { cpu = var.cpu, memory = var.memory }
        }
        dynamic "env" {
          for_each = var.env
          content {
            name  = env.key
            value = env.value
          }
        }
      }
    }
  }
}
