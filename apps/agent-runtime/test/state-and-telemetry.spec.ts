import { describe, expect, it, beforeEach } from 'vitest';
import { drainActivityQueueForTesting, resetActivityPublisherForTesting } from '@xaa/contracts';
import { createLogger } from '@xaa/logging';
import { CheckpointSecretError, sanitizeCheckpoint } from '../src/state/sanitize.js';
import { writeCheckpoint, type Checkpoint } from '../src/state/checkpoint.js';
import { STAGES, createStageLogger } from '../src/telemetry/stage-log.js';
import { emitUnauthorizedTool } from '../src/telemetry/protocol-validation.js';
import { effectiveCapabilities, publishTaskOutcome, publishToolBlocked, publishToolSucceeded } from '../src/telemetry/activity.js';
import { createTerminalEmitter, decideTaskOutcome } from '../src/telemetry/task-outcome.js';
import { appendRejection } from '../src/instructions/record-rejection.js';
import type { ToolResult } from '../src/tool-executor/errors.js';
import { AGENT_ID, docsManifest, logContext, memoryStore, silentLogger, testContext } from './helpers.js';

const JWT_ANYWHERE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;

function baseCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    task_context: { task_id: 'task-1' },
    conversation_context: [],
    execution_state: {},
    pending_tool_calls: [],
    agent_status: 'ACTIVE',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('the checkpoint sanitiser', () => {
  it('throws on private key material', async () => {
    const context = await testContext();
    const warn = () => {};
    expect(() => sanitizeCheckpoint({ execution_state: { key: context.dpop.privateKey } }, warn)).toThrow(CheckpointSecretError);
    expect(() => sanitizeCheckpoint({ execution_state: { jwk: { kty: 'EC', d: 'secret' } } }, warn)).toThrow(CheckpointSecretError);
    expect(() => sanitizeCheckpoint({ execution_state: { client: context.agentClientKey } }, warn)).toThrow(CheckpointSecretError);
  });

  it('drops jwt-shaped values and warns', () => {
    const removed: string[][] = [];
    const output = sanitizeCheckpoint(
      { execution_state: { note: 'fine', leaked: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.signature' } },
      (event) => removed.push(event.removed_keys),
    );
    expect(JSON.stringify(output)).not.toMatch(JWT_ANYWHERE);
    expect(removed).toEqual([['leaked']]);
    expect(output).toEqual({ execution_state: { note: 'fine' } });
  });

  it('drops a denied key even when its value looks harmless', () => {
    const removed: string[][] = [];
    sanitizeCheckpoint({ access_token: 'short', id_jag: 'x' }, (event) => removed.push(event.removed_keys));
    expect(removed[0]!.sort()).toEqual(['access_token', 'id_jag']);
  });

  it('rejects an unknown top-level key', async () => {
    const { store } = memoryStore();
    const invalid = { ...baseCheckpoint(), scratch: 1 } as unknown as Checkpoint;
    await expect(writeCheckpoint(store, invalid, silentLogger, logContext)).rejects.toThrow();
  });

  it('writes nothing that matches the jwt shape', async () => {
    const { store, documents } = memoryStore();
    await writeCheckpoint(store, baseCheckpoint({
      conversation_context: [{ role: 'tool', result: { token: 'eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ.sig' } }],
    }), silentLogger, logContext);
    const written = await documents.get('agents', `${AGENT_ID}__state`);
    expect(JSON.stringify(written)).not.toMatch(JWT_ANYWHERE);
  });
});

describe('the stage log', () => {
  it('emits stages in the fixed order', () => {
    const lines: string[] = [];
    const logger = createStageLogger({
      executionId: 'e', agentId: AGENT_ID, taskId: 'task-1',
      createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z',
      write: (line) => lines.push(line),
    });
    for (const stage of STAGES) logger.emit(stage, { tool_id: 'internal.document.list' });
    expect(lines.map((line) => JSON.parse(line).stage)).toEqual([...STAGES]);
    expect(STAGES).toHaveLength(9);
  });

  it('every line carries the runtime fields and one span id', () => {
    const lines: string[] = [];
    const logger = createStageLogger({
      executionId: 'e', agentId: AGENT_ID, taskId: 'task-1',
      createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z',
      write: (line) => lines.push(line),
    });
    logger.emit('agent_intent', {});
    logger.emit('resource_api', { outcome: 'success' });
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const line of parsed) {
      expect(Object.keys(line).sort()).toEqual([
        'agent_age_seconds', 'agent_id', 'audience', 'execution_id', 'expires_at', 'latency_ms',
        'operation', 'outcome', 'required_capability', 'resource', 'scope', 'span_id', 'stage', 'task_id', 'tool_id',
      ]);
    }
    expect(new Set(parsed.map((line) => line.span_id)).size).toBe(1);
  });

  it('agent_age_seconds increases across three tool calls', () => {
    const lines: string[] = [];
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const logger = createStageLogger({
      executionId: 'e', agentId: AGENT_ID, taskId: 'task-1',
      createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z',
      now: () => clock, write: (line) => lines.push(line),
    });
    for (let index = 0; index < 3; index += 1) { logger.emit('agent_intent', {}); clock += 5000; }
    expect(lines.map((line) => JSON.parse(line).agent_age_seconds)).toEqual([0, 5, 10]);
  });

  it('drops a token-shaped value and says so', () => {
    const lines: string[] = [];
    const logger = createStageLogger({
      executionId: 'e', agentId: AGENT_ID, taskId: 'task-1',
      createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z',
      write: (line) => lines.push(line),
    });
    logger.emit('access_token', { operation: 'eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ.sig' });
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.log_sanitized).toBe(true);
    expect(lines[0]).not.toMatch(JWT_ANYWHERE);
  });

  it('defines no field named token, assertion or proof', () => {
    const lines: string[] = [];
    const logger = createStageLogger({
      executionId: 'e', agentId: AGENT_ID, taskId: 'task-1',
      createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z',
      write: (line) => lines.push(line),
    });
    logger.emit('id_jag', {});
    const keys = Object.keys(JSON.parse(lines[0]!) as object);
    for (const forbidden of ['token', 'assertion', 'proof']) expect(keys).not.toContain(forbidden);
  });
});

describe('activity events', () => {
  beforeEach(() => resetActivityPublisherForTesting());

  const activityContext = {
    humanSubject: 'testuser', agentId: AGENT_ID, taskId: 'task-1', traceId: 'trace-1', manifest: docsManifest(),
  };

  it('TOOL_BLOCKED matches the docs yaml key set', async () => {
    await publishToolBlocked({
      context: activityContext, toolId: 'internal.finance.payment.approve',
      reason: 'not_in_allowed_tools', logger: silentLogger, ctx: logContext,
    });
    const [event] = drainActivityQueueForTesting();
    expect(Object.keys(event!).sort()).toEqual([
      'agent_id', 'detail', 'event_id', 'human_subject', 'is_simulated', 'message',
      'occurred_at', 'outcome', 'phase', 'related_finding_id', 'source', 'task_id', 'title', 'trace_id',
    ]);
    expect(event).toMatchObject({ phase: 'tool_call', outcome: 'blocked', source: 'agent-runtime' });
    expect(event!.detail).toMatchObject({
      event_type: 'TOOL_BLOCKED',
      tool_id: 'internal.finance.payment.approve',
      effective_capabilities: ['document.read'],
      reason: 'not_in_allowed_tools',
    });
  });

  it('emits one TOOL_BLOCKED and one unauthorized_tool per rejection', async () => {
    const lines: string[] = [];
    const logger = createLogger('agent-runtime', 'agent_runtime', (line) => lines.push(line));
    await publishToolBlocked({
      context: activityContext, toolId: 'internal.finance.payment.approve',
      reason: 'not_in_allowed_tools', logger, ctx: logContext,
    });
    emitUnauthorizedTool(logger, logContext, { tool_id: 'internal.finance.payment.approve', reason: 'not_in_allowed_tools' });
    expect(drainActivityQueueForTesting()).toHaveLength(1);
    const validations = lines.map((line) => JSON.parse(line) as { fields: { validation?: string } })
      .filter((entry) => entry.fields.validation === 'unauthorized_tool');
    expect(validations).toHaveLength(1);
  });

  it('is_simulated cannot be set to true', async () => {
    await publishToolSucceeded({ context: activityContext, toolId: 'internal.document.list', logger: silentLogger, ctx: logContext });
    const [event] = drainActivityQueueForTesting();
    expect(event!.is_simulated).toBe(false);
    // The emitters take no such parameter, so a caller has nowhere to pass one.
    expect(publishToolSucceeded.length).toBe(1);
  });

  it('carries a Japanese title and message', async () => {
    await publishToolBlocked({
      context: activityContext, toolId: 'internal.finance.payment.approve',
      reason: 'not_in_allowed_tools', logger: silentLogger, ctx: logContext,
    });
    const [event] = drainActivityQueueForTesting();
    expect(event!.title).toBe('権限外の操作を拒否しました');
    expect(event!.message).toContain('internal.finance.payment.approve');
  });

  it('publish failure does not fail the tool call', async () => {
    process.env.PUBSUB_MODE = 'gcp';
    const lines: string[] = [];
    const logger = createLogger('agent-runtime', 'agent_runtime', (line) => lines.push(line));
    await expect(publishToolSucceeded({
      context: activityContext, toolId: 'internal.document.list', logger, ctx: logContext,
    })).resolves.toBeUndefined();
    delete process.env.PUBSUB_MODE;
    expect(lines.some((line) => line.includes('activity_publish_failed'))).toBe(true);
  });

  it('reads effective capabilities off the manifest', () => {
    expect(effectiveCapabilities(docsManifest())).toEqual(['document.read']);
  });
});

describe('the terminal event', () => {
  const success: ToolResult = { outcome: 'success', tool_id: 't', stage: 'resource_api', data: {} };
  const blocked: ToolResult = { outcome: 'blocked', reason: 'not_in_allowed_tools', error_code: 'tool_not_allowed', tool_id: 't', stage: 'tool_selection' };
  const failed: ToolResult = { outcome: 'failed', reason: 'agent_op_error', error_code: 'agent_op_error', tool_id: 't', stage: 'agent_op' };

  it('all success maps to TASK_COMPLETED', () => {
    expect(decideTaskOutcome([success, success])).toBe('TASK_COMPLETED');
    expect(decideTaskOutcome([])).toBe('TASK_COMPLETED');
  });

  it('one blocked among successes maps to TASK_BLOCKED', () => {
    expect(decideTaskOutcome([success, blocked, success])).toBe('TASK_BLOCKED');
  });

  it('blocked wins over failed', () => {
    expect(decideTaskOutcome([failed, blocked])).toBe('TASK_BLOCKED');
    expect(decideTaskOutcome([failed, success])).toBe('TASK_FAILED');
  });

  it('emits exactly one terminal event even on throw', async () => {
    resetActivityPublisherForTesting();
    const activityContext = { humanSubject: 'testuser', agentId: AGENT_ID, taskId: 'task-1', traceId: 'trace-1', manifest: docsManifest() };
    const terminal = createTerminalEmitter(async (outcome) => {
      await publishTaskOutcome({ context: activityContext, eventType: outcome, logger: silentLogger, ctx: logContext });
    });
    try {
      await terminal.emitTerminalOnce('TASK_COMPLETED');
      throw new Error('boom');
    } catch {
      await terminal.emitTerminalOnce('TASK_FAILED');
    } finally {
      await terminal.emitTerminalOnce('TASK_FAILED');
    }
    const events = drainActivityQueueForTesting();
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ event_type: 'TASK_COMPLETED' });
    expect(terminal.emitted()).toBe(true);
  });
});

describe('a rejected instruction', () => {
  it('appends without overwriting', () => {
    const first = appendRejection({}, { instruction_id: 'i1', requested_tool_id: 't1', reason: 'not_in_allowed_tools', rejected_at: 'now' });
    const second = appendRejection(first, { instruction_id: 'i2', requested_tool_id: 't2', reason: 'not_in_allowed_tools', rejected_at: 'later' });
    expect(second.rejected_instruction).toHaveLength(2);
  });
});
