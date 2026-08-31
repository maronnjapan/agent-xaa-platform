import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VIOLATION_MESSAGES } from '@xaa/contracts';
import {
  ACTIVITY_TOPIC, AGENT_OP_VIOLATION_CODES, emitProtocolViolationEvent, type ActivityEvent,
} from '../src/log/protocol-violation-event.js';

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
});
