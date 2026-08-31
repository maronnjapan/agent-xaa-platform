-- REQ-09-020. An ID-JAG the platform's own OP never issued.
--
-- The join starts from the Resource AS, not from the ledger. A redemption with no
-- matching ledger row is exactly the case worth finding — a token signed by something
-- that is not the OP — and starting from the ledger would enumerate only what the OP
-- already knows it issued, which can never contain a forgery.
SELECT
  redeem.timestamp AS occurred_at,
  redeem.jsonPayload.agent_id AS agent_id,
  redeem.jsonPayload.human_subject AS human_subject,
  redeem.jsonPayload.trace_id AS trace_id,
  'signing_key_misuse' AS detection_code,
  TO_JSON_STRING(STRUCT(
    redeem.jsonPayload.fields.idjag_jti AS idjag_jti,
    redeem.jsonPayload.fields.received_kid AS received_kid,
    redeem.jsonPayload.fields.received_typ AS received_typ
  )) AS detail
FROM `${project_id}.security_audit.run_googleapis_com_stdout` AS redeem
LEFT JOIN `${project_id}.security_audit.id_jag_ledger` AS ledger
  ON ledger.jti = redeem.jsonPayload.fields.idjag_jti
WHERE redeem.jsonPayload.log_source = 'native_resource_as'
  AND (ledger.jti IS NULL OR redeem.jsonPayload.fields.received_typ != 'oauth-id-jag+jwt')
