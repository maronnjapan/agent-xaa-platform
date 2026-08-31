output "platform_endpoints" {
  value     = local.platform_endpoints
  sensitive = false
}
output "invoker_edges" { value = local.invoker_edges }
output "public_services" { value = local.public_services }
output "max_full_isolation_agents" { value = var.max_full_isolation_agents }
output "runtime_labels" { value = { (local.runtime_label_key) = local.runtime_label_value } }
output "dedicated_op_sa_roles" { value = local.dedicated_op_sa_roles }
output "dedicated_agent_sa_roles" { value = local.dedicated_agent_sa_roles }
output "service_urls" { value = local.run_url }
output "project_id" { value = var.project_id }
output "region" { value = var.region }
