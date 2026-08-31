data "terraform_remote_state" "shared" {
  backend = "gcs"
  config = {
    bucket = "${var.project_id}-tfstate"
    prefix = "state/shared"
  }
}
