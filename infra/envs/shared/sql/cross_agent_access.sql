-- REQ-09-023. One agent reaching another agent's dedicated OP.
--
-- A Dedicated OP is created for exactly one agent, so the agent id injected into it and
-- the agent id the request claims must be the same. Where they differ, an agent has
-- reached across an isolation boundary — and because the OP knows both values at request
-- time, this needs no history table to compare against.
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
  'cross_agent_access' AS detection_code,
  TO_JSON_STRING(STRUCT(
    JSON_VALUE(payload, '$.fields.op_agent_id') AS op_agent_id,
    JSON_VALUE(payload, '$.agent_id') AS requested_agent_id
  )) AS detail
FROM audit_logs
WHERE JSON_VALUE(payload, '$.log_source') = 'agent_op'
  AND JSON_VALUE(payload, '$.fields.op_agent_id') IS NOT NULL
  AND JSON_VALUE(payload, '$.fields.op_agent_id') != JSON_VALUE(payload, '$.agent_id')
