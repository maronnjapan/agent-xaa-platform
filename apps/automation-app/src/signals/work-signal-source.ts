/**
 * The six kinds of record the Automation Design AI reads to spot repeated work.
 *
 * They mirror the Document Resource Server's `type` field one-for-one: normalising to
 * a different vocabulary here would create a second naming scheme to keep in step.
 *
 * A SaaS-backed source would implement this same interface. There is deliberately no
 * `saas-source.ts` in the tree — the default profile is `saas_connector_mode=stub`
 * (DEC-SCOPE-04), and an unused implementation would be an untested credential path.
 * The shape it would take:
 *
 *   class SaasWorkSignalSource implements WorkSignalSource {
 *     constructor(connectorId: ConnectorId, bridge: BridgeClient) {}
 *     fetch(params): Promise<WorkSignal[]>
 *   }
 */
export const SIGNAL_KINDS = ['daily_report', 'work_log', 'mail', 'calendar', 'chat', 'task'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface WorkSignal {
  source_kind: SignalKind;
  occurred_at: string;
  human_subject: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
}

export const WORK_SIGNAL_FIELDS = ['source_kind', 'occurred_at', 'human_subject', 'title', 'body', 'metadata'] as const;

export interface WorkSignalSource {
  fetch(params: { humanSubject: string; from: string; to: string }): Promise<WorkSignal[]>;
}

export function isSignalKind(value: unknown): value is SignalKind {
  return typeof value === 'string' && (SIGNAL_KINDS as readonly string[]).includes(value);
}
