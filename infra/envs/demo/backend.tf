terraform {
  backend "gcs" {
    prefix = "state/demo"
  }
}
