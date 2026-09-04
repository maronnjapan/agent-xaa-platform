-- T-SEC-14 / REQ-09-025. A refresh token presented after it was rotated away.
--
-- Agent OP is the only holder of an agent's Human IdP refresh token, so the retired
-- value coming back is evidence of a leak rather than a race. The judgement is made
-- there, inside the rotation transaction, and written as `refresh_reuse_detected` (DEC-SEC-02);
-- this view only extracts what was already decided.
--
-- `refresh_token_reuse` is not one of the sixteen protocol violations — nothing about
-- the request was malformed — so it travels under the extended code, and the six columns
-- match the other saved detections so all of them can be UNION ALL'd into one feed.
WITH audit_logs AS (
  SELECT
    timestamp,
    TO_JSON_STRING(jsonPayload) AS payload
  FROM `${project_id}.security_audit.run_googleapis_com_stdout`
)
SELECT
  timestamp AS occurred_at,
  JSON_VALUE(payload, '$.agent_id') AS agent_id,
  JSON_VALUE(payload, '$.human_subject') AS human_subject,
  JSON_VALUE(payload, '$.trace_id') AS trace_id,
  'refresh_token_reuse' AS detection_code,
  TO_JSON_STRING(STRUCT(
    JSON_VALUE(payload, '$.fields.idp_connection_id') AS idp_connection_id,
    JSON_VALUE(payload, '$.fields.refresh_rotation_result') AS refresh_rotation_result,
    JSON_VALUE(payload, '$.fields.revoke_result') AS revoke_result
  )) AS detail
FROM audit_logs
WHERE JSON_VALUE(payload, '$.log_source') = 'agent_op_idp_connection'
  AND SAFE_CAST(JSON_VALUE(payload, '$.fields.refresh_reuse_detected') AS BOOL) = true
