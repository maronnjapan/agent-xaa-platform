import matrix from './access-matrix.json' with { type: 'json' };

export type FirestoreAccessMode = 'read' | 'write' | 'delete';

export class FirestoreGuardError extends Error {
  /** The one refusal this guard can make; callers and logs name it by this code. */
  readonly code = 'path_not_allowed';

  constructor(public readonly app: string, public readonly mode: FirestoreAccessMode, public readonly path: string) {
    super(`Firestore access denied: ${app} ${mode} ${path}`);
    this.name = 'FirestoreGuardError';
  }
}

function matches(pattern: string, path: string): boolean {
  const expected = pattern.split('/').filter(Boolean);
  const actual = path.split('/').filter(Boolean);
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] === '**') return true;
    if (actual[index] === undefined) return false;
    if (expected[index] !== '*' && expected[index] !== actual[index]) return false;
  }
  return actual.length === expected.length;
}

export function assertPath(app: string, mode: FirestoreAccessMode, path: string): void {
  const entry = (matrix as Record<string, { read?: string[]; write?: string[] }>)[app];
  const effectiveMode = mode === 'delete' ? 'write' : mode;
  if (!entry?.[effectiveMode]?.some((pattern) => matches(pattern, path))) throw new FirestoreGuardError(app, mode, path);
}

export function assertAgentOwnership(ownAgentId: string, agentId: string): void {
  if (ownAgentId !== agentId) throw new FirestoreGuardError('agent-runtime', 'read', `agents/${agentId}`);
}
