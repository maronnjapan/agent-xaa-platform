export const AGENT_ID_PATTERN = /^agent-[0-9a-z]{26}$/;

export function isAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID_PATTERN.test(value);
}

export function assertAgentId(value: string): void {
  if (!isAgentId(value)) throw new Error(`invalid agent_id: ${value}`);
}
