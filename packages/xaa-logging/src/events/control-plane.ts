export const CONTROL_PLANE_EVENT_FIELDS = {
  'authz_ai.infer': ['agent_draft_id', 'work_definition_id', 'work_definition_hash', 'proposed_capabilities', 'confidence', 'taxonomy_version', 'model_version'],
  'policy.decide': ['proposed_capabilities', 'effective_capabilities', 'security_profile', 'isolation_level', 'decision', 'policy_id', 'decision_reason'],
  'provisioner.provision': ['isolation_level', 'dedicated_op', 'provisioned_tools', 'static_xaa', 'idp_connection_state', 'connector_state', 'created_at', 'expires_at', 'destroyed_at'],
  'resource_api.access': ['tool_id', 'operation', 'http_method', 'resource', 'response_status', 'outcome', 'latency_ms'],
  'runtime.tool_call': ['task_id', 'execution_id', 'tool_id', 'requested_operation', 'target_resource', 'result', 'agent_age_seconds', 'expires_at', 'span_id'],
} as const;
