import type { DocumentStore } from '@xaa/gcp';
import { JWT_TYP } from '@xaa/contracts';

export const BATCH_STATE_COLLECTION = 'batch_state';
export const BATCH_STATE_ID = 'signing_key_misuse';

/**
 * Ten minutes of history, run every five (T-SEC-15).
 *
 * The overlap is deliberate: a redemption logged a moment before the window boundary
 * would otherwise fall between two runs. Seeing it twice is harmless because the batch
 * remembers which `jti` it has already reported; missing it once is not recoverable.
 */
export const WINDOW_MINUTES = 10;

/** How long a reported `jti` is remembered, comfortably past the window's own overlap. */
export const STATE_RETENTION_MINUTES = 60;

export interface MisuseRow {
  occurred_at: string;
  agent_id: string | null;
  human_subject: string | null;
  trace_id: string;
  received_jti: string;
  received_kid: string | null;
  received_typ: string | null;
  ledger_jti: string | null;
}

export interface RuleHitRow {
  occurred_at: string;
  agent_id: string | null;
  human_subject: string | null;
  trace_id: string;
  detection_code: 'signing_key_misuse';
  level: 'CRITICAL';
  detail: string;
}

export interface BatchDeps {
  query(sql: string, params: { window_start: string; window_end: string }): Promise<MisuseRow[]>;
  insertRuleHits(rows: readonly RuleHitRow[]): Promise<void>;
  documents: DocumentStore;
}

interface BatchState {
  seen?: Array<{ jti: string; at: string }>;
}

/**
 * The reconciliation always starts from the Resource AS.
 *
 * A compromised Agent OP does not write its own forgeries to the ledger, so a join that
 * enumerated the ledger and looked for redemptions could only ever confirm what the OP
 * already admits. Starting from what a Resource AS actually accepted is what makes a
 * forged ID-JAG visible at all — and that is why the left table is a constant rather
 * than a parameter: a query built at run time could be pointed at `agent_op.token_exchange`
 * by a later edit, and the detection would quietly become unable to find anything.
 */
export const REDEEM_SOURCE = { log_source: 'native_resource_as', event: 'resource_as.redeem' } as const;

export function signingKeyMisuseQuery(projectId: string, dataset: string): string {
  return `
SELECT
  redeem.timestamp AS occurred_at,
  redeem.jsonPayload.agent_id AS agent_id,
  redeem.jsonPayload.human_subject AS human_subject,
  redeem.jsonPayload.trace_id AS trace_id,
  redeem.jsonPayload.fields.idjag_jti AS received_jti,
  redeem.jsonPayload.fields.received_kid AS received_kid,
  redeem.jsonPayload.fields.received_typ AS received_typ,
  ledger.jti AS ledger_jti
FROM \`${projectId}.${dataset}.run_googleapis_com_stdout\` AS redeem
LEFT JOIN \`${projectId}.${dataset}.id_jag_ledger\` AS ledger
  ON ledger.jti = redeem.jsonPayload.fields.idjag_jti
WHERE redeem.jsonPayload.log_source = '${REDEEM_SOURCE.log_source}'
  AND redeem.jsonPayload.event = '${REDEEM_SOURCE.event}'
  AND redeem.timestamp >= @window_start
  AND redeem.timestamp < @window_end
  AND (ledger.jti IS NULL OR redeem.jsonPayload.fields.received_typ != '${JWT_TYP.ID_JAG}')
`.trim();
}

/**
 * One pass, from the redemptions back to the ledger.
 *
 * Every row this returns is CRITICAL on its own — a token a Resource AS accepted that the
 * platform's OP has no record of issuing, or one whose `typ` says it is not an ID-JAG at
 * all. There is no accumulation and no threshold, because there is no number of forged
 * tokens below which nothing is wrong.
 *
 * The state document is read and written around the insert rather than inside it: a run
 * that inserted rows and then failed to record them would report the same forgery every
 * five minutes, and a run that recorded them first and then failed would never report it.
 * Recording after the insert is the direction that errs towards a duplicate row rather
 * than towards silence.
 */
export async function runBatch(now: Date, deps: BatchDeps, projectId: string, dataset: string): Promise<RuleHitRow[]> {
  const windowEnd = now.toISOString();
  const windowStart = new Date(now.getTime() - WINDOW_MINUTES * 60_000).toISOString();

  const rows = await deps.query(signingKeyMisuseQuery(projectId, dataset), {
    window_start: windowStart, window_end: windowEnd,
  });

  const state = await deps.documents.get<BatchState>(BATCH_STATE_COLLECTION, BATCH_STATE_ID);
  const seen = new Map((state?.seen ?? []).map((entry) => [entry.jti, entry.at]));

  const fresh = rows.filter((row) => row.received_jti !== '' && !seen.has(row.received_jti));
  const hits = fresh.map(toRuleHit);
  if (hits.length > 0) await deps.insertRuleHits(hits);

  for (const row of fresh) seen.set(row.received_jti, row.occurred_at);
  const cutoff = now.getTime() - STATE_RETENTION_MINUTES * 60_000;
  await deps.documents.set(BATCH_STATE_COLLECTION, BATCH_STATE_ID, {
    seen: [...seen]
      .filter(([, at]) => !Number.isFinite(Date.parse(at)) || Date.parse(at) >= cutoff)
      .map(([jti, at]) => ({ jti, at })),
    updated_at: windowEnd,
  });
  return hits;
}

function toRuleHit(row: MisuseRow): RuleHitRow {
  return {
    occurred_at: row.occurred_at,
    agent_id: row.agent_id,
    human_subject: row.human_subject,
    trace_id: row.trace_id,
    detection_code: 'signing_key_misuse',
    level: 'CRITICAL',
    detail: JSON.stringify({
      received_jti: row.received_jti,
      received_kid: row.received_kid,
      received_typ: row.received_typ,
      ledger_jti: row.ledger_jti,
    }),
  };
}
