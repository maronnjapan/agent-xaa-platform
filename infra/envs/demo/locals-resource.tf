locals {
  resource_servers = {
    docs = {
      issuer   = local.run_url["resource-docs-as"]
      resource = local.run_url["resource-docs-api"]
      scopes   = ["docs.read", "docs.write"]
    }
    finance = {
      issuer   = local.run_url["resource-finance-as"]
      resource = local.run_url["resource-finance-api"]
      scopes   = ["finance.tx.read", "finance.tx.write"]
    }
  }
}
