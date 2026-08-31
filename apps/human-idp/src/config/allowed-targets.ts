/**
 * REQ-05-003. The audience a client may request is fixed per client. The list is
 * never echoed in discovery or in an error body, so a caller cannot enumerate it.
 */
export const ALLOWED_TARGETS: Readonly<Record<string, readonly string[]>> = {
  'automation-app': ['authorization-platform', 'agent-provisioner', 'lifecycle-manager', 'automation-app'],
  'agent-platform': [],
};

export const INVALID_TARGET_DESCRIPTION = 'The requested audience is not allowed for this client';

/** True when the parsed `audience` parameter is acceptable for this client. */
export function isAllowedTarget(clientId: string, audience: string[] | undefined): boolean {
  if (audience === undefined) return true;
  if (audience.length !== 1) return false;
  return (ALLOWED_TARGETS[clientId] ?? []).includes(audience[0]!);
}
