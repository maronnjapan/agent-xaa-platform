-- REQ-09-020. An ID-JAG the platform's own OP never issued.
--
-- The join starts from the Resource AS, not from the ledger. A redemption with no
-- matching ledger row is exactly the case worth finding — a token signed by something
-- that is not the OP — and starting from the ledger would enumerate only what the OP
-- already knows it issued, which can never contain a forgery.
WITH audit_logs AS (
  SELECT
    timestamp,
    TO_JSON_STRING(jsonPayload) AS payload
  FROM `${project_id}.security_audit.run_googleapis_com_stdout`
)
SELECT
  redeem.timestamp AS occurred_at,
  JSON_VALUE(redeem.payload, '$.agent_id') AS agent_id,
  JSON_VALUE(redeem.payload, '$.human_subject') AS human_subject,
  JSON_VALUE(redeem.payload, '$.trace_id') AS trace_id,
  'signing_key_misuse' AS detection_code,
  TO_JSON_STRING(STRUCT(
    JSON_VALUE(redeem.payload, '$.fields.idjag_jti') AS idjag_jti,
    JSON_VALUE(redeem.payload, '$.fields.received_kid') AS received_kid,
    JSON_VALUE(redeem.payload, '$.fields.received_typ') AS received_typ
  )) AS detail
FROM audit_logs AS redeem
LEFT JOIN `${project_id}.security_audit.id_jag_ledger` AS ledger
  ON ledger.jti = JSON_VALUE(redeem.payload, '$.fields.idjag_jti')
WHERE JSON_VALUE(redeem.payload, '$.log_source') = 'native_resource_as'
  AND (
    ledger.jti IS NULL
    OR JSON_VALUE(redeem.payload, '$.fields.received_typ') != 'oauth-id-jag+jwt'
  )
