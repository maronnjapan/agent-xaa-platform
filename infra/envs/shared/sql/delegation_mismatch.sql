-- REQ-09-034. An agent that acted for somebody who did not delegate to it.
--
-- The judgement is not made here. The Agent OP compares `sub` against the registration's
-- `human_subject` synchronously, with the request in front of it, and writes the verdict
-- (DEC-SEC-02). Re-deriving it in SQL would be a second opinion formed from less
-- information, and the two would eventually disagree about the same request.
SELECT
  timestamp AS occurred_at,
  jsonPayload.agent_id AS agent_id,
  jsonPayload.human_subject AS human_subject,
  jsonPayload.trace_id AS trace_id,
  'delegation_mismatch' AS detection_code,
  TO_JSON_STRING(STRUCT(
    jsonPayload.fields.idjag_sub AS idjag_sub,
    jsonPayload.fields.registration_human_subject AS registration_human_subject
  )) AS detail
FROM `${project_id}.security_audit.run_googleapis_com_stdout`
WHERE jsonPayload.log_source = 'agent_op'
  AND jsonPayload.fields.delegation_match = false
