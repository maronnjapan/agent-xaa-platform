import type { ToolDefinition } from '../../manifest/load.js';
import type { ToolBlocked } from '../errors.js';

export const KNOWN_CONSTRAINTS = ['max_amount', 'recipient_domain_allowlist'] as const;

function blocked(toolId: string, constraint: string): ToolBlocked {
  return {
    outcome: 'blocked',
    reason: 'constraint_violation',
    error_code: 'constraint_violation',
    tool_id: toolId,
    stage: 'auth_mapping',
    constraint,
  };
}

/**
 * step5.5, checked here even though the Resource API checks it too.
 *
 * The duplication is deliberate (specs 5.2). The resource enforces the limit that
 * protects the resource; this enforces the limit the human agreed to, and it does so
 * before a request leaves the process — so an over-limit approval never appears in the
 * resource's logs at all, not even as a rejected attempt.
 *
 * An unrecognised constraint key fails closed. A limit the executor does not
 * understand is a limit it cannot honour, and silently ignoring it would turn a
 * narrowed permission into a full one.
 */
export function verifyConstraints(
  tool: ToolDefinition,
  parameters: Record<string, unknown>,
): ToolBlocked | null {
  const constraints = tool.constraints;
  for (const [key, value] of Object.entries(constraints)) {
    if (!(KNOWN_CONSTRAINTS as readonly string[]).includes(key)) return blocked(tool.tool_id, key);
    if (key === 'max_amount') {
      const amount = parameters.amount;
      if (typeof amount !== 'number' || !Number.isInteger(amount)) return blocked(tool.tool_id, key);
      // Equal to the limit is within it: the human approved "up to this much".
      if (amount > Number(value)) return blocked(tool.tool_id, key);
    }
    if (key === 'recipient_domain_allowlist') {
      const allowed = Array.isArray(value) ? value.map((entry) => String(entry).toLowerCase()) : [];
      const recipients = Array.isArray(parameters.to) ? parameters.to : [parameters.to];
      for (const recipient of recipients) {
        if (typeof recipient !== 'string' || !recipient.includes('@')) return blocked(tool.tool_id, key);
        // Exact match on the domain. A suffix test would let `evil-example.com`
        // through an allow list naming `example.com`.
        const domain = recipient.slice(recipient.lastIndexOf('@') + 1).toLowerCase();
        if (!allowed.includes(domain)) return blocked(tool.tool_id, key);
      }
    }
  }
  return null;
}
