terraform {
  required_version = "= 1.9.8"
  required_providers {
    google = { source = "hashicorp/google", version = "= 6.14.1" }
    # google-beta is pinned identically for Firestore TTL and IAM Deny resources.
    google-beta = { source = "hashicorp/google-beta", version = "= 6.14.1" }
  }
}
