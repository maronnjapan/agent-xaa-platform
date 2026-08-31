export const CLEANUP_STEP_IDS = [
  'runtime_cancel',
  'issuance_disable',
  'idp_connection_revoke',
  'bridge_binding_disable',
  'credential_revoke',
  'client_credential_revoke',
  'runtime_state_delete',
  'dedicated_destroy',
  'dedicated_sa_delete',
  'registration_delete',
  'audit_persist',
] as const;

export type CleanupStepId = (typeof CLEANUP_STEP_IDS)[number];
export type CleanupStepStatus = 'succeeded' | 'failed' | 'skipped';

export interface CleanupStepResult {
  step: CleanupStepId;
  status: CleanupStepStatus;
  attempts: number;
  last_error_code: string | null;
  updated_at: string;
}

export interface CleanupOutcome {
  agent_id: string;
  reason: string;
  status: 'REVOKED' | 'DESTROYED';
  results: CleanupStepResult[];
}

export function mergeResult(
  existing: readonly CleanupStepResult[],
  next: CleanupStepResult,
): CleanupStepResult[] {
  const merged = existing.filter((entry) => entry.step !== next.step);
  return [...merged, next];
}

export function isDone(result: CleanupStepResult | undefined): boolean {
  return result?.status === 'succeeded' || result?.status === 'skipped';
}
