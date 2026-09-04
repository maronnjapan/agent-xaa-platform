-- REQ-09-034. A proof of possession presented twice.
--
-- Two sources, unioned. The first is the refusal the verifier already made: it holds the
-- jti store and knows a replay when it sees one. The second catches the case the first
-- cannot — the same jti accepted by two instances before either recorded it — by looking
-- for duplicates after the fact. Neither alone is enough.
WITH audit_logs AS (
  SELECT
    timestamp,
    TO_JSON_STRING(jsonPayload) AS payload
  FROM `${project_id}.security_audit.run_googleapis_com_stdout`
),
dpop_logs AS (
  SELECT
    timestamp,
    JSON_VALUE(payload, '$.agent_id') AS agent_id,
    JSON_VALUE(payload, '$.human_subject') AS human_subject,
    JSON_VALUE(payload, '$.trace_id') AS trace_id,
    JSON_VALUE(payload, '$.fields.dpop_jti') AS dpop_jti,
    JSON_VALUE(payload, '$.fields.dpop_result') AS dpop_result
  FROM audit_logs
)
SELECT
  timestamp AS occurred_at,
  agent_id AS agent_id,
  human_subject AS human_subject,
  trace_id AS trace_id,
  'dpop_replay' AS detection_code,
  TO_JSON_STRING(STRUCT(
    dpop_jti AS dpop_jti,
    'refused' AS source
  )) AS detail
FROM dpop_logs
WHERE dpop_result = 'replayed_dpop_proof'

UNION ALL

SELECT
  MIN(timestamp) AS occurred_at,
  ANY_VALUE(agent_id) AS agent_id,
  ANY_VALUE(human_subject) AS human_subject,
  ANY_VALUE(trace_id) AS trace_id,
  'dpop_replay' AS detection_code,
  TO_JSON_STRING(STRUCT(
    dpop_jti AS dpop_jti,
    'duplicate' AS source
  )) AS detail
FROM dpop_logs
WHERE dpop_jti IS NOT NULL
GROUP BY dpop_jti
HAVING COUNT(*) > 1
