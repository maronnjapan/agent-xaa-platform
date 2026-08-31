terraform {
  backend "gcs" {
    prefix = "state/shared"
  }
}
