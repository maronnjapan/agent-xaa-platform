import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDpopProof } from '@xaa/crypto';
import { CLIENT_ASSERTION_TYPE, VIOLATION_MESSAGES } from '@xaa/contracts';
import {
  ACTIVITY_TOPIC, AGENT_OP_VIOLATION_CODES, emitProtocolViolationEvent, type ActivityEvent,
} from '../src/log/protocol-violation-event.js';
import { AGENT_OP_BASE, clientAssertion, createFixture, fakeEnvelope } from './helpers.js';

function collector() {
  const events: Array<{ topic: string; event: ActivityEvent }> = [];
  return { events, publisher: { async publish(topic: string, event: ActivityEvent) { events.push({ topic, event }); } } };
}

describe('PROTOCOL_VIOLATION activity events', () => {
  it('emits one event per violation, on the activity topic', async () => {
    const { events, publisher } = collector();
    await emitProtocolViolationEvent(publisher, { violation_code: 'delegation_mismatch', agent_id: 'agent-a', human_subject: 'user-1' });
    expect(events).toHaveLength(1);
    expect(events[0]!.topic).toBe(ACTIVITY_TOPIC);
    expect(events[0]!.event.event_type).toBe('PROTOCOL_VIOLATION');
  });

  it('fixes phase to security and outcome to blocked', async () => {
    const { events, publisher } = collector();
    for (const code of AGENT_OP_VIOLATION_CODES) {
      await emitProtocolViolationEvent(publisher, { violation_code: code, agent_id: 'agent-a', human_subject: null });
    }
    expect(events.every(({ event }) => event.phase === 'security' && event.outcome === 'blocked')).toBe(true);
  });

  it('phase and outcome are not parameterizable', async () => {
    const { publisher } = collector();
    // @ts-expect-error phase is a constant of this event, not an input
    await emitProtocolViolationEvent(publisher, { violation_code: 'delegation_mismatch', agent_id: null, human_subject: null, phase: 'tool_call' });
    // @ts-expect-error scripted demos never reach this path, so there is no is_simulated
    await emitProtocolViolationEvent(publisher, { violation_code: 'delegation_mismatch', agent_id: null, human_subject: null, is_simulated: true });
  });

  it('detail.violation_code is one of the enumerated codes and carries a message', async () => {
    const { events, publisher } = collector();
    for (const code of AGENT_OP_VIOLATION_CODES) {
      await emitProtocolViolationEvent(publisher, { violation_code: code, agent_id: 'agent-a', human_subject: null });
    }
    for (const { event } of events) {
      expect(AGENT_OP_VIOLATION_CODES).toContain(event.detail.violation_code);
      expect(event.message).toBe(VIOLATION_MESSAGES[event.detail.violation_code]);
    }
  });

  it('carries no token material in the detail', async () => {
    const { events, publisher } = collector();
    await emitProtocolViolationEvent(publisher, { violation_code: 'invalid_dpop_proof', agent_id: 'agent-a', human_subject: 'user-1' });
    expect(Object.keys(events[0]!.event.detail)).toEqual(['violation_code']);
  });

  it('names the activity topic in exactly one module', async () => {
    const root = new URL('../src', import.meta.url).pathname;
    const files: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (entry.name.endsWith('.ts') && (await readFile(full, 'utf8')).includes('agent-activity-stream')) files.push(entry.name);
      }
    };
    await walk(root);
    expect(files).toEqual(['protocol-violation-event.ts']);
  });

  /**
   * Activity Events come from Agent OP, the Tool Executor and the Native Resource AS
   * only. A credential Human IdP refuses is that service's business: it writes a
   * Security log, and Agent OP raises nothing unless one of its own six codes fires.
   */
  it('human-idp authentication failure emits no Activity Event', async () => {
    const fixture = await createFixture();
    await fixture.documents.set('idp_connections', fixture.registration.idp_connection_id, {
      idp_connection_id: fixture.registration.idp_connection_id,
      agent_id: fixture.agentId,
      human_subject: fixture.registration.human_subject,
      encrypted_refresh_token: await fakeEnvelope.encrypt('rt-original', fixture.agentId),
      granted_scopes: ['openid', 'offline_access'],
      status: 'ACTIVE',
      created_at: new Date(fixture.now()).toISOString(),
      expires_at: new Date(fixture.now() + 86_400_000).toISOString(),
    });
    // Human IdP rejects the credential; the token was never rotated away, so this is
    // an ordinary authentication failure rather than a reuse.
    fixture.humanIdpResponses.push(Response.json({ error: 'invalid_grant' }, { status: 400 }));

    const path = '/xaa/subject-token';
    const response = await fixture.fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        DPoP: await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}${path}`, keyPair: fixture.dpopKeyPair, now: fixture.now }),
      },
      body: new URLSearchParams({
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await clientAssertion(fixture, { path }),
      }).toString(),
    });
    expect(response.status).toBe(400);
    expect(fixture.events).toEqual([]);
  });
});
