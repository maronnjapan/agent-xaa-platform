-- REQ-09-034. A proof of possession presented twice.
--
-- Two sources, unioned. The first is the refusal the verifier already made: it holds the
-- jti store and knows a replay when it sees one. The second catches the case the first
-- cannot — the same jti accepted by two instances before either recorded it — by looking
-- for duplicates after the fact. Neither alone is enough.
SELECT
  timestamp AS occurred_at,
  jsonPayload.agent_id AS agent_id,
  jsonPayload.human_subject AS human_subject,
  jsonPayload.trace_id AS trace_id,
  'dpop_replay' AS detection_code,
  TO_JSON_STRING(STRUCT(jsonPayload.fields.dpop_jti AS dpop_jti, 'refused' AS source)) AS detail
FROM `${project_id}.security_audit.run_googleapis_com_stdout`
WHERE jsonPayload.fields.dpop_result = 'replayed_dpop_proof'

UNION ALL

SELECT
  MIN(timestamp) AS occurred_at,
  ANY_VALUE(jsonPayload.agent_id) AS agent_id,
  ANY_VALUE(jsonPayload.human_subject) AS human_subject,
  ANY_VALUE(jsonPayload.trace_id) AS trace_id,
  'dpop_replay' AS detection_code,
  TO_JSON_STRING(STRUCT(jsonPayload.fields.dpop_jti AS dpop_jti, 'duplicate' AS source)) AS detail
FROM `${project_id}.security_audit.run_googleapis_com_stdout`
WHERE jsonPayload.fields.dpop_jti IS NOT NULL
GROUP BY jsonPayload.fields.dpop_jti
HAVING COUNT(*) > 1
