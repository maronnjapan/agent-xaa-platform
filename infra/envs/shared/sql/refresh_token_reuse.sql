-- T-SEC-14 / REQ-09-025. A refresh token presented after it was rotated away.
--
-- Agent OP is the only holder of an agent's Human IdP refresh token, so the retired
-- value coming back is evidence of a leak rather than a race. The judgement is made
-- there, inside the rotation transaction, and written as `reuse_detected` (DEC-SEC-02);
-- this view only extracts what was already decided.
--
-- `refresh_token_reuse` is not one of the sixteen protocol violations — nothing about
-- the request was malformed — so it travels under the extended code, and the six columns
-- match the other saved detections so all of them can be UNION ALL'd into one feed.
SELECT
  timestamp AS occurred_at,
  jsonPayload.agent_id AS agent_id,
  jsonPayload.human_subject AS human_subject,
  jsonPayload.trace_id AS trace_id,
  'refresh_token_reuse' AS detection_code,
  TO_JSON_STRING(STRUCT(
    jsonPayload.fields.idp_connection_id AS idp_connection_id,
    jsonPayload.fields.rotation_result AS rotation_result,
    jsonPayload.fields.revoke_result AS revoke_result
  )) AS detail
FROM `${project_id}.security_audit.run_googleapis_com_stdout`
WHERE jsonPayload.log_source = 'agent_op_idp_connection'
  AND jsonPayload.fields.reuse_detected = true
