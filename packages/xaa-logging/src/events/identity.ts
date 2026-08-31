export const IDENTITY_EVENT_FIELDS = {
  'idp.authenticate': ['client_id', 'audience', 'scope', 'auth_result', 'dpop_result', 'source_ip', 'user_agent'],
  'idp.token': ['client_id', 'audience', 'scope', 'auth_result', 'dpop_result', 'source_ip', 'user_agent'],
  'agent_op.token_exchange': ['op_runtime_id', 'isolation_kind', 'requested_audience', 'requested_resource', 'requested_scope', 'subject_token_iss', 'subject_token_aud', 'subject_token_sub', 'actor_token_sub', 'actor_token_jti', 'delegation_match', 'dpop_result', 'issued_jti', 'issued_kid', 'issued_jkt', 'expiry_check', 'error_code'],
  'agent_op.subject_token': ['op_runtime_id', 'isolation_kind', 'requested_audience', 'requested_resource', 'requested_scope', 'subject_token_iss', 'subject_token_aud', 'subject_token_sub', 'actor_token_sub', 'actor_token_jti', 'delegation_match', 'dpop_result', 'issued_jti', 'issued_kid', 'issued_jkt', 'expiry_check', 'error_code'],
  'agent_op.idp_connection': ['idp_connection_id', 'refresh_rotation_result', 'refresh_reuse_detected', 'subject_token_refetch_result', 'revoke_result'],
  'bridge.token': ['id_jag_iss', 'id_jag_verify_result', 'connection_id', 'requested_resource', 'requested_scope', 'agent_expiry_check', 'google_refresh_result', 'access_token_issue_result'],
  'resource_as.redeem': ['id_jag_iss', 'id_jag_sub', 'id_jag_act', 'id_jag_client_id', 'audience', 'resource', 'scope', 'cnf_jkt', 'dpop_binding_result', 'token_issue_result', 'authz_decision', 'received_kid', 'received_typ'],
} as const;
