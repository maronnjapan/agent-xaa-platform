import { expect, it } from 'vitest';
import { BRIDGE_LOG_FIELDS } from '@xaa/google-bridge/src/log/bridge-log';
import { exchangeToken, readyBridge, seedBinding } from '@xaa/google-bridge/src/testing/harness';
import { describeBridge } from '../../support/bridge-enabled.js';

interface Line { event: string; fields: Record<string, unknown> }

/**
 * What an operator has to be able to reconstruct afterwards.
 *
 * docs 09 §2 names seven things per token exchange, and the reason they are all present
 * on a refusal as well as on a success is that the interesting requests are the refused
 * ones. A log that omitted `google_refresh_result` when the request never got that far
 * would look identical, in a query, to a log where the field was lost — and the
 * difference is exactly what someone investigating is trying to establish.
 */
describeBridge('the bridge token log', () => {
  it('writes all seven fields for an issue and for an expiry refusal', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();

    const issued = await exchangeToken(harness, { idJag: await issuer.mint({ dpopKey }), dpopKey });
    expect(issued.status).toBe(200);
    const accessToken = (await issued.json() as { access_token: string }).access_token;

    // The same agent, one expired binding later. Nothing else about the request changes.
    await seedBinding(harness, { expiresAt: '2020-01-01T00:00:00.000Z' });
    const refused = await exchangeToken(harness, { idJag: await issuer.mint({ dpopKey }), dpopKey });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'invalid_grant' });

    const lines = harness.logs
      .map((line) => JSON.parse(line) as Line)
      .filter((entry) => entry.event === 'bridge_token_exchange');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(Object.keys(line.fields).sort()).toEqual([...BRIDGE_LOG_FIELDS].sort());
      for (const value of Object.values(line.fields)) expect(value).not.toBeUndefined();
    }
    expect(lines[0]!.fields.access_token_issue_result).toBe('issued');
    expect(lines[1]!.fields.access_token_issue_result).toBe('denied');
    expect(lines[1]!.fields.agent_expiry_check).toBe('expired_binding');

    // One event for one refusal: a duplicate would make a single expired binding look
    // like a campaign against the platform.
    const expiries = harness.logs
      .map((line) => JSON.parse(line) as { fields: { validation?: string } })
      .filter((entry) => entry.fields.validation === 'expired_bridge_connection');
    expect(expiries).toHaveLength(1);

    // Nowhere in the log, on either request.
    for (const line of harness.logs) expect(line).not.toContain(accessToken);
  });
});
