locals {
  invoker_edge_pairs = concat([
    ["automation_app", "authorization"],
    ["automation_app", "provisioner"],
    ["automation_app", "lifecycle"],
    ["authorization", "lifecycle"],
    ["provisioner", "shared-agent-op"],
    ["provisioner", "agent-op-callback"],
    ["lifecycle", "shared-agent-op"],
    ["lifecycle", "provisioner"],
    ["lifecycle", "resource-docs-as"],
    ["lifecycle", "resource-finance-as"],
    ["lifecycle", "resource-docs-api"],
    ["lifecycle", "resource-finance-api"],
    ["agent_runtime", "shared-agent-op"],
    ["agent_runtime", "resource-docs-as"],
    ["agent_runtime", "resource-finance-as"],
    ["agent_runtime", "resource-docs-api"],
    ["agent_runtime", "resource-finance-api"],
    ["security", "lifecycle"],
    ["scheduler", "lifecycle"],
    ["pubsub_push", "authorization"],
    ["pubsub_push", "automation-app"],
    ["pubsub_push", "security-detection"],
    ], var.enable_google_bridge ? [
    ["provisioner", "google-bridge"],
    ["lifecycle", "google-bridge"],
    ["agent_runtime", "google-bridge"],
  ] : [])
  invoker_edges = {
    for pair in local.invoker_edge_pairs : "${pair[0]}|${pair[1]}" => {
      member  = module.service_accounts[pair[0]].member
      service = pair[1]
    }
  }
}
