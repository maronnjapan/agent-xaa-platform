locals {
  kms_bindings = {
    shared_op_sign = {
      key_id = data.terraform_remote_state.shared.outputs.kms_keys.shared_agent_op_idjag
      member = module.service_accounts["shared_agent_op"].member
      role   = "roles/cloudkms.signerVerifier"
    }
    shared_op_idp_connection = {
      key_id = data.terraform_remote_state.shared.outputs.kms_keys.idp_connection
      member = module.service_accounts["shared_agent_op"].member
      role   = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
    }
    human_idp = {
      key_id = data.terraform_remote_state.shared.outputs.kms_keys.human_idp_sso
      member = module.service_accounts["human_idp"].member
      role   = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
    }
    docs_as = {
      key_id = data.terraform_remote_state.shared.outputs.kms_keys.resource_docs_as
      member = module.service_accounts["resource_docs_as"].member
      role   = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
    }
    finance_as = {
      key_id = data.terraform_remote_state.shared.outputs.kms_keys.resource_finance_as
      member = module.service_accounts["resource_finance_as"].member
      role   = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
    }
  }
}

resource "google_kms_crypto_key_iam_member" "application_keys" {
  for_each      = local.kms_bindings
  crypto_key_id = each.value.key_id
  role          = each.value.role
  member        = each.value.member
}

resource "google_kms_crypto_key_iam_member" "bridge_key" {
  count         = var.enable_google_bridge ? 1 : 0
  crypto_key_id = data.terraform_remote_state.shared.outputs.kms_keys.google_connector
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = module.service_accounts["google_bridge"].member
}

resource "google_kms_key_ring_iam_member" "runtime_key_admins" {
  for_each = {
    provisioner_idjag = { ring = "idjag-signing", member = module.service_accounts["provisioner"].member }
    provisioner_idp   = { ring = "idp-connection-encryption", member = module.service_accounts["provisioner"].member }
    lifecycle_idjag   = { ring = "idjag-signing", member = module.service_accounts["lifecycle"].member }
    lifecycle_idp     = { ring = "idp-connection-encryption", member = module.service_accounts["lifecycle"].member }
  }
  key_ring_id = data.terraform_remote_state.shared.outputs.kms_key_rings[each.value.ring]
  role        = "roles/cloudkms.admin"
  member      = each.value.member
}
