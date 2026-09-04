-- REQ-09-034. An agent that acted for somebody who did not delegate to it.
--
-- The judgement is not made here. The Agent OP compares `sub` against the registration's
-- `human_subject` synchronously, with the request in front of it, and writes the verdict
-- (DEC-SEC-02). Re-deriving it in SQL would be a second opinion formed from less
-- information, and the two would eventually disagree about the same request.
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
  'delegation_mismatch' AS detection_code,
  TO_JSON_STRING(STRUCT(
    JSON_VALUE(payload, '$.fields.id_jag_sub') AS id_jag_sub,
    JSON_VALUE(payload, '$.fields.registration_human_subject') AS registration_human_subject
  )) AS detail
FROM audit_logs
WHERE JSON_VALUE(payload, '$.log_source') = 'agent_op'
  AND SAFE_CAST(JSON_VALUE(payload, '$.fields.delegation_match') AS BOOL) = false
