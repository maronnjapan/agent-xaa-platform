import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { JWT_TYP } from '@xaa/contracts';
import {
  runBatch, signingKeyMisuseQuery, type BatchDeps, type MisuseRow, type RuleHitRow,
} from '@xaa/security-detection/src/batch/signing-key-misuse';

const sqlDir = new URL('../../infra/envs/shared/sql/', import.meta.url).pathname;

/** The six columns every saved detection returns, in this order (T-SEC-09). */
const FIXED_COLUMNS = ['occurred_at', 'agent_id', 'human_subject', 'trace_id', 'detection_code', 'detail'];

/**
 * The top-level `AS <name>` aliases of a view, in the order the SELECT lists them.
 *
 * Aliases inside the `STRUCT(...)` that builds `detail` are indented, so anchoring on
 * the two-space prefix keeps them out without parsing SQL.
 */
function projectedColumns(sql: string): string[] {
  const named = [...sql.matchAll(/^ {2}\S.*? AS (\w+),?$/gm)].map((match) => match[1]!);
  return named.filter((name, index) => named.indexOf(name) === index);
}

/**
 * T-SEC-09 / T-SEC-14. The saved detections, as SQL that can be reviewed without a
 * deployment.
 *
 * Whether BigQuery accepts them is a live check (`bq query`), and the deploy guide runs
 * it. What is fixed here is the part a project cannot tell you: that all of them agree
 * on their shape, so the set can be UNION ALL'd into one feed, and that the ledger
 * reconciliation starts from the side that can actually see a forgery.
 */
describe('the saved detections', () => {
  it('each view returns the six fixed columns', async () => {
    const files = (await readdir(sqlDir)).filter((name) => name.endsWith('.sql')).sort();
    expect(files).toHaveLength(5);

    for (const file of files) {
      const sql = await readFile(`${sqlDir}${file}`, 'utf8');
      expect(projectedColumns(sql), file).toEqual(FIXED_COLUMNS);
      // A view whose columns follow a table's is a detection that changes shape when
      // somebody adds a field.
      expect(sql, file).not.toMatch(/SELECT \*/);
      expect(sql, file).toContain('${project_id}');
    }
  });

  it('signing key misuse joins from resource as side', async () => {
    const sql = signingKeyMisuseQuery('demo-project', 'security_audit');
    // Left table: what a Resource AS redeemed. Right table: what the OP recorded issuing.
    expect(sql.indexOf('FROM `demo-project.security_audit.run_googleapis_com_stdout` AS redeem'))
      .toBeLessThan(sql.indexOf('LEFT JOIN `demo-project.security_audit.id_jag_ledger` AS ledger'));
    expect(sql).toContain("log_source = 'native_resource_as'");
    // A join enumerating the ledger could only ever confirm what the OP already admits.
    expect(sql).not.toContain('agent_op.token_exchange');

    // A redemption the ledger has no row for: exactly one detection, at CRITICAL.
    const inserted: RuleHitRow[] = [];
    const deps: BatchDeps = {
      documents: createFirestoreDocumentStore(createFirestoreDouble(), 'security-detection'),
      query: async () => [unrecorded()],
      insertRuleHits: async (rows) => { inserted.push(...rows); },
    };
    const hits = await runBatch(new Date('2026-01-01T12:00:00.000Z'), deps, 'demo-project', 'security_audit');

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ detection_code: 'signing_key_misuse', level: 'CRITICAL' });
    expect(inserted).toHaveLength(1);
    expect(JSON.parse(hits[0]!.detail)).toMatchObject({ received_jti: 'jti-forged', ledger_jti: null });
  });

  it('the reconciliation reads the field names the Resource AS actually writes', async () => {
    const sql = await readFile(`${sqlDir}signing_key_misuse.sql`, 'utf8');
    // `received_kid` and `received_typ` are what `logIdJagRedemption` emits (T-SEC-05);
    // reading a name nothing writes makes the detection silently always empty.
    for (const field of ['received_kid', 'received_typ', 'idjag_jti']) {
      expect(sql, field).toContain(`jsonPayload.fields.${field}`);
    }
  });
});

function unrecorded(): MisuseRow {
  return {
    occurred_at: '2026-01-01T11:55:00.000Z',
    agent_id: 'agent-abcdefghijklmnopqrstuvwxyz',
    human_subject: 'testuser',
    trace_id: 'trace-1',
    received_jti: 'jti-forged',
    received_kid: 'idjag-abcdefghijkl-1',
    received_typ: JWT_TYP.ID_JAG,
    ledger_jti: null,
  };
}
