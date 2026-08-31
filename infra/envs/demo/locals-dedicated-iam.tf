locals {
  dedicated_op_sa_roles = [
    "roles/cloudkms.signerVerifier",
    "roles/cloudkms.cryptoKeyEncrypterDecrypter",
    "roles/datastore.user",
    "roles/storage.objectCreator",
    "roles/pubsub.publisher",
  ]
  dedicated_agent_sa_roles = [
    "roles/run.invoker",
    "roles/run.invoker",
    "roles/run.invoker",
    "roles/aiplatform.user",
    "roles/datastore.user",
    "roles/pubsub.publisher",
  ]
}
