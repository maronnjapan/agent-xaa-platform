import { describe, expect, it } from 'vitest';
import {
  STUB_CONNECTOR, completeConsent, createBridgeHarness, createIdJagIssuer, exchangeToken,
  readyBridge, seedConnector, transactionReader,
} from '../src/testing/harness.js';

interface Line { event: string; fields: Record<string, unknown> }

const parsed = (logs: string[]): Line[] => logs.map((line) => JSON.parse(line) as Line);

/**
 * What the Bridge writes down, and what it must never write down.
 *
 * docs 09 §2 asks for seven things per exchange. The risk in a log like this is not the
 * missing field — that shows up as an empty column — but the extra one: an access token
 * or a client secret in a log sink is a credential in a place nobody guards as one, kept
 * for as long as the retention policy says. The allow list is what makes that
 * impossible rather than merely discouraged.
 */
describe('the bridge token log', () => {
  it('never carries the access token it just issued', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    const response = await exchangeToken(harness, { idJag: await issuer.mint({ dpopKey }), dpopKey });
    const token = (await response.json() as { access_token: string }).access_token;
    expect(token.length).toBeGreaterThan(20);

    // Not one line, anywhere: the value the agent received is the value an attacker
    // reading the log would be able to replay against the SaaS.
    for (const line of harness.logs) expect(line).not.toContain(token);
  });

  it('says which stage a refusal stopped at rather than omitting the field', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    await exchangeToken(harness, { idJag: await issuer.mint({ dpopKey, typ: 'at+jwt' }), dpopKey });
    const line = parsed(harness.logs).find((entry) => entry.event === 'bridge_token_exchange')!;
    // `skipped` is a fact about the request; a missing key is a question about the log.
    expect(line.fields.connection_id).toBe('skipped');
    expect(line.fields.google_refresh_result).toBe('skipped');
    expect(line.fields.access_token_issue_result).toBe('denied');
  });

  it('keeps state and code out of the callback face log', async () => {
    const issuer = await createIdJagIssuer();
    const harness = createBridgeHarness({ jwks: issuer.jwks, readTransaction: transactionReader() });
    await seedConnector(harness);
    const { code } = await completeConsent(harness);

    const lines = parsed(harness.logs).filter((entry) => entry.event === 'bridge_consent_callback');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Only what happened and to which transaction. The state and the one-time code
      // are single-use secrets that a log would turn into reusable ones.
      expect(Object.keys(line.fields).sort()).toEqual(['connector_id', 'result', 'transaction_id']);
      expect(line.fields.connector_id).toBe(STUB_CONNECTOR.connector_id);
    }
    for (const raw of harness.logs) expect(raw).not.toContain(code);
  });
});
