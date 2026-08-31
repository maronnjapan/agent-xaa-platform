-- REQ-09-023. One agent reaching another agent's dedicated OP.
--
-- A Dedicated OP is created for exactly one agent, so the agent id injected into it and
-- the agent id the request claims must be the same. Where they differ, an agent has
-- reached across an isolation boundary — and because the OP knows both values at request
-- time, this needs no history table to compare against.
SELECT
  timestamp AS occurred_at,
  jsonPayload.agent_id AS agent_id,
  jsonPayload.human_subject AS human_subject,
  jsonPayload.trace_id AS trace_id,
  'cross_agent_access' AS detection_code,
  TO_JSON_STRING(STRUCT(
    jsonPayload.fields.op_agent_id AS op_agent_id,
    jsonPayload.agent_id AS requested_agent_id
  )) AS detail
FROM `${project_id}.security_audit.run_googleapis_com_stdout`
WHERE jsonPayload.log_source = 'agent_op'
  AND jsonPayload.fields.op_agent_id IS NOT NULL
  AND jsonPayload.fields.op_agent_id != jsonPayload.agent_id
